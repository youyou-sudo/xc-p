import { Elysia } from 'elysia'
import type { AuthService } from '../modules/auth/service'
import { AppError } from '../core/errors'

export const SESSION_COOKIE = 'xcp_session'

type CookieBag = Record<string, { value?: unknown } | undefined>

function tokenOf(cookie: CookieBag): string | undefined {
  const value = cookie[SESSION_COOKIE]?.value
  return typeof value === 'string' ? value : undefined
}

/** 供 /api/auth/me、/api/stream 等需要自行处理「未登录」的端点使用。 */
export function sessionOf(auth: AuthService, cookie: CookieBag) {
  return auth.session(tokenOf(cookie))
}

/**
 * 会话鉴权插件：以 macro 的形式暴露 `requireSession`，
 * 路由用 `{ requireSession: true }` 声明依赖，未登录时由全局 onError 映射为 401。
 */
export function createSessionPlugin(auth: AuthService) {
  return new Elysia({ name: 'session' }).macro({
    requireSession: {
      resolve: ({ cookie }) => {
        const session = sessionOf(auth, cookie as CookieBag)
        if (!session) throw new AppError('unauthorized', '未登录或会话已过期', 401)
        return { session }
      },
    },
  })
}