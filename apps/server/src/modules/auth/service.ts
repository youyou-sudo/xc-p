import type { Db } from '../../core/db'
import type { EventBus } from '../../core/events'
import type { SettingsStore } from '../../core/settings'
import { generateApiKey, hashApiKeySecret, hashAdminPassword, safeEqual, sha256Hex, verifyAdminPassword } from '../../core/crypto'
import { DEFAULT_ADMIN_PASSWORD } from '../../config'
import { logger } from '../../core/log'
import { randomId } from '../../core/ids'

export type Scope = 'read' | 'credentials' | 'sync:run' | 'detect:run' | 'publish:run' | 'admin'

export const ALL_SCOPES: Scope[] = ['read', 'credentials', 'sync:run', 'detect:run', 'publish:run', 'admin']

export interface SessionPrincipal {
  kind: 'session'
  id: string
  username: string
}

export interface ApiKeyPrincipal {
  kind: 'apikey'
  id: string
  name: string
  scopes: Scope[]
}


export interface AuthDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
}

/** 面板会话（Cookie）+ 服务 API Key（Bearer），两者完全分离（PANEL.md D4 / §10.4） */
export class AuthService {
  private rateBuckets = new Map<string, { window: number; count: number }>()

  constructor(private deps: AuthDeps) {}

  async bootstrapAdmin(username: string, password: string): Promise<void> {
    const existing = this.deps.db.get<{ id: number }>('SELECT id, username FROM admin LIMIT 1')
    if (existing) {
      // 已初始化过。这里有两种最容易把人锁在门外的情形，必须显式说清楚：
      //  1) 仍在使用内置默认口令；
      //  2) 设置了 ADMIN_PASSWORD，但因为账号已存在而**根本没生效**（管理员只在首次创建时初始化）。
      // 两条告警互相独立，可能同时成立（例如：库还是默认口令，同时 .env 里又设了 ADMIN_PASSWORD）
      if (await this.isUsingPassword(existing.id, DEFAULT_ADMIN_PASSWORD)) {
        this.deps.events.warn('admin.default_password', '面板仍在使用默认口令，请尽快修改（面板「系统设置 → 管理员口令」，或 bun run admin:password <新口令>）')
        logger.warn('管理员口令仍是内置默认值「' + DEFAULT_ADMIN_PASSWORD + '」，请尽快修改。')
      }
      if (!(await this.isUsingPassword(existing.id, password))) {
        this.deps.events.warn('admin.env_password_ignored', 'ADMIN_PASSWORD 与库中口令不一致，已忽略（账号只在首次创建时初始化）')
        logger.warn(
          '检测到 ADMIN_PASSWORD 与当前口令不一致，已忽略：管理员账号只在数据库为空时初始化一次。\n' +
            '  → 想改用该口令：bun run admin:password "<你的口令>"\n' +
            '  → 或删除 DATA_DIR（默认 ./data）后重新启动，让 ADMIN_PASSWORD 生效',
        )
      }
      return
    }
    const hash = await hashAdminPassword(password)
    this.deps.db.run('INSERT INTO admin (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)', [username, hash, Date.now()])
    this.deps.events.info('admin.bootstrap', '已初始化管理员账号：' + username)
  }

  /** 判断某管理员当前口令是否为给定明文（用于「仍在使用默认口令」告警） */
  private async isUsingPassword(adminId: number, candidate: string): Promise<boolean> {
    const row = this.deps.db.get<{ password_hash: string }>('SELECT password_hash FROM admin WHERE id = ?', [adminId])
    if (!row) return false
    try {
      return await verifyAdminPassword(candidate, row.password_hash)
    } catch {
      return false
    }
  }

  /** 修改口令：校验旧口令 → 写新哈希 → 吊销其它会话（当前会话保留） */
  async changePassword(currentPassword: string, newPassword: string, keepSessionToken?: string): Promise<{ ok: boolean; error?: string }> {
    if (!newPassword || newPassword.length < 8) return { ok: false, error: '新口令至少 8 位' }
    const admin = this.deps.db.get<{ id: number; username: string; password_hash: string }>('SELECT * FROM admin LIMIT 1')
    if (!admin) return { ok: false, error: '管理员账号不存在' }
    if (!(await verifyAdminPassword(currentPassword, admin.password_hash))) return { ok: false, error: '当前口令不正确' }
    const hash = await hashAdminPassword(newPassword)
    this.deps.db.run('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, Date.now(), admin.id])
    const now = Date.now()
    if (keepSessionToken) {
      this.deps.db.run('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND token_hash != ?', [now, sha256Hex(keepSessionToken)])
    } else {
      this.deps.db.run('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL', [now])
    }
    this.deps.events.info('admin.password_changed', '管理员口令已修改，其它会话已吊销')
    return { ok: true }
  }

  async login(username: string, password: string, ip: string, userAgent: string): Promise<{ token: string; expiresAt: number } | null> {
    const admin = this.deps.db.get<{ id: number; username: string; password_hash: string }>('SELECT * FROM admin WHERE username = ?', [username])
    if (!admin) return null
    const ok = await verifyAdminPassword(password, admin.password_hash)
    if (!ok) {
      this.deps.events.warn('auth.login_failed', '面板登录失败（用户 ' + username + '）', { detail: { ip } })
      return null
    }
    const ttlHours = this.deps.settings.get().panel.sessionTtlHours
    const token = randomId('sess_') + randomId('')
    const expiresAt = Date.now() + ttlHours * 3600_000
    this.deps.db.run('INSERT INTO sessions (id, token_hash, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?)', [
      randomId('sid_'),
      sha256Hex(token),
      ip,
      userAgent.slice(0, 300),
      Date.now(),
      expiresAt,
    ])
    this.audit('panel', admin.username, 'auth.login', null, ip, null)
    return { token, expiresAt }
  }

  logout(token: string): void {
    this.deps.db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [Date.now(), sha256Hex(token)])
  }

  session(token: string | undefined): SessionPrincipal | null {
    if (!token) return null
    const row = this.deps.db.get<{ id: string; expires_at: number; revoked_at: number | null }>(
      'SELECT id, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
      [sha256Hex(token)],
    )
    if (!row) return null
    if (row.revoked_at !== null || row.expires_at < Date.now()) return null
    const admin = this.deps.db.get<{ username: string }>('SELECT username FROM admin LIMIT 1')
    return { kind: 'session', id: row.id, username: admin?.username ?? 'admin' }
  }
 
  /** 创建 API Key：明文只返回一次（§10.4） */
  createApiKey(input: { name: string; scopes: Scope[]; ipAllowlist?: string[]; rateLimitPerMin?: number; expiresAt?: number | null }, actor = 'panel'): { id: string; plaintext: string; prefix: string } {
    const { plaintext, prefix, keyHash } = generateApiKey()
    const id = randomId('key_')
    this.deps.db.run(
      'INSERT INTO api_keys (id, name, prefix, key_hash, scopes_json, ip_allowlist_json, rate_limit_per_min, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.name,
        prefix,
        keyHash,
        JSON.stringify(input.scopes.length ? input.scopes : ['read']),
        input.ipAllowlist && input.ipAllowlist.length ? JSON.stringify(input.ipAllowlist) : null,
        input.rateLimitPerMin ?? 0,
        Date.now(),
        input.expiresAt ?? null,
      ],
    )
    this.audit('panel', actor, 'apikey.create', id, null, { name: input.name, scopes: input.scopes })
    return { id, plaintext, prefix }
  }

  /** 校验 API Key：返回 principal 或错误原因 */
  verifyApiKey(header: string | undefined, ip: string): { principal?: ApiKeyPrincipal; reason?: 'missing' | 'invalid' | 'revoked' | 'expired' | 'ip_denied' | 'rate_limited' } {
    if (!header || !header.startsWith('Bearer ')) return { reason: 'missing' }
    const token = header.slice(7).trim()
    const parsed = hashApiKeySecret(token)
    if (!parsed) return { reason: 'invalid' }
    const row = this.deps.db.get<any>('SELECT * FROM api_keys WHERE prefix = ?', [parsed.prefix])
    if (!row) return { reason: 'invalid' }
    if (!safeEqual(row.key_hash, parsed.keyHash)) return { reason: 'invalid' }
    if (row.revoked_at !== null) return { reason: 'revoked' }
    if (row.expires_at !== null && row.expires_at < Date.now()) return { reason: 'expired' }
    if (row.ip_allowlist_json) {
      try {
        const list = JSON.parse(row.ip_allowlist_json) as string[]
        if (list.length && !list.includes(ip)) return { reason: 'ip_denied' }
      } catch {
        /* 白名单损坏时忽略 */
      }
    }
    if (row.rate_limit_per_min > 0) {
      const now = Date.now()
      const bucket = this.rateBuckets.get(row.id)
      if (!bucket || now - bucket.window >= 60000) {
        this.rateBuckets.set(row.id, { window: now, count: 1 })
      } else {
        bucket.count++
        if (bucket.count > row.rate_limit_per_min) return { reason: 'rate_limited' }
      }
    }
    this.deps.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [Date.now(), row.id])
    return { principal: { kind: 'apikey', id: row.id, name: row.name, scopes: JSON.parse(row.scopes_json) as Scope[] } }
  }

  listApiKeys(): any[] {
    return this.deps.db.all<any>('SELECT id, name, prefix, scopes_json, ip_allowlist_json, rate_limit_per_min, created_at, last_used_at, expires_at, revoked_at FROM api_keys ORDER BY created_at DESC').map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: JSON.parse(r.scopes_json),
      ipAllowlist: r.ip_allowlist_json ? JSON.parse(r.ip_allowlist_json) : [],
      rateLimitPerMin: r.rate_limit_per_min,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
    }))
  }

  revokeApiKey(id: string, actor = 'panel'): boolean {
    const r = this.deps.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), id])
    if (r.changes > 0) this.audit('panel', actor, 'apikey.revoke', id, null, null)
    return r.changes > 0
  }

  audit(actorType: 'panel' | 'apikey' | 'system', actorId: string, action: string, target: string | null, ip: string | null, detail: unknown, requestId?: string): void {
    this.deps.db.run('INSERT INTO audit_log (at, actor_type, actor_id, action, target, ip, request_id, detail_json) VALUES (?,?,?,?,?,?,?,?)', [
      Date.now(),
      actorType,
      actorId,
      action,
      target,
      ip,
      requestId ?? null,
      detail === undefined || detail === null ? null : JSON.stringify(detail),
    ])
  }
}

export function hasScope(p: ApiKeyPrincipal, scope: Scope): boolean {
  if (p.scopes.includes('admin')) return true
  return p.scopes.includes(scope)
}