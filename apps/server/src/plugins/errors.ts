import { Elysia, ParseError, ValidationError } from 'elysia'
import { errorBody, statusOf } from '../core/errors'
import { logger } from '../core/log'
import { serveWebAsset } from '../web/serve'

/**
 * 全局错误处理（as: 'global'，对所有模块生效）：
 * - 非 /api、/v1 的 404 交给嵌入的 Furin 面板端点做 SPA 回落；
 * - AppError → 统一错误体 { error: { code, message, detail? } }；
 * - 5xx 记录服务端日志。
 */
export const errorPlugin = new Elysia({ name: 'errors' }).onError({ as: 'global' }, async ({ error, set, request }) => {
  const url = new URL(request.url)
  if ((error as any)?.code === 'NOT_FOUND' && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/v1')) {
    const response = serveWebAsset(url.pathname, request)
    if (response.status === 200) {
      set.status = 200
      // 仅收敛类型：运行时仍返回 Response（见 @xc-p/api-client 的 ApiData）
      return response as unknown as ReturnType<typeof errorBody>
    }
  }
  // 请求校验/解析失败是客户端错误，映射为 422/400（而不是 500）
  if (error instanceof ValidationError) {
    set.status = 422
    return { error: { code: 'validation_failed', message: error.message || '请求参数校验失败', detail: error.all } }
  }
  if (error instanceof ParseError) {
    set.status = 400
    return { error: { code: 'bad_request', message: error.message || '请求体解析失败' } }
  }
  const code = statusOf(error)
  set.status = code
  if (code >= 500) logger.error('api error ' + url.pathname, error instanceof Error ? error.stack : String(error))
  return errorBody(error)
})