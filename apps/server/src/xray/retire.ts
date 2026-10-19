import type { Db } from '../core/db'
import { randomId } from '../core/ids'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import type { XrayCli } from './cli'
import { and, asc, count, eq, inArray, isNull, lte } from 'drizzle-orm'
import { pendingRetire, xrayApplyOps } from '../core/schema'

export interface RetireItem {
  id: string
  kind: 'outbound' | 'inbound' | 'rule'
  tag: string
  node_id: string | null
  revision_id: string | null
  retire_after: number
  done_at: number | null
  error: string | null
}

/**
 * 延迟退休队列（PANEL.md D2 步骤 6 / §9.2 阶段 B）：
 * 旧 outbound 不立刻 rmo，给在途连接一个自然收尾窗口。
 */
export class RetireQueue {
  constructor(
    private db: Db,
    private cli: XrayCli,
    private settings: SettingsStore,
    private events: EventBus,
  ) {}

  enqueue(items: { kind: RetireItem['kind']; tag: string; nodeId?: string | null; revisionId?: string | null }[]): void {
    const delay = this.settings.get().xray.retireDelayMs
    const now = Date.now()
    for (const it of items) {
      if (!it.tag) continue
      // 同一个 tag 可能因为「对账 + 发布」重复进入删除计划，避免排队两次。
      const existing = this.db
        .select({ id: pendingRetire.id })
        .from(pendingRetire)
        .where(and(eq(pendingRetire.kind, it.kind), eq(pendingRetire.tag, it.tag), isNull(pendingRetire.done_at)))
        .limit(1)
        .get()
      if (existing) continue
      this.db
        .insert(pendingRetire)
        .values({
          id: randomId('ret_'),
          kind: it.kind,
          tag: it.tag,
          node_id: it.nodeId ?? null,
          revision_id: it.revisionId ?? null,
          retire_after: now + delay,
          done_at: null,
          error: null,
        })
        .run()
    }
  }

  due(now = Date.now(), limit = 200): RetireItem[] {
    return this.db
      .select()
      .from(pendingRetire)
      .where(and(isNull(pendingRetire.done_at), lte(pendingRetire.retire_after, now)))
      .orderBy(asc(pendingRetire.retire_after))
      .limit(limit)
      .all() as RetireItem[]
  }

  list(limit = 200): RetireItem[] {
    return this.db
      .select()
      .from(pendingRetire)
      .where(isNull(pendingRetire.done_at))
      .orderBy(asc(pendingRetire.retire_after))
      .limit(limit)
      .all() as RetireItem[]
  }

  count(): number {
    return this.db.select({ n: count() }).from(pendingRetire).where(isNull(pendingRetire.done_at)).get()?.n ?? 0
  }

  /** 已在队列里、尚未完成的 tag（对账时视为已知过渡态，不算漂移） */
  pendingTags(): Set<string> {
    const rows = this.db.select({ tag: pendingRetire.tag }).from(pendingRetire).where(isNull(pendingRetire.done_at)).all()
    return new Set(rows.map((r) => r.tag))
  }

  /**
   * 节点在退休窗口内被重新加入数据面（检测按需补建 / 对账重放）时，取消对应 tag 的待删除；
   * 否则到点的 rmo 会把刚恢复的 outbound 删掉，造成「刚检查可用、随后又漂移」。
   */
  cancelTags(tags: string[]): void {
    if (tags.length === 0) return
    this.db
      .update(pendingRetire)
      .set({ done_at: Date.now(), error: null })
      .where(and(inArray(pendingRetire.tag, tags), isNull(pendingRetire.done_at)))
      .run()
  }

  /** tag 已经被移除（幂等成功）：xray api 对不存在的 tag 会报错，按文案识别 */
  private alreadyGone(stderr: string): boolean {
    return /not found|not exist|no such|unknown|already|does not exist|failed to find|cannot find/i.test(stderr)
  }

  /** 当前数据面真实存在的 outbound tag；接口不可达时返回 null（保持 pending 重试） */
  private async currentOutboundTags(): Promise<Set<string> | null> {
    try {
      const res = await this.cli.lso()
      if (!res.result.ok) return null
      return new Set(res.outbounds.map((o) => o.tag))
    } catch {
      return null
    }
  }

  /**
   * 执行到期的删除（每 30s 由调度器调用一次，PANEL.md §13）。
   * 失败时不能标记 done——否则 tag 会永久留在数据面，漂移再也清不掉；
   * 这里保留 pending 并在 60s 后重试，下一轮调度会继续处理。
   */
  async processDue(now = Date.now()): Promise<number> {
    const items = this.due(now)
    if (items.length === 0) return 0
    let done = 0
    const RETRY_MS = 60_000
    const outbounds = items.filter((i) => i.kind === 'outbound')
    const others = items.filter((i) => i.kind !== 'outbound')
    if (outbounds.length) {
      const tags = outbounds.map((i) => i.tag)
      const started = Date.now()
      const res = await this.cli.rmo(tags)
      this.db
        .insert(xrayApplyOps)
        .values({
          revision_id: outbounds[0]!.revision_id,
          at: started,
          op: 'rmo',
          tag: tags.join(','),
          payload_json: JSON.stringify(tags),
          ok: res.ok ? 1 : 0,
          duration_ms: res.durationMs,
          stdout: res.stdout.slice(0, 4000),
          stderr: res.stderr.slice(0, 4000),
          error_kind: res.errorKind ?? null,
        })
        .run()
      if (res.ok) {
        for (const it of outbounds) {
          this.db.update(pendingRetire).set({ done_at: Date.now(), error: null }).where(eq(pendingRetire.id, it.id)).run()
          done++
        }
      } else if (this.alreadyGone(res.stderr)) {
        // 数据面已经不存在这些 tag（例如外部重启/被手动清理），视为完成。
        for (const it of outbounds) {
          this.db
            .update(pendingRetire)
            .set({ done_at: Date.now(), error: res.stderr.slice(0, 500) })
            .where(eq(pendingRetire.id, it.id))
            .run()
          done++
        }
      } else {
        // 面板重启后数据面通常已经用「启动骨架配置 + 期望状态重放」重建，
        // 待退休的旧 tag 根本不存在了。此时 xray 的报错文案不一定包含 not found，
        // 必须用 lso 实际确认：不在数据面的直接视为完成，避免 pending 永久卡住。
        const present = await this.currentOutboundTags()
        const gone = present ? outbounds.filter((it) => !present.has(it.tag)) : []
        const remaining = present ? outbounds.filter((it) => present.has(it.tag)) : outbounds
        for (const it of gone) {
          this.db
            .update(pendingRetire)
            .set({ done_at: Date.now(), error: 'rmo 时 tag 已不在数据面（视为已完成）' })
            .where(eq(pendingRetire.id, it.id))
            .run()
          done++
        }
        for (const it of remaining) {
          this.db
            .update(pendingRetire)
            .set({ error: res.stderr.slice(0, 500), retire_after: Date.now() + RETRY_MS })
            .where(eq(pendingRetire.id, it.id))
            .run()
        }
        if (remaining.length > 0) {
          this.events.warn('xray.retire_retry', `延迟退休 rmo 失败，60 秒后重试：${res.stderr.slice(0, 200)}`, {
            detail: { tags: remaining.map((it) => it.tag) },
          })
        }
      }
    }
    for (const it of others) {
      const res = it.kind === 'inbound' ? await this.cli.rmi([it.tag]) : await this.cli.rmrules([it.tag])
      if (res.ok || this.alreadyGone(res.stderr)) {
        this.db
          .update(pendingRetire)
          .set({ done_at: Date.now(), error: res.ok ? null : res.stderr.slice(0, 500) })
          .where(eq(pendingRetire.id, it.id))
          .run()
        done++
      } else {
        this.db
          .update(pendingRetire)
          .set({ error: res.stderr.slice(0, 500), retire_after: Date.now() + RETRY_MS })
          .where(eq(pendingRetire.id, it.id))
          .run()
      }
    }
    return done
  }

  /** all-time ado+rmo 计数（D5：热操作泄漏阈值） */
  hotOpsTotal(): number {
    const row = this.db
      .select({ n: count() })
      .from(xrayApplyOps)
      .where(and(inArray(xrayApplyOps.op, ['ado', 'rmo']), eq(xrayApplyOps.ok, 1)))
      .get()
    return row?.n ?? 0
  }
}
