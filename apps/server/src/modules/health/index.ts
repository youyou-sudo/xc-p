import { Elysia } from 'elysia'
import type { AppContext } from '../../context'

/** 健康检查（/api/health，公开）。 */
export function healthModule(ctx: AppContext) {
  return new Elysia({ name: 'api/health', prefix: '/api' }).get('/health', () => ctx.health())
}
