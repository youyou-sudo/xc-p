import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { ALL_SCOPES, type Scope } from '../auth/service'
import type { createSessionPlugin } from '../../plugins/session'
import { createKeyBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** API Key 模块（/api/keys）：明文只返回一次。 */
export function keysModule(ctx: AppContext, session: SessionPlugin) {
  const { auth } = ctx
  return new Elysia({ name: 'api/keys', prefix: '/api' })
    .use(session)
    .get('/keys', () => ({ items: auth.listApiKeys(), scopes: ALL_SCOPES }), { requireSession: true })
    .post(
      '/keys',
      ({ body }) => {
        const scopes = (body.scopes ?? ['read']).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s))
        const created = auth.createApiKey({
          name: body.name,
          scopes: scopes.length ? scopes : ['read'],
          ipAllowlist: body.ipAllowlist,
          rateLimitPerMin: body.rateLimitPerMin,
          expiresAt: body.expiresAt ?? null,
        })
        return { id: created.id, prefix: created.prefix, plaintext: created.plaintext, notice: '明文只显示这一次' }
      },
      { body: createKeyBody, requireSession: true },
    )
    .delete('/keys/:id', ({ params }) => ({ ok: auth.revokeApiKey(params.id) }), { requireSession: true })
}