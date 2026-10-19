import { t } from 'elysia'

export const createKeyBody = t.Object({
  name: t.String({ minLength: 1 }),
  scopes: t.Optional(t.Array(t.String())),
  ipAllowlist: t.Optional(t.Any()),
  rateLimitPerMin: t.Optional(t.Number()),
  expiresAt: t.Optional(t.Union([t.Number(), t.Null()])),
})

