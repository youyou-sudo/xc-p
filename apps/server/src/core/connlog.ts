import type { Db } from './db'
import type { EventBus } from './events'

export interface ActiveConn {
  id: number
  nodeId: string
  username: string
  clientIp: string
  target: string
  protocol: string
  startedAt: number
  upBytes: number
  downBytes: number
}

/**
 * 网关连接表（PANEL.md D1 第 3 点 / §6.6 node_connections）：
 * Xray 没有连接枚举与踢线能力，连接态数据一律来自网关。
 * 活跃快照每 30s 落库一次，关闭时写终态。
 */
export class ConnectionTracker {
  private conns = new Map<number, ActiveConn>()
  private nextId = 1

  constructor(
    private db: Db,
    private events: EventBus,
  ) {}

  open(info: { nodeId: string; username: string; clientIp: string; target: string; protocol: string }): number {
    const id = this.nextId++
    const conn: ActiveConn = { id, ...info, startedAt: Date.now(), upBytes: 0, downBytes: 0 }
    this.conns.set(id, conn)
    try {
      this.db.run(
        'INSERT INTO node_connections (id, node_id, username, client_ip, target, started_at, up_bytes, down_bytes) VALUES (?,?,?,?,?,?,0,0)',
        [id, info.nodeId, info.username, info.clientIp, info.target, conn.startedAt],
      )
    } catch {
      /* 落库失败不影响转发 */
    }
    return id
  }

  bytes(id: number, up: number, down: number): void {
    const c = this.conns.get(id)
    if (!c) return
    c.upBytes = up
    c.downBytes = down
  }

  close(id: number, reason: 'client' | 'remote' | 'kicked' | 'shutdown' | 'error', up: number, down: number): void {
    const c = this.conns.get(id)
    this.conns.delete(id)
    if (!c) return
    try {
      this.db.run('UPDATE node_connections SET closed_at = ?, up_bytes = ?, down_bytes = ?, close_reason = ? WHERE id = ?', [
        Date.now(),
        up,
        down,
        reason,
        id,
      ])
    } catch {
      /* ignore */
    }
  }

  list(): ActiveConn[] {
    return [...this.conns.values()]
  }

  count(): number {
    return this.conns.size
  }

  byNode(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const c of this.conns.values()) out[c.nodeId] = (out[c.nodeId] ?? 0) + 1
    return out
  }

  byIp(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const c of this.conns.values()) out[c.clientIp] = (out[c.clientIp] ?? 0) + 1
    return out
  }

  /** 每 30s 落活跃快照（§6.6） */
  snapshot(): void {
    for (const c of this.conns.values()) {
      try {
        this.db.run('UPDATE node_connections SET up_bytes = ?, down_bytes = ? WHERE id = ?', [c.upBytes, c.downBytes, c.id])
      } catch {
        /* ignore */
      }
    }
  }

  /** 进程重启后清理悬挂连接（它们是上一次运行的残留） */
  reapOrphans(): number {
    const r = this.db.run("UPDATE node_connections SET closed_at = ?, close_reason = 'shutdown' WHERE closed_at IS NULL", [Date.now()])
    return r.changes
  }

  trimHistory(days = 7): number {
    const r = this.db.run('DELETE FROM node_connections WHERE closed_at IS NOT NULL AND closed_at < ?', [Date.now() - days * 86400_000])
    return r.changes
  }

  log(level: 'info' | 'warn' | 'error', msg: string, detail?: unknown): void {
    if (level === 'error') this.events.error('gateway.error', msg, { detail })
    else if (level === 'warn') this.events.warn('gateway.warn', msg, { detail })
    else this.events.info('gateway.info', msg, { detail })
  }
}
