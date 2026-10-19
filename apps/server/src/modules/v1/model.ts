import { t } from 'elysia'

export const v1SyncBody = t.Object({
  subscriptionId: t.Optional(t.String()),
})

export const v1DetectBody = t.Object({
  nodeIds: t.Optional(t.Array(t.String())),
  depth: t.Optional(t.Union([t.Literal('lite'), t.Literal('full')])),
})

