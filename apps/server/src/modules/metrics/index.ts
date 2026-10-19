import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { prometheus } from './service'

/** Prometheus 指标端点（/api/metrics，默认可公开抓取，可在设置里关闭）。 */
export function metricsModule(ctx: AppContext) {
  return new Elysia({ name: 'api/metrics', prefix: '/api' }).get('/metrics', ({ set }) => {
    if (!ctx.settings.get().metrics.enabled) {
      set.status = 404
      return 'metrics disabled'
    }
    set.headers['content-type'] = 'text/plain; version=0.0.4'
    return prometheus(ctx)
  })
}
