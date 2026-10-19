import type { AppContext } from '../../context'
import { APPLY_QUEUE } from '../../jobs/queue'
import { buildDesiredNodes } from '../../publish/desired'

/** 入队一次对账任务（apply=true）：节点删除/批量清理后清理数据面残留。 */
export function enqueueReconcileJob(ctx: AppContext, detail: Record<string, unknown>): string {
  return ctx.jobs.enqueue(APPLY_QUEUE, 'reconcile', detail, 'panel', async () => {
    const snap = buildDesiredNodes(ctx.db, ctx.settings, ctx.ports)
    const applied = ctx.publisher.appliedNodes()
    const r = await ctx.reconciler.reconcile(snap.desired, applied, { apply: true })
    return {
      consistent: r.consistent,
      drift: r.drift,
      applied: r.applied,
      add: r.plan.add.length,
      remove: r.plan.remove.length,
      cleanup: r.plan.cleanup.length,
      change: r.plan.change.length,
    }
  })
}
