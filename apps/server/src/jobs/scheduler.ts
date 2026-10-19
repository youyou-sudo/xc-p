import { Cron } from 'croner'
import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { nodes } from '../core/schema'
import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { logger } from '../core/log'

export interface ScheduledTask {
  name: string
  everyMs: number
  run: () => Promise<void> | void
  lastRun?: number
  running?: boolean
}

/**
 * 单进程内调度器（PANEL.md §13 / 附录 D：自研 + croner）。
 * 订阅每订阅独立 interval/cron；检测全局 interval + 每节点 next_check_at 抖动；
 * 对账巡检 5 分钟；退休队列 30s；维护窗口每日；清理每日。
 */
export class Scheduler {
  private tasks: ScheduledTask[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private crons: Cron[] = []
  private tickMs = 1000

  add(name: string, opts: { everySec?: number; everyMs?: number; cron?: string }, run: () => Promise<void> | void): void {
    if (opts.cron) {
      const job = new Cron(opts.cron, () => {
        void this.execute({ name, everyMs: 0, run })
      })
      this.crons.push(job)
      return
    }
    const everyMs = opts.everyMs ?? (opts.everySec ?? 60) * 1000
    this.tasks.push({ name, everyMs, run })
  }

  private async execute(task: ScheduledTask): Promise<void> {
    if (task.running) return
    task.running = true
    try {
      await task.run()
      task.lastRun = Date.now()
    } catch (e) {
      logger.error('scheduled task failed: ' + task.name, e instanceof Error ? e.message : String(e))
    } finally {
      task.running = false
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const t of this.tasks) {
        if (now - (t.lastRun ?? 0) >= t.everyMs) void this.execute(t)
      }
    }, this.tickMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as any).unref()
    logger.info('scheduler started with ' + this.tasks.length + ' interval tasks and ' + this.crons.length + ' cron tasks')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const c of this.crons) c.stop()
    this.crons = []
  }

  list(): { name: string; everyMs: number; lastRun: number | null; running: boolean }[] {
    return this.tasks.map((t) => ({ name: t.name, everyMs: t.everyMs, lastRun: t.lastRun ?? null, running: !!t.running }))
  }
}

/** 维护窗口检查：每日 xray.maintenanceWindow 检查热操作计数（D5 / §13） */
export function inMaintenanceWindow(window: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(window)
  if (!m) return false
  const hour = Number.parseInt(m[1]!, 10)
  const minute = Number.parseInt(m[2]!, 10)
  return now.getHours() === hour && now.getMinutes() === minute
}

export function staleExpiryTask(db: Db, settings: SettingsStore, events: EventBus): () => number {
  return () => {
    if (!settings.get().publish.autoRemoveStale) return 0
    const now = Date.now()
    const r = db
      .update(nodes)
      .set({ enabled: 0, updated_at: now })
      .where(
        and(
          eq(nodes.enabled, 1),
          isNotNull(nodes.missing_since),
          isNotNull(nodes.stale_until),
          lte(nodes.stale_until, now)
        )
      )
      .run()
    if (r.changes > 0) events.warn('node.stale_expired', r.changes + ' 个节点超过 stale 保留期，已置 enabled=0（下次发布从数据面移除）')
    return r.changes
  }
}
