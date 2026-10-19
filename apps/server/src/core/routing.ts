import { count, desc, notInArray } from 'drizzle-orm'
import type { Db } from './db'
import { digestOf } from './ids'
import { gatewayRoutes } from './schema'

export interface RouteEntry { nodeId: string; port: number; username: string; tag?: string }

/**
 * 网关路由表：username（节点 ID 或 alias）→ nodeId → 环回端口。
 * 单线程内一次对象替换（atomic swap），因此热更新对在读连接零影响（PANEL.md D2 步骤 3）。
 */
export class RoutingTable {
  private table = new Map<string, RouteEntry>()

  constructor(private db?: Db) {}

  put(entry: RouteEntry): void {
    const next = new Map(this.table)
    next.set(entry.username, entry)
    if (entry.nodeId !== entry.username) next.set(entry.nodeId, entry)
    this.table = next
  }

  delete(username: string): void {
    const next = new Map(this.table)
    next.delete(username)
    this.table = next
  }

  get(username: string): RouteEntry | undefined {
    return this.table.get(username)
  }

  has(username: string): boolean {
    return this.table.has(username)
  }

  snapshot(): RouteEntry[] {
    const seen = new Set<string>()
    const out: RouteEntry[] = []
    for (const e of this.table.values()) {
      if (seen.has(e.nodeId)) continue
      seen.add(e.nodeId)
      out.push(e)
    }
    return out
  }

  size(): number {
    return this.snapshot().length
  }

  replace(entries: RouteEntry[]): void {
    const next = new Map<string, RouteEntry>()
    for (const e of entries) {
      next.set(e.username, e)
      if (e.nodeId !== e.username) next.set(e.nodeId, e)
    }
    this.table = next
  }

  /** 持久化到 gateway_routes（控制面重启后恢复，PANEL.md §9.3） */
  persist(): void {
    if (!this.db) return
    const entries = this.snapshot()
    this.db
      .insert(gatewayRoutes)
      .values({ updated_at: Date.now(), table_json: JSON.stringify(entries), digest: digestOf(entries) })
      .run()
    const keep = this.db.select({ n: count() }).from(gatewayRoutes).get()
    if ((keep?.n ?? 0) > 20) {
      this.db
        .delete(gatewayRoutes)
        .where(
          notInArray(
            gatewayRoutes.id,
            this.db.select({ id: gatewayRoutes.id }).from(gatewayRoutes).orderBy(desc(gatewayRoutes.id)).limit(20)
          )
        )
        .run()
    }
  }

  restoreFromDb(): number {
    if (!this.db) return 0
    const row = this.db
      .select({ table_json: gatewayRoutes.table_json })
      .from(gatewayRoutes)
      .orderBy(desc(gatewayRoutes.id))
      .limit(1)
      .get()
    if (!row) return 0
    try {
      const entries = JSON.parse(row.table_json) as RouteEntry[]
      this.replace(entries)
      return entries.length
    } catch {
      return 0
    }
  }
}
