import { t } from 'elysia'

export const gatewayKickBody = t.Object({
  nodeId: t.Optional(t.String()),
  username: t.Optional(t.String()),
  ip: t.Optional(t.String()),
  connId: t.Optional(t.Number()),
})

