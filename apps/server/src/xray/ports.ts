import type { Db } from '../core/db'
import { AppError } from '../core/errors'
import type { SettingsStore } from '../core/settings'
import { and, count, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { nodePort } from '../core/schema'

export interface PortPoolStats { pool: number; used: number; cooling: number; start: number; end: number }

interface PortRow { node_id: string; port: number; assigned_at: number; released_at: number | null; reusable_at: number | null }

/**
 * 端口池（PANEL.md D3）：
 * - 取当前最小可用端口；
 * - 删除节点时先标记 released_at，冷却 portCooldownSec 后才回到可用池（规避 TIME_WAIT）。
 */
export class PortPool {
  constructor(private db: Db, private settings: SettingsStore) {}

  private range(): { start: number; end: number } {
    const s = this.settings.get().xray
    return { start: s.inboundPortStart, end: s.inboundPortEnd }
  }

  /** 把冷却到期的行清掉，使其端口重新可用 */
  reap(now = Date.now()): number {
    const r = this.db
      .delete(nodePort)
      .where(and(isNotNull(nodePort.released_at), isNotNull(nodePort.reusable_at), lte(nodePort.reusable_at, now)))
      .run()
    return r.changes
  }

  portOf(nodeId: string): number | undefined {
    const row: PortRow | undefined = this.db.select().from(nodePort).where(eq(nodePort.node_id, nodeId)).get()
    return row && row.released_at === null ? row.port : undefined
  }

  /** 幂等：已有则返回，否则分配最小可用端口 */
  ensure(nodeId: string, now = Date.now()): number {
    this.reap(now)
    const existing: PortRow | undefined = this.db.select().from(nodePort).where(eq(nodePort.node_id, nodeId)).get()
    if (existing && existing.released_at === null) return existing.port
    const { start, end } = this.range()
    const taken = new Set(this.db.select({ port: nodePort.port }).from(nodePort).all().map((r) => r.port))
    for (let p = start; p <= end; p++) {
      if (!taken.has(p)) {
        if (existing) {
          this.db
            .update(nodePort)
            .set({ port: p, assigned_at: now, released_at: null, reusable_at: null })
            .where(eq(nodePort.node_id, nodeId))
            .run()
        } else {
          this.db.insert(nodePort).values({ node_id: nodeId, port: p, assigned_at: now }).run()
        }
        return p
      }
    }
    throw new AppError('port_pool_exhausted', `端口池已耗尽（${start}-${end}），无法为节点 ${nodeId} 分配环回端口`, 409)
  }

  /** 释放：不立刻回收，进入冷却（D3） */
  release(nodeId: string, now = Date.now()): void {
    const cooldownSec = this.settings.get().xray.portCooldownSec
    this.db
      .update(nodePort)
      .set({ released_at: now, reusable_at: now + cooldownSec * 1000 })
      .where(and(eq(nodePort.node_id, nodeId), isNull(nodePort.released_at)))
      .run()
  }

  /** 立即彻底删除（端口池重建/回滚时使用） */
  forget(nodeId: string): void {
    this.db.delete(nodePort).where(eq(nodePort.node_id, nodeId)).run()
  }

  stats(now = Date.now()): PortPoolStats {
    const { start, end } = this.range()
    const used = this.db.select({ n: count() }).from(nodePort).where(isNull(nodePort.released_at)).get()?.n ?? 0
    const cooling =
      this.db
        .select({ n: count() })
        .from(nodePort)
        .where(and(isNotNull(nodePort.released_at), or(isNull(nodePort.reusable_at), gt(nodePort.reusable_at, now))))
        .get()?.n ?? 0
    return { pool: end - start + 1, used, cooling, start, end }
  }

  /**
   * 探测「尚未分配」的前 N 个端口是否可 bind（PANEL.md §14.2#3）。
   * 注意必须跳过已经在 node_port 里的端口：它们被现有节点的环回入站占用是**预期行为**，
   * 拿它们去 bind 必然失败，会把健康检查误报成 degraded。
   */
  async probeBindable(count = 8): Promise<{ port: number; ok: boolean }[]> {
    const { start, end } = this.range()
    const reserved = new Set(this.db.select({ port: nodePort.port }).from(nodePort).all().map((r) => r.port))
    const out: { port: number; ok: boolean }[] = []
    for (let port = start; port <= end && out.length < count; port++) {
      if (reserved.has(port)) continue
      out.push({ port, ok: await canBind(port) })
    }
    return out
  }
}

export async function canBind(port: number, hostname = '127.0.0.1'): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname, port, fetch: () => new Response('ok') })
    server.stop(true)
    return true
  } catch {
    return false
  }
}
