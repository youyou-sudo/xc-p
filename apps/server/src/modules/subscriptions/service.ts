import type { AppContext } from '../../context'
import { nodes as nodesT } from '../../core/schema'
import { Semaphore } from '../../detect/detect'
import type { SubFormatHint } from '../../sub/types'

const FORMAT_HINTS = new Set<string>(['auto', 'base64', 'clash', 'singbox', 'xray', 'links'])

/** 把 DB/请求里的宽松字符串收敛为解析器支持的格式提示；未知值回退 auto。 */
export function normalizeFormatHint(value: string | undefined): SubFormatHint {
  return value && FORMAT_HINTS.has(value) ? (value as SubFormatHint) : 'auto'
}

/**
 * intervalSec 的落库语义（PANEL.md §7.6：interval_sec 可为 NULL）：
 * - undefined（字段缺省）→ 系统默认间隔；
 * - null（面板「留空 = 手动同步」）→ 保持 NULL，不进入定时调度；
 * - number → 按秒调度。
 */
export function resolveIntervalSec(value: number | null | undefined, fallback: number): number | null {
  return value === undefined ? fallback : value
}

/**
 * 订阅模块服务：收敛同步任务的并发控制、任务入队与预览差异计算，
 * 控制器（index.ts）只负责 HTTP 参数与响应。
 */
export function createSubscriptionsService(ctx: AppContext) {
  const semaphore = new Semaphore(ctx.settings.get().subsync.concurrency)

  /** 入队单个订阅同步（§5：任务类接口立即返回 jobId）。 */
  const enqueueSync = (subscriptionId: string, trigger: 'manual' | 'cron' | 'api'): string =>
    ctx.jobs.enqueue('sync:' + subscriptionId, 'sync', { subscriptionId, trigger }, trigger === 'api' ? 'apikey' : 'panel', async (_id, jctx) => {
      jctx.setProgress(0, 1, '拉取订阅 ' + subscriptionId)
      const result = await semaphore.run(() => ctx.sync.runSync(subscriptionId, trigger))
      if (ctx.settings.get().subsync.autoPublishAfterSync && result.status === 'ok') {
        await ctx.publisher.publish({ reason: 'post_sync' })
      }
      return result
    })

  /** 预览解析结果与现有节点的差异。 */
  const previewDiff = (nodes: { fingerprint: string; protocolSupported: boolean }[]) => {
    const existing = new Set(ctx.db.select({ fingerprint: nodesT.fingerprint }).from(nodesT).all().map((r) => r.fingerprint))
    const incoming = new Set(nodes.map((n) => n.fingerprint))
    return {
      added: nodes.filter((n) => !existing.has(n.fingerprint)).length,
      unchanged: nodes.filter((n) => existing.has(n.fingerprint)).length,
      removed: [...existing].filter((f) => !incoming.has(f)).length,
      unsupported: nodes.filter((n) => !n.protocolSupported).length,
    }
  }

  return {
    semaphore,
    enqueueSync,
    previewDiff,
    setConcurrency: (n: number) => semaphore.setLimit(n),
  }
}

export type SubscriptionsService = ReturnType<typeof createSubscriptionsService>
