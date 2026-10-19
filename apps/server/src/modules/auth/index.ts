import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { clientIp } from '../../core/http'
import { SESSION_COOKIE, sessionOf, type createSessionPlugin } from '../../plugins/session'
import { loginBody, passwordChangeBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/**
 * 面板鉴权模块（/api/auth）。
 * - login/logout/me 为公开端点（me 自己返回 authenticated 布尔值）；
 * - password 通过 requireSession macro 保护。
 */
export function authModule(ctx: AppContext, session: SessionPlugin) {
  const { auth } = ctx
  return new Elysia({ name: 'api/auth', prefix: '/api' })
    .use(session)
    .post(
      '/auth/login',
      async ({ body, cookie, request, set }) => {
        const r = await auth.login(body.username, body.password, clientIp(request), request.headers.get('user-agent') ?? '')
        if (!r) {
          set.status = 401
          return { error: { code: 'unauthorized', message: '用户名或密码错误' } }
        }
        cookie[SESSION_COOKIE]!.set({
          value: r.token,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: Math.floor((r.expiresAt - Date.now()) / 1000),
        })
        return { ok: true, username: body.username, expiresAt: r.expiresAt }
      },
      { body: loginBody },
    )
    .post('/auth/logout', ({ cookie }) => {
      const token = cookie[SESSION_COOKIE]?.value as string | undefined
      if (token) auth.logout(token)
      cookie[SESSION_COOKIE]!.remove()
      return { ok: true }
    })
    .get('/auth/me', ({ cookie }) => {
      const s = sessionOf(auth, cookie as Record<string, { value?: unknown } | undefined>)
      return s ? { authenticated: true as const, username: s.username, csrf: 'origin-checked' } : { authenticated: false as const }
    })
    .post(
      '/auth/password',
      async ({ cookie, body, request }) => {
        const token = cookie[SESSION_COOKIE]?.value as string | undefined
        const r = await auth.changePassword(body.currentPassword, body.newPassword, token)
        if (!r.ok) throw new AppError('validation_failed', r.error ?? '修改失败', 422)
        auth.audit('panel', 'admin', 'auth.password_change', null, clientIp(request), null)
        return { ok: true }
      },
      { body: passwordChangeBody, requireSession: true },
    )
}