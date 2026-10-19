import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type { Db } from './db'
import type { EventBus } from './events'
import { nodeConnections } from './schema'

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
      this.db
        .insert(nodeConnections)
        .values({
          id,
          node_id: info.nodeId,
          username: info.username,
          client_ip: info.clientIp,
          target: info.target,
          started_at: conn.startedAt,
          up_bytes: 0,
          down_bytes: 0,
        })
        .run()
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
      this.db
        .update(nodeConnections)
        .set({ closed_at: Date.now(), up_bytes: up, down_bytes: down, close_reason: reason })
        .where(eq(nodeConnections.id, id))
        .run()
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
        this.db
          .update(nodeConnections)
          .set({ up_bytes: c.upBytes, down_bytes: c.downBytes })
          .where(eq(nodeConnections.id, c.id))
          .run()
      } catch {
        /* ignore */
      }
    }
  }

  /** 进程重启后清理悬挂连接（它们是上一次运行的残留） */
  reapOrphans(): number {
    const r = this.db
      .update(nodeConnections)
      .set({ closed_at: Date.now(), close_reason: 'shutdown' })
      .where(isNull(nodeConnections.closed_at))
      .run()
    return r.changes
  }

  trimHistory(days = 7): number {
    const r = this.db
      .delete(nodeConnections)
      .where(and(isNotNull(nodeConnections.closed_at), lt(nodeConnections.closed_at, Date.now() - days * 86400_000)))
      .run()
    return r.changes
  }

  log(level: 'info' | 'warn' | 'error', msg: string, detail?: unknown): void {
    if (level === 'error') this.events.error('gateway.error', msg, { detail })
    else if (level === 'warn') this.events.warn('gateway.warn', msg, { detail })
    else this.events.info('gateway.info', msg, { detail })
  }
}
