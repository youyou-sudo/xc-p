import { and, asc, count, desc, eq, gte, isNull, lte, ne, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../core/db'
import {
  nodeCredentials,
  nodeSources,
  nodes as nodesT,
  subscriptionRunErrors,
  subscriptionRuns,
  subscriptions,
} from '../core/schema'
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
    const base = this.deps.db.select().from(subscriptions)
    return (enabledOnly ? base.where(eq(subscriptions.enabled, 1)) : base)
      .orderBy(asc(subscriptions.created_at))
      .all() as SubscriptionRow[]
  }

  /** 取回订阅正文：超时/重试/ETag/大小上限（§7.1） */
  async fetchBody(sub: SubscriptionRow, opts: { force?: boolean } = {}): Promise<{ notModified: boolean; body: string; httpStatus: number; bytes: number }> {
    const s = this.deps.settings.get().subsync
    // 内联文本订阅（面板直接粘贴）：不发任何 HTTP 请求
    if (sub.url.startsWith('inline://')) {
      const row = this.deps.db
        .select({ content_text: subscriptions.content_text })
        .from(subscriptions)
        .where(eq(subscriptions.id, sub.id))
        .get()
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
        this.deps.db
          .update(subscriptions)
          .set({
            etag: sql`COALESCE(${etag}, ${subscriptions.etag})`,
            last_modified: sql`COALESCE(${lm}, ${subscriptions.last_modified})`,
            updated_at: Date.now(),
          })
          .where(eq(subscriptions.id, sub.id))
          .run()
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
    const sub = this.deps.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).get() as SubscriptionRow | undefined
    if (!sub) throw new Error('订阅不存在: ' + subscriptionId)
    const started = Date.now()
    const runId = randomId('run_')
    this.deps.db
      .insert(subscriptionRuns)
      .values({ id: runId, subscription_id: subscriptionId, trigger, started_at: started, status: 'running' })
      .run()

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
      this.deps.db
        .update(subscriptionRuns)
        .set({ status: 'ok', finished_at: Date.now(), http_status: 304, bytes: 0, duration_ms: Date.now() - started, error_kind: 'not_modified' })
        .where(eq(subscriptionRuns.id, runId))
        .run()
      this.deps.db
        .update(subscriptions)
        .set({ last_sync_at: Date.now(), last_status: 'ok', consecutive_failures: 0, updated_at: Date.now() })
        .where(eq(subscriptions.id, sub.id))
        .run()
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
    this.deps.db
      .update(subscriptionRuns)
      .set({
        status: 'ok',
        finished_at: Date.now(),
        http_status: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        duration_ms: durationMs,
        total_found: parsed.total,
        added: counts.added,
        changed: counts.changed,
        removed: counts.removed,
        restored: counts.restored,
        unsupported: counts.unsupported,
        parse_errors: parsed.errors.length,
        result_digest: sha1Hex(stableStringify(parsed.nodes.map((n) => n.fingerprint).sort())),
      })
      .where(eq(subscriptionRuns.id, runId))
      .run()
    if (parsed.errors.length) this.insertRunErrors(runId, parsed.errors)
    this.deps.db
      .update(subscriptions)
      .set({
        last_sync_at: Date.now(),
        last_status: 'ok',
        last_error: null,
        last_error_kind: null,
        consecutive_failures: 0,
        updated_at: Date.now(),
      })
      .where(eq(subscriptions.id, sub.id))
      .run()
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

    this.deps.db.transaction(
      () => {
      for (const n of nodes) {
        seenFingerprints.add(n.fingerprint)
        if (!n.protocolSupported) unsupported++
        const existing = this.deps.db.select().from(nodesT).where(eq(nodesT.fingerprint, n.fingerprint)).get()
        if (!existing) {
          const id = this.allocateId(n.name)
          this.deps.db
            .insert(nodesT)
            .values({
              id,
              display_name: n.name,
              country_code: n.protocolSupported ? (regionKey(n.name)?.toUpperCase() ?? null) : null,
              region: typeof n.params.region === 'string' ? n.params.region : null,
              protocol: n.protocol,
              fingerprint: n.fingerprint,
              params_hash: n.paramsHash,
              outbound_json: JSON.stringify(n.outbound),
              protocol_supported: n.protocolSupported ? 1 : 0,
              enabled: 1,
              is_virtual: 0,
              first_seen_at: now,
              last_seen_at: now,
              created_at: now,
              updated_at: now,
            })
            .run()
          this.ensureCredential(id)
          added++
        } else {
          const paramsChanged = existing.params_hash !== n.paramsHash || existing.display_name !== n.name
          if (paramsChanged) {
            this.deps.db
              .update(nodesT)
              .set({
                display_name: n.name,
                protocol: n.protocol,
                params_hash: n.paramsHash,
                outbound_json: JSON.stringify(n.outbound),
                protocol_supported: n.protocolSupported ? 1 : 0,
                last_seen_at: now,
                updated_at: now,
              })
              .where(eq(nodesT.id, existing.id))
              .run()
            changed++
          } else {
            this.deps.db.update(nodesT).set({ last_seen_at: now, updated_at: now }).where(eq(nodesT.id, existing.id)).run()
          }
          if (existing.missing_since !== null) {
            this.deps.db
              .update(nodesT)
              .set({ missing_since: null, stale_until: null, enabled: 1, updated_at: now })
              .where(eq(nodesT.id, existing.id))
              .run()
            restored++
          }
          this.ensureCredential(existing.id)
        }
      }

      // 本订阅不再提供的节点 → missing_since（不删凭据、不立即动数据面，§7.5）
      const owned = this.deps.db
        .select({ node_id: nodeSources.node_id, fingerprint: nodesT.fingerprint })
        .from(nodeSources)
        .innerJoin(nodesT, eq(nodesT.id, nodeSources.node_id))
        .where(eq(nodeSources.subscription_id, sub.id))
        .all()
      for (const o of owned) {
        if (seenFingerprints.has(o.fingerprint)) continue
        const otherSources = this.deps.db
          .select({ n: count() })
          .from(nodeSources)
          .where(and(eq(nodeSources.node_id, o.node_id), ne(nodeSources.subscription_id, sub.id), gte(nodeSources.last_seen_at, now - 1000)))
          .get()
        if ((otherSources?.n ?? 0) > 0) continue
        this.deps.db
          .update(nodesT)
          .set({
            missing_since: sql`COALESCE(${nodesT.missing_since}, ${now})`,
            stale_until: sql`COALESCE(${nodesT.stale_until}, ${staleUntil})`,
            updated_at: now,
          })
          .where(eq(nodesT.id, o.node_id))
          .run()
      }

      // 写 node_sources
      const byFingerprint = new Map(nodes.map((n) => [n.fingerprint, n]))
      for (const n of nodes) {
        const nodeRow = this.deps.db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.fingerprint, n.fingerprint)).get()
        if (!nodeRow) continue
        this.deps.db
          .insert(nodeSources)
          .values({
            node_id: nodeRow.id,
            subscription_id: sub.id,
            name_in_sub: byFingerprint.get(n.fingerprint)?.name ?? n.name,
            first_seen_at: now,
            last_seen_at: now,
          })
          .onConflictDoUpdate({
            target: [nodeSources.node_id, nodeSources.subscription_id],
            set: { name_in_sub: sql`excluded.name_in_sub`, last_seen_at: sql`excluded.last_seen_at` },
          })
          .run()
      }
      },
      { behavior: 'immediate' }
    )

    const removed = this.deps.db
      .select({ n: count() })
      .from(nodeSources)
      .where(eq(nodeSources.subscription_id, sub.id))
      .get()
    void removed
    const missingNow =
      this.deps.db
        .select({ n: count() })
        .from(nodesT)
        .where(and(gte(nodesT.missing_since, now - 50), lte(nodesT.missing_since, now + 50)))
        .get()?.n ?? 0
    return { added, changed, removed: missingNow, restored, unsupported }
  }

  private ensureCredential(nodeId: string): void {
    const existing = this.deps.db
      .select({ node_id: nodeCredentials.node_id })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
    if (existing) return
    const password = generateNodePassword()
    this.deps.db
      .insert(nodeCredentials)
      .values({
        node_id: nodeId,
        username: nodeId,
        password_enc: encryptSecret(password),
        password_lookup_hash: passwordLookupHash(password),
        created_at: Date.now(),
      })
      .run()
  }

  private allocateId(name: string): string {
    const existing = new Set(this.deps.db.select({ id: nodesT.id }).from(nodesT).all().map((r) => r.id.toLowerCase()))
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
    this.deps.db
      .update(subscriptionRuns)
      .set({
        status: 'failed',
        finished_at: Date.now(),
        http_status: fetchInfo?.httpStatus ?? null,
        bytes: fetchInfo?.bytes ?? null,
        duration_ms: Date.now() - started,
        error_kind: errorKind,
        error_msg: errorMsg.slice(0, 500),
      })
      .where(eq(subscriptionRuns.id, runId))
      .run()
    this.deps.db
      .update(subscriptions)
      .set({
        last_status: 'failed',
        last_error: errorMsg.slice(0, 500),
        last_error_kind: errorKind,
        consecutive_failures: sql`${subscriptions.consecutive_failures} + 1`,
        updated_at: Date.now(),
      })
      .where(eq(subscriptions.id, sub.id))
      .run()
    if (sub.consecutive_failures + 1 >= 3) {
      this.deps.events.warn('sync.repeated_failure', '订阅「' + sub.name + '」连续失败 ' + (sub.consecutive_failures + 1) + ' 次', { subscriptionId: sub.id })
    }
  }

  private insertRunErrors(runId: string, errors: { lineNo: number; rawSnippet: string; errorKind: string; errorMsg: string }[]): void {
    for (const e of errors.slice(0, 100)) {
      this.deps.db
        .insert(subscriptionRunErrors)
        .values({
          run_id: runId,
          line_no: e.lineNo,
          raw_snippet: (e.rawSnippet ?? '').slice(0, 300),
          error_kind: e.errorKind,
          error_msg: (e.errorMsg ?? '').slice(0, 300),
        })
        .run()
    }
  }

  private trimRuns(subscriptionId: string): void {
    const keep = this.deps.settings.get().subsync.historyKeep
    // drizzle 只写 OFFSET 不写 LIMIT，SQLite 会语法错；这里是单条语句，用 raw 保留 LIMIT -1 OFFSET 语义
    const rows = this.deps.db.all<{ id: string }>(
      sql`SELECT id FROM subscription_runs WHERE subscription_id = ${subscriptionId} ORDER BY started_at DESC LIMIT -1 OFFSET ${keep}`
    )
    for (const r of rows) {
      this.deps.db.delete(subscriptionRunErrors).where(eq(subscriptionRunErrors.run_id, r.id)).run()
      this.deps.db.delete(subscriptionRuns).where(eq(subscriptionRuns.id, r.id)).run()
    }
  }

  /** 密码明文（供面板展示与网关校验） */
  credentialOf(nodeId: string): { username: string; password: string } | null {
    const row = this.deps.db
      .select({ username: nodeCredentials.username, password_enc: nodeCredentials.password_enc })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
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
    const existing = this.deps.db
      .select({ node_id: nodeCredentials.node_id })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
    if (!existing) {
      this.deps.db
        .insert(nodeCredentials)
        .values({
          node_id: nodeId,
          username: nodeId,
          password_enc: encryptSecret(password),
          password_lookup_hash: passwordLookupHash(password),
          created_at: Date.now(),
          rotated_at: Date.now(),
        })
        .run()
    } else {
      this.deps.db
        .update(nodeCredentials)
        .set({
          password_enc: encryptSecret(password),
          password_lookup_hash: passwordLookupHash(password),
          rotated_at: Date.now(),
        })
        .where(eq(nodeCredentials.node_id, nodeId))
        .run()
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
 
