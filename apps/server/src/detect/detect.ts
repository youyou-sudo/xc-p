import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { decryptSecret } from '../core/crypto'
import { logger } from '../core/log'
import type { XrayCli } from '../xray/cli'
import { fetchViaProxy, parseExitInfo, tcpConnect, type ErrorKind, type ExitInfo } from './probe'
import { backoffMs, nextState, withJitter, type NodeState } from './state'

export interface DetectTarget {
  nodeId: string
  username: string
  password: string
  enabled: number
  protocolSupported: number
  state: NodeState
  failStreak: number
  successStreak: number
}

export interface CheckResult {
  nodeId: string
  ok: boolean
  stageReached: 'gateway' | 'handshake' | 'http' | 'exit_ip'
  connectMs?: number
  handshakeMs?: number
  totalMs?: number
  delayMs?: number
  httpStatus?: number
  exit?: ExitInfo
  errorKind?: ErrorKind
  errorMsg?: string
}

export interface DetectDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
  cli: XrayCli
  /** 网关地址与是否可用（检测走网关，D7） */
  gatewayInfo: () => { host: string; port: number; enabled: boolean }
}

/** 检测并发信号量（§8.4 硬性要求） */
export class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  /** 观测到的最大并发（验收 AC-8 用：证明并发确实受限） */
  peak = 0
  constructor(private limit: number) {}

  get running(): number {
    return this.active
  }

  get capacity(): number {
    return this.limit
  }

  resetPeak(): void {
    this.peak = 0
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      if (this.active > this.peak) this.peak = this.active
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    if (this.active > this.peak) this.peak = this.active
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, n)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/**
 * DetectJob（PANEL.md §8）。三阶段：S1 网关可达 → S2 经节点真实请求 → S3 出口确认。
 */
export class Detector {
  readonly semaphore: Semaphore
  private cancelled = false

  constructor(private deps: DetectDeps) {
    this.semaphore = new Semaphore(deps.settings.get().detect.concurrency)
  }

  cancel(): void {
    this.cancelled = true
  }

  resume(): void {
    this.cancelled = false
  }

  /** 载入可检测目标（默认只针对 enabled、protocol_supported、未隔离，§8.4） */
  loadTargets(nodeIds?: string[], includeQuarantined = false): DetectTarget[] {
    const where: string[] = ['n.enabled = 1', 'n.protocol_supported = 1']
    const params: (string | number)[] = []
    if (nodeIds && nodeIds.length) {
      where.push('n.id IN (' + nodeIds.map(() => '?').join(',') + ')')
      params.push(...nodeIds)
    }
    if (!includeQuarantined) where.push("COALESCE(st.state,'unknown') != 'quarantined'")
    const rows = this.deps.db.all<any>(
      'SELECT n.id AS node_id, n.protocol, c.username, c.password_enc, COALESCE(st.state,\'unknown\') AS state, ' +
        'COALESCE(st.fail_streak,0) AS fail_streak, COALESCE(st.success_streak,0) AS success_streak ' +
        'FROM nodes n JOIN node_credentials c ON c.node_id = n.id LEFT JOIN node_status st ON st.node_id = n.id ' +
        'WHERE ' + where.join(' AND ') + ' ORDER BY n.id ASC',
      params,
    )
    return rows.map((r) => ({
      nodeId: r.node_id,
      username: r.username,
      password: decryptSecret(r.password_enc),
      enabled: 1,
      protocolSupported: 1,
      state: r.state as NodeState,
      failStreak: r.fail_streak,
      successStreak: r.success_streak,
    }))
  }

  /** 单节点三阶段检测 */
  async checkOne(target: DetectTarget, depth: 'lite' | 'full' = 'full'): Promise<CheckResult> {
    const s = this.deps.settings.get()
    const gw = this.deps.gatewayInfo()
    const started = Date.now()
    const result: CheckResult = { nodeId: target.nodeId, ok: false, stageReached: 'gateway' }

    if (!gw.enabled) {
      return { ...result, errorKind: 'gateway_unreachable', errorMsg: '网关未启用', totalMs: Date.now() - started }
    }

    // S1：网关可达（TCP + 认证）
    const tcp = await tcpConnect(gw.host, gw.port, s.detect.tcpTimeoutMs)
    result.connectMs = tcp.ms
    if (!tcp.ok) {
      return { ...result, totalMs: Date.now() - started, errorKind: 'gateway_unreachable', errorMsg: tcp.errorMsg ?? '网关不可达' }
    }
    result.stageReached = 'handshake'

    // 轻量模式：只做 S1（§8.1 lite）
    if (depth === 'lite') {
      return { ...result, ok: true, stageReached: 'gateway', totalMs: Date.now() - started }
    }

    const proxyUrl = 'http://' + encodeURIComponent(target.username) + ':' + encodeURIComponent(target.password) + '@' + gw.host + ':' + gw.port

    // S2：经节点真实请求
    const s2 = await fetchViaProxy(s.detect.testUrl, proxyUrl, s.detect.totalTimeoutMs)
    result.handshakeMs = s2.ms
    result.httpStatus = s2.status
    if (!s2.ok) {
      return {
        ...result,
        totalMs: Date.now() - started,
        errorKind: s2.errorKind ?? 'empty_reply',
        errorMsg: s2.errorMsg ?? '经节点请求失败',
      }
    }
    result.stageReached = 'http'

    // S3：出口确认
    let exit: ExitInfo | undefined
    let lastErr: { kind?: ErrorKind; msg?: string } = {}
    for (const echo of s.detect.ipEchoUrls) {
      const s3 = await fetchViaProxy(echo, proxyUrl, s.detect.totalTimeoutMs)
      if (s3.ok && s3.body) {
        const info = parseExitInfo(s3.body)
        if (info.ip) {
          exit = info
          break
        }
        lastErr = { kind: 'ip_echo_failed', msg: 'IP 回显缺少 IP 字段' }
      } else {
        lastErr = { kind: s3.errorKind ?? 'ip_echo_failed', msg: s3.errorMsg ?? 'IP 回显失败' }
      }
    }
    result.totalMs = Date.now() - started
    if (!exit) {
      return { ...result, errorKind: lastErr.kind ?? 'ip_echo_failed', errorMsg: lastErr.msg ?? '未取到出口 IP' }
    }
    result.exit = exit
    result.delayMs = result.handshakeMs
    result.stageReached = 'exit_ip'
    result.ok = true
    return result
  }

  /** 批量检测：信号量限流 + 每 20 条批量写（§8.4） */
  async run(
    targets: DetectTarget[],
    opts: { source: 'manual' | 'cron' | 'apikey' | 'publish_gate'; depth?: 'lite' | 'full'; onProgress?: (done: number, total: number) => void },
  ): Promise<CheckResult[]> {
    const s = this.deps.settings.get()
    this.semaphore.setLimit(s.detect.concurrency)
    const depth = opts.depth ?? (s.detect.fullModeEnabled ? 'full' : 'lite')
    this.cancelled = false
    let done = 0
    const results: CheckResult[] = []
    const buffer: CheckResult[] = []

    const flush = () => {
      if (buffer.length === 0) return
      const batch = buffer.splice(0, buffer.length)
      this.deps.db.tx(() => {
        for (const r of batch) this.persist(r, opts.source, depth)
      })
    }

    await Promise.all(
      targets.map((t) =>
        this.semaphore.run(async () => {
          if (this.cancelled) return
          let res: CheckResult
          try {
            res = await this.checkOne(t, depth)
          } catch (e) {
            res = {
              nodeId: t.nodeId,
              ok: false,
              stageReached: 'gateway',
              errorKind: 'internal',
              errorMsg: e instanceof Error ? e.message : String(e),
            }
          }
          results.push(res)
          buffer.push(res)
          done++
          if (buffer.length >= 20) flush()
          opts.onProgress?.(done, targets.length)
        }),
      ),
    )
    flush()
    return results
  }

  /** AC-8：本次批量检测观测到的最大并发 */
  peakConcurrency(): number {
    return this.semaphore.peak
  }

  /** 写 node_status + node_check_runs（§6.4 / §8.2） */
  persist(r: CheckResult, source: string, depth: 'lite' | 'full'): void {
    const s = this.deps.settings.get()
    const now = Date.now()
    const prev = this.deps.db.get<any>('SELECT * FROM node_status WHERE node_id = ?', [r.nodeId])
    const prevState: NodeState = (prev?.state as NodeState) ?? 'unknown'
    const out = nextState({
      prev: prevState,
      ok: r.ok,
      failStreak: prev?.fail_streak ?? 0,
      successStreak: prev?.success_streak ?? 0,
      recoverAfter: s.detect.recoverAfter,
      quarantineAfter: s.detect.quarantineAfter,
    })

    const total = (prev?.checks_total ?? 0) + 1
    const okCount = (prev?.checks_ok ?? 0) + (r.ok ? 1 : 0)
    const uptime = total > 0 ? okCount / total : 0

    const next = r.ok
      ? withJitter(s.detect.intervalSec * 1000, s.detect.jitterMs)
      : withJitter(backoffMs(s.detect.intervalSec, out.failStreak), s.detect.jitterMs)

    const row = {
      node_id: r.nodeId,
      state: out.state,
      last_check_at: now,
      last_ok_at: r.ok ? now : (prev?.last_ok_at ?? null),
      last_fail_at: r.ok ? (prev?.last_fail_at ?? null) : now,
      recovered_at: out.recovered ? now : (prev?.recovered_at ?? null),
      connect_ms: r.connectMs ?? null,
      handshake_ms: r.handshakeMs ?? null,
      total_ms: r.totalMs ?? null,
      delay_ms: r.delayMs ?? null,
      exit_ip: r.exit?.ip ?? prev?.exit_ip ?? null,
      exit_country: r.exit?.country ?? prev?.exit_country ?? null,
      exit_region: r.exit?.region ?? prev?.exit_region ?? null,
      exit_asn: r.exit?.asn ?? prev?.exit_asn ?? null,
      exit_isp: r.exit?.isp ?? prev?.exit_isp ?? null,
      error_kind: r.ok ? null : (r.errorKind ?? 'internal'),
      error_msg: r.ok ? null : (r.errorMsg ?? '').slice(0, 200),
      fail_streak: out.failStreak,
      success_streak: out.successStreak,
      next_check_at: now + next,
      checks_total: total,
      checks_ok: okCount,
      uptime_24h: uptime,
      updated_at: now,
    }

    // 注意：用**位置参数**而不是命名参数——bun:sqlite 的命名参数绑定在部分版本下
    // 会静默失败（表现为 NOT NULL constraint failed: node_status.state）。
    const cols = [
      'node_id', 'state', 'last_check_at', 'last_ok_at', 'last_fail_at', 'recovered_at',
      'connect_ms', 'handshake_ms', 'total_ms', 'delay_ms',
      'exit_ip', 'exit_country', 'exit_region', 'exit_asn', 'exit_isp',
      'error_kind', 'error_msg', 'fail_streak', 'success_streak', 'next_check_at',
      'checks_total', 'checks_ok', 'uptime_24h', 'updated_at',
    ] as const
    const values = cols.map((c) => (row as any)[c] as any)
    this.deps.db.run(
      'INSERT INTO node_status (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ') ' +
        'ON CONFLICT(node_id) DO UPDATE SET ' +
        cols
          .filter((c) => c !== 'node_id')
          .map((c) => c + '=excluded.' + c)
          .join(', '),
      values,
    )

    this.deps.db.run(
      'INSERT INTO node_check_runs (node_id, at, source, ok, stage_reached, connect_ms, handshake_ms, total_ms, delay_ms, http_status, exit_ip, exit_country, error_kind, error_msg, detail_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        r.nodeId,
        now,
        source,
        r.ok ? 1 : 0,
        r.stageReached,
        r.connectMs ?? null,
        r.handshakeMs ?? null,
        r.totalMs ?? null,
        r.delayMs ?? null,
        r.httpStatus ?? null,
        r.exit?.ip ?? null,
        r.exit?.country ?? null,
        r.ok ? null : (r.errorKind ?? 'internal'),
        r.ok ? null : (r.errorMsg ?? '').slice(0, 200),
        JSON.stringify({ depth, exit: r.exit ?? null }),
      ],
    )

    if (prevState !== out.state) {
      if (out.state === 'quarantined') {
        this.deps.events.warn('node.quarantined', '节点 ' + r.nodeId + ' 连续失败 ' + out.failStreak + ' 次，已隔离', { nodeId: r.nodeId })
      } else if (out.recovered) {
        this.deps.events.info('node.recovered', '节点 ' + r.nodeId + ' 已恢复（recovered_at 已记录）', { nodeId: r.nodeId })
      }
    }

    // 协议不可发布提示（D9）
    void depth
  }

  /** 清理检测历史（§13 清理任务） */
  trimHistory(): number {
    const keep = this.deps.settings.get().detect.historyKeep
    let removed = 0
    const nodes = this.deps.db.all<{ node_id: string }>('SELECT DISTINCT node_id FROM node_check_runs')
    for (const n of nodes) {
      const r = this.deps.db.run(
        'DELETE FROM node_check_runs WHERE node_id = ? AND id NOT IN (SELECT id FROM node_check_runs WHERE node_id = ? ORDER BY at DESC LIMIT ?)',
        [n.node_id, n.node_id, keep],
      )
      removed += r.changes
    }
    return removed
  }

  /** 到期需要检测的节点（调度器用，§13） */
  dueTargets(limit = 500): DetectTarget[] {
    const now = Date.now()
    const rows = this.deps.db.all<any>(
      'SELECT n.id AS node_id FROM nodes n JOIN node_credentials c ON c.node_id = n.id ' +
        "LEFT JOIN node_status st ON st.node_id = n.id WHERE n.enabled = 1 AND n.protocol_supported = 1 " +
        'AND (st.next_check_at IS NULL OR st.next_check_at <= ?) ORDER BY COALESCE(st.next_check_at, 0) ASC LIMIT ?',
      [now, limit],
    )
    if (rows.length === 0) return []
    return this.loadTargets(rows.map((r) => r.node_id), true)
  }

  /** 轻量模式：只读数据面统计（§8.1 lite / D7） */
  async liteStats(nodeId: string): Promise<{ ok: boolean; up: number; down: number }> {
    const { stats } = await this.deps.cli.statsquery('inbound>>>in-' + nodeId)
    const up = Object.entries(stats)
      .filter(([k]) => k.includes('uplink'))
      .reduce((a, [, v]) => a + v, 0)
    const down = Object.entries(stats)
      .filter(([k]) => k.includes('downlink'))
      .reduce((a, [, v]) => a + v, 0)
    logger.debug('liteStats', { nodeId, up, down })
    return { ok: up + down > 0, up, down }
  }
}
