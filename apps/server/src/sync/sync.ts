import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { decryptSecret, encryptSecret, generateNodePassword, passwordLookupHash, sha1Hex } from '../core/crypto'
import { randomId, stableStringify } from '../core/ids'
import { logger } from '../core/log'
import { parseSubscription } from '../sub/formats'
import { normalizeNode } from '../sub/normalize'
import { allocateNodeId, regionKey } from '../sub/naming'
import type { NormalizedNode, SubFormatHint } from '../sub/types'

export interface SubscriptionRow {
  id: string
  name: string
  url: string
  format_hint: SubFormatHint
  enabled: number
  interval_sec: number | null
  cron: string | null
  timeout_ms: number
  retries: number
  retry_backoff_ms: number
  headers_json: string | null
  user_agent: string | null
  sub_id_override: string | null
  last_sync_at: number | null
  last_status: string
  last_error: string | null
  last_error_kind: string | null
  etag: string | null
  last_modified: string | null
  consecutive_failures: number
}

export interface SyncResult {
  subscriptionId: string
  status: 'ok' | 'failed' | 'not-modified'
  httpStatus?: number
  bytes?: number
  durationMs: number
  totalFound: number
  added: number
  changed: number
  removed: number
  restored: number
  unsupported: number
  parseErrors: number
  errorKind?: string
  errorMsg?: string
  format?: string
}

export interface SyncDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
}

/**
 * SyncJob（PANEL.md §7）。只写期望状态，**永不碰数据面**。
 * 失败时绝不改动 nodes（§7.6 硬性要求）。
 */
export class SyncService {
  constructor(private deps: SyncDeps) {}

  listSubscriptions(enabledOnly = false): SubscriptionRow[] {
    return this.deps.db.all<SubscriptionRow>(
      'SELECT * FROM subscriptions' + (enabledOnly ? ' WHERE enabled = 1' : '') + ' ORDER BY created_at ASC',
    )
  }

  /** 取回订阅正文：超时/重试/ETag/大小上限（§7.1） */
  async fetchBody(sub: SubscriptionRow, opts: { force?: boolean } = {}): Promise<{ notModified: boolean; body: string; httpStatus: number; bytes: number }> {
    const s = this.deps.settings.get().subsync
    // 内联文本订阅（面板直接粘贴）：不发任何 HTTP 请求
    if (sub.url.startsWith('inline://')) {
      const row = this.deps.db.get<{ content_text: string | null }>('SELECT content_text FROM subscriptions WHERE id = ?', [sub.id])
      const text = row?.content_text ?? ''
      if (!text.trim()) throw Object.assign(new Error('内联订阅内容为空'), { kind: 'empty_result' })
      if (text.length > s.maxBytes) throw Object.assign(new Error('内联订阅内容超过大小上限'), { kind: 'too_large' })
      return { notModified: false, body: text, httpStatus: 200, bytes: text.length }
    }
    const headers: Record<string, string> = {
      'user-agent': sub.user_agent || s.userAgent,
      accept: '*/*',
    }
    if (sub.headers_json) {
      try {
        Object.assign(headers, JSON.parse(sub.headers_json) as Record<string, string>)
      } catch {
        /* 无效 headers 忽略 */
      }
    }
    if (!opts.force && sub.etag) headers['if-none-match'] = sub.etag
    if (!opts.force && sub.last_modified) headers['if-modified-since'] = sub.last_modified

    const retries = Math.max(0, sub.retries)
    let lastErr: { kind: string; msg: string } = { kind: 'internal', msg: 'unknown' }
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), sub.timeout_ms || s.timeoutMs)
      try {
        const res = await fetch(sub.url, { headers, signal: ctrl.signal, redirect: 'follow' })
        clearTimeout(timer)
        if (res.status === 304) return { notModified: true, body: '', httpStatus: 304, bytes: 0 }
        if (res.status >= 400 && res.status < 500) {
          const text = await res.text().catch(() => '')
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 120)), { noRetry: true, kind: 'http_' + res.status })
        }
        if (!res.ok) {
          lastErr = { kind: 'http_' + res.status, msg: 'HTTP ' + res.status }
          throw new Error('HTTP ' + res.status)
        }
        const maxBytes = s.maxBytes
        const buf = await res.arrayBuffer()
        if (buf.byteLength > maxBytes) {
          throw Object.assign(new Error('订阅内容超过大小上限 ' + maxBytes + ' 字节'), { noRetry: true, kind: 'too_large' })
        }
        const body = new TextDecoder('utf-8').decode(buf)
        // 记录 ETag / Last-Modified
        const etag = res.headers.get('etag')
        const lm = res.headers.get('last-modified')
        this.deps.db.run('UPDATE subscriptions SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), updated_at = ? WHERE id = ?', [
          etag,
          lm,
          Date.now(),
          sub.id,
        ])
        return { notModified: false, body, httpStatus: res.status, bytes: buf.byteLength }
      } catch (e) {
        clearTimeout(timer)
        const err = e as Error & { noRetry?: boolean; kind?: string }
        const kind = err.kind ?? classifyFetchError(err.message)
        lastErr = { kind, msg: err.message }
        if (err.noRetry || attempt === retries) break
        const backoff = (sub.retry_backoff_ms || s.retryBackoffMs) * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
    throw Object.assign(new Error(lastErr.msg), { kind: lastErr.kind })
  }

  /** 解析预览（不落库，§11.1 /api/subscriptions/preview） */
  preview(body: string, hint: SubFormatHint = 'auto', sourceSubscriptionId = 'preview'): {
    format: string
    total: number
    supported: number
    unsupported: number
    nodes: NormalizedNode[]
    errors: { lineNo: number; rawSnippet: string; errorKind: string; errorMsg: string }[]
  } {
    const parsed = parseSubscription(body, hint, sourceSubscriptionId)
    const nodes: NormalizedNode[] = []
    for (const input of parsed.nodes) {
      try {
        nodes.push(normalizeNode(input))
      } catch (e) {
        parsed.errors.push({ lineNo: 0, rawSnippet: input.raw.slice(0, 200), errorKind: 'normalize_failed', errorMsg: (e as Error).message })
      }
    }
    const supported = nodes.filter((n) => n.protocolSupported).length
    return {
      format: parsed.format,
      total: nodes.length,
      supported,
      unsupported: nodes.length - supported,
      nodes,
      errors: parsed.errors,
    }
  }

  /** 执行一次同步（SyncJob 主体） */
  async runSync(subscriptionId: string, trigger: 'manual' | 'cron' | 'api', opts: { force?: boolean } = {}): Promise<SyncResult> {
    const sub = this.deps.db.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId])
    if (!sub) throw new Error('订阅不存在: ' + subscriptionId)
    const started = Date.now()
    const runId = randomId('run_')
    this.deps.db.run(
      'INSERT INTO subscription_runs (id, subscription_id, trigger, started_at, status) VALUES (?,?,?,?,?)',
      [runId, subscriptionId, trigger, started, 'running'],
    )

    let fetchInfo: { notModified: boolean; body: string; httpStatus: number; bytes: number }
    try {
      fetchInfo = await this.fetchBody(sub, opts)
    } catch (e) {
      const err = e as Error & { kind?: string }
      const kind = err.kind ?? 'network_error'
      this.failRun(runId, sub, kind, err.message, started)
      this.deps.events.warn('sync.failed', '订阅「' + sub.name + '」同步失败：' + err.message, { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: 0,
        errorKind: kind,
        errorMsg: err.message,
      }
    }

    if (fetchInfo.notModified) {
      this.deps.db.run(
        'UPDATE subscription_runs SET status=?, finished_at=?, http_status=?, bytes=?, duration_ms=?, error_kind=? WHERE id=?',
        ['ok', Date.now(), 304, 0, Date.now() - started, 'not_modified', runId],
      )
      this.deps.db.run('UPDATE subscriptions SET last_sync_at = ?, last_status = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?', [
        Date.now(),
        'ok',
        Date.now(),
        sub.id,
      ])
      this.deps.events.info('sync.not_modified', '订阅「' + sub.name + '」未变更（304）', { subscriptionId })
      return {
        subscriptionId,
        status: 'not-modified',
        httpStatus: 304,
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: 0,
      }
    }

    const parsed = this.preview(fetchInfo.body, sub.format_hint, sub.id)

    // §7.6：解析出 0 个节点视为失败，不落库
    if (parsed.nodes.length === 0) {
      this.failRun(runId, sub, parsed.format === 'unknown' ? 'format_unknown' : 'empty_result', '解析出 0 个节点（格式=' + parsed.format + '）', started, fetchInfo)
      if (parsed.errors.length) this.insertRunErrors(runId, parsed.errors)
      this.deps.events.warn('sync.empty', '订阅「' + sub.name + '」解析出 0 个节点，期望状态保持不变', { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        httpStatus: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: parsed.errors.length,
        errorKind: 'empty_result',
        errorMsg: '解析出 0 个节点',
        format: parsed.format,
      }
    }

    const counts = this.applyNodes(sub, parsed.nodes)
    const durationMs = Date.now() - started
    this.deps.db.run(
      'UPDATE subscription_runs SET status=?, finished_at=?, http_status=?, bytes=?, duration_ms=?, total_found=?, added=?, changed=?, removed=?, restored=?, unsupported=?, parse_errors=?, result_digest=? WHERE id=?',
      [
        'ok',
        Date.now(),
        fetchInfo.httpStatus,
        fetchInfo.bytes,
        durationMs,
        parsed.total,
        counts.added,
        counts.changed,
        counts.removed,
        counts.restored,
        counts.unsupported,
        parsed.errors.length,
        sha1Hex(stableStringify(parsed.nodes.map((n) => n.fingerprint).sort())),
        runId,
      ],
    )
    if (parsed.errors.length) this.insertRunErrors(runId, parsed.errors)
    this.deps.db.run('UPDATE subscriptions SET last_sync_at = ?, last_status = ?, last_error = NULL, last_error_kind = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ?', [
      Date.now(),
      'ok',
      Date.now(),
      sub.id,
    ])
    this.trimRuns(sub.id)
    this.deps.events.info(
      'sync.done',
      '订阅「' + sub.name + '」同步完成：新增 ' + counts.added + '，修改 ' + counts.changed + '，消失 ' + counts.removed + '，恢复 ' + counts.restored + '，不可发布 ' + counts.unsupported,
      { subscriptionId },
    )
    return {
      subscriptionId,
      status: 'ok',
      httpStatus: fetchInfo.httpStatus,
      bytes: fetchInfo.bytes,
      durationMs,
      totalFound: parsed.total,
      ...counts,
      parseErrors: parsed.errors.length,
      format: parsed.format,
    }
  }

  /** 事务内写 nodes / node_sources / node_credentials（§7.5 去重与消失/恢复语义） */
  private applyNodes(sub: SubscriptionRow, nodes: NormalizedNode[]): {
    added: number
    changed: number
    removed: number
    restored: number
    unsupported: number
  } {
    const settings = this.deps.settings.get()
    const now = Date.now()
    const staleUntil = now + settings.publish.staleRetentionDays * 86400_000
    let added = 0
    let changed = 0
    let restored = 0
    let unsupported = 0

    const seenFingerprints = new Set<string>()

    this.deps.db.tx(() => {
      for (const n of nodes) {
        seenFingerprints.add(n.fingerprint)
        if (!n.protocolSupported) unsupported++
        const existing = this.deps.db.get<any>('SELECT * FROM nodes WHERE fingerprint = ?', [n.fingerprint])
        if (!existing) {
          const id = this.allocateId(n.name)
          this.deps.db.run(
            'INSERT INTO nodes (id, display_name, country_code, region, protocol, fingerprint, params_hash, outbound_json, protocol_supported, enabled, is_virtual, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?,?,?)',
            [
              id,
              n.name,
              n.protocolSupported ? regionKey(n.name)?.toUpperCase() ?? null : null,
              typeof n.params.region === 'string' ? n.params.region : null,
              n.protocol,
              n.fingerprint,
              n.paramsHash,
              JSON.stringify(n.outbound),
              n.protocolSupported ? 1 : 0,
              now,
              now,
              now,
              now,
            ],
          )
          this.ensureCredential(id)
          added++
        } else {
          const paramsChanged = existing.params_hash !== n.paramsHash || existing.display_name !== n.name
          if (paramsChanged) {
            this.deps.db.run(
              'UPDATE nodes SET display_name=?, protocol=?, params_hash=?, outbound_json=?, protocol_supported=?, last_seen_at=?, updated_at=? WHERE id=?',
              [n.name, n.protocol, n.paramsHash, JSON.stringify(n.outbound), n.protocolSupported ? 1 : 0, now, now, existing.id],
            )
            changed++
          } else {
            this.deps.db.run('UPDATE nodes SET last_seen_at=?, updated_at=? WHERE id=?', [now, now, existing.id])
          }
          if (existing.missing_since !== null) {
            this.deps.db.run('UPDATE nodes SET missing_since=NULL, stale_until=NULL, enabled=1, updated_at=? WHERE id=?', [now, existing.id])
            restored++
          }
          this.ensureCredential(existing.id)
        }
      }

      // 本订阅不再提供的节点 → missing_since（不删凭据、不立即动数据面，§7.5）
      const owned = this.deps.db.all<{ node_id: string; fingerprint: string }>(
        'SELECT ns.node_id, n.fingerprint FROM node_sources ns JOIN nodes n ON n.id = ns.node_id WHERE ns.subscription_id = ?',
        [sub.id],
      )
      for (const o of owned) {
        if (seenFingerprints.has(o.fingerprint)) continue
        const otherSources = this.deps.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM node_sources WHERE node_id = ? AND subscription_id != ? AND last_seen_at >= ?',
          [o.node_id, sub.id, now - 1000],
        )
        if ((otherSources?.n ?? 0) > 0) continue
        this.deps.db.run('UPDATE nodes SET missing_since = COALESCE(missing_since, ?), stale_until = COALESCE(stale_until, ?), updated_at = ? WHERE id = ?', [
          now,
          staleUntil,
          now,
          o.node_id,
        ])
      }

      // 写 node_sources
      const byFingerprint = new Map(nodes.map((n) => [n.fingerprint, n]))
      for (const n of nodes) {
        const nodeRow = this.deps.db.get<{ id: string }>('SELECT id FROM nodes WHERE fingerprint = ?', [n.fingerprint])
        if (!nodeRow) continue
        this.deps.db.run(
          'INSERT INTO node_sources (node_id, subscription_id, name_in_sub, first_seen_at, last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(node_id, subscription_id) DO UPDATE SET name_in_sub=excluded.name_in_sub, last_seen_at=excluded.last_seen_at',
          [nodeRow.id, sub.id, byFingerprint.get(n.fingerprint)?.name ?? n.name, now, now],
        )
      }
    })

    const removed = this.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node_sources WHERE subscription_id = ?',
      [sub.id],
    )
    void removed
    const missingNow = this.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM nodes WHERE missing_since >= ? AND missing_since <= ?',
      [now - 50, now + 50],
    )?.n ?? 0
    return { added, changed, removed: missingNow, restored, unsupported }
  }

  private ensureCredential(nodeId: string): void {
    const existing = this.deps.db.get('SELECT node_id FROM node_credentials WHERE node_id = ?', [nodeId])
    if (existing) return
    const password = generateNodePassword()
    this.deps.db.run(
      'INSERT INTO node_credentials (node_id, username, password_enc, password_lookup_hash, created_at) VALUES (?,?,?,?,?)',
      [nodeId, nodeId, encryptSecret(password), passwordLookupHash(password), Date.now()],
    )
  }

  private allocateId(name: string): string {
    const existing = new Set(this.deps.db.all<{ id: string }>('SELECT id FROM nodes').map((r) => r.id.toLowerCase()))
    const region = regionKey(name)
    let seq = 1
    while (true) {
      const id = allocateNodeId(region, existing, seq)
      if (!existing.has(id.toLowerCase())) return id
      seq++
      if (seq > 9999) throw new Error('节点 ID 分配失败')
    }
  }

  private failRun(
    runId: string,
    sub: SubscriptionRow,
    errorKind: string,
    errorMsg: string,
    started: number,
    fetchInfo?: { httpStatus: number; bytes: number },
  ): void {
    this.deps.db.run('UPDATE subscription_runs SET status=?, finished_at=?, http_status=?, bytes=?, duration_ms=?, error_kind=?, error_msg=? WHERE id=?', [
      'failed',
      Date.now(),
      fetchInfo?.httpStatus ?? null,
      fetchInfo?.bytes ?? null,
      Date.now() - started,
      errorKind,
      errorMsg.slice(0, 500),
      runId,
    ])
    this.deps.db.run(
      'UPDATE subscriptions SET last_status=?, last_error=?, last_error_kind=?, consecutive_failures=consecutive_failures+1, updated_at=? WHERE id=?',
      ['failed', errorMsg.slice(0, 500), errorKind, Date.now(), sub.id],
    )
    if (sub.consecutive_failures + 1 >= 3) {
      this.deps.events.warn('sync.repeated_failure', '订阅「' + sub.name + '」连续失败 ' + (sub.consecutive_failures + 1) + ' 次', { subscriptionId: sub.id })
    }
  }

  private insertRunErrors(runId: string, errors: { lineNo: number; rawSnippet: string; errorKind: string; errorMsg: string }[]): void {
    for (const e of errors.slice(0, 100)) {
      this.deps.db.run('INSERT INTO subscription_run_errors (run_id, line_no, raw_snippet, error_kind, error_msg) VALUES (?,?,?,?,?)', [
        runId,
        e.lineNo,
        (e.rawSnippet ?? '').slice(0, 300),
        e.errorKind,
        (e.errorMsg ?? '').slice(0, 300),
      ])
    }
  }

  private trimRuns(subscriptionId: string): void {
    const keep = this.deps.settings.get().subsync.historyKeep
    const rows = this.deps.db.all<{ id: string }>(
      'SELECT id FROM subscription_runs WHERE subscription_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?',
      [subscriptionId, keep],
    )
    for (const r of rows) {
      this.deps.db.run('DELETE FROM subscription_run_errors WHERE run_id = ?', [r.id])
      this.deps.db.run('DELETE FROM subscription_runs WHERE id = ?', [r.id])
    }
  }

  /** 密码明文（供面板展示与网关校验） */
  credentialOf(nodeId: string): { username: string; password: string } | null {
    const row = this.deps.db.get<{ username: string; password_enc: string }>('SELECT username, password_enc FROM node_credentials WHERE node_id = ?', [nodeId])
    if (!row) return null
    try {
      return { username: row.username, password: decryptSecret(row.password_enc) }
    } catch (e) {
      logger.error('credential decrypt failed', { nodeId, msg: (e as Error).message })
      return null
    }
  }

  /** 轮换密码：网关立即生效（D4） */
  rotate(nodeId: string): { username: string; password: string } {
    const password = generateNodePassword()
    const existing = this.deps.db.get('SELECT node_id FROM node_credentials WHERE node_id = ?', [nodeId])
    if (!existing) {
      this.deps.db.run('INSERT INTO node_credentials (node_id, username, password_enc, password_lookup_hash, created_at, rotated_at) VALUES (?,?,?,?,?,?)', [
        nodeId,
        nodeId,
        encryptSecret(password),
        passwordLookupHash(password),
        Date.now(),
        Date.now(),
      ])
    } else {
      this.deps.db.run('UPDATE node_credentials SET password_enc=?, password_lookup_hash=?, rotated_at=? WHERE node_id=?', [
        encryptSecret(password),
        passwordLookupHash(password),
        Date.now(),
        nodeId,
      ])
    }
    this.deps.events.info('credential.rotated', '节点 ' + nodeId + ' 凭据已轮换（网关立即生效）', { nodeId })
    return { username: nodeId, password }
  }
}

function classifyFetchError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('abort')) return 'timeout'
  if (m.includes('enotfound') || m.includes('getaddrinfo')) return 'dns_failed'
  if (m.includes('refused')) return 'tcp_refused'
  if (m.includes('too large')) return 'too_large'
  if (m.includes('certificate')) return 'tls_error'
  return 'network_error'
}
 
