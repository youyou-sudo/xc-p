import type { AppContext } from '../../context'
import type { ApiKeyPrincipal } from '../auth/service'
import { clientIp, requestId } from '../../core/http'

export type V1AuthResult = { principal?: ApiKeyPrincipal; error?: Response }

/** 服务 API（/v1）的 Bearer API Key 鉴权。 */
export function createV1Auth(ctx: AppContext) {
  return (request: Request): V1AuthResult => {
    const r = ctx.auth.verifyApiKey(request.headers.get('authorization') ?? undefined, clientIp(request))
    if (!r.principal) {
      const code = r.reason === 'missing' || r.reason === 'invalid' ? 401 : r.reason === 'rate_limited' ? 429 : 403
      const msg =
        r.reason === 'rate_limited'
          ? '超过该 Key 的每分钟限流'
          : r.reason === 'revoked'
            ? 'Key 已吊销'
            : r.reason === 'expired'
              ? 'Key 已过期'
              : r.reason === 'ip_denied'
                ? 'IP 不在白名单'
                : '缺少或无效的 API Key'
      return {
        error: new Response(JSON.stringify({ error: { code: r.reason ?? 'unauthorized', message: msg } }), {
          status: code,
          headers: { 'content-type': 'application/json', 'x-request-id': requestId() },
        }),
      }
    }
    return { principal: r.principal }
  }
}

/** v1 的 scope 不足时返回 403（保持 /v1 原有错误体，而不是面板的错误体）。 */
export function forbiddenResponse(scope: string): Response {
  return new Response(JSON.stringify({ error: { code: 'forbidden', message: '缺少 scope: ' + scope } }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId() },
  })
}