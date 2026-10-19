import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import type { createSessionPlugin } from '../../plugins/session'
import { gatewayKickBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 网关模块（/api/gateway）：连接列表与踢线。 */
export function gatewayModule(ctx: AppContext, session: SessionPlugin) {
  const { db, conns, auth } = ctx
  return new Elysia({ name: 'api/gateway', prefix: '/api' })
    .use(session)
    .get('/gateway/connections', () => ({
      active: conns.list(),
      byNode: conns.byNode(),
      byIp: conns.byIp(),
      stats: ctx.gateway ? ctx.gateway.stats() : null,
      recent: db.all('SELECT * FROM node_connections ORDER BY started_at DESC LIMIT 100'),
    }), { requireSession: true })
    .post(
      '/gateway/kick',
      ({ body }) => {
        const n = ctx.kick({ nodeId: body.nodeId, username: body.username, ip: body.ip, connId: body.connId })
        auth.audit('panel', 'admin', 'gateway.kick', body.nodeId ?? body.username ?? body.ip ?? String(body.connId ?? ''), null, { closed: n })
        return { ok: true, closed: n }
      },
      { body: gatewayKickBody, requireSession: true },
    )
}
