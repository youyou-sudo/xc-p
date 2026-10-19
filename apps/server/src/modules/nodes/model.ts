import { t } from 'elysia'

export const nodePatchBody = t.Object({
  displayName: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  countryCode: t.Optional(t.Union([t.String(), t.Null()])),
  region: t.Optional(t.Union([t.String(), t.Null()])),
  publishPolicyOverride: t.Optional(t.Any()),
  checkDepth: t.Optional(t.Union([t.Literal('lite'), t.Literal('full')])),
  rename: t.Optional(t.String()),
})

export const nodeCheckBody = t.Object({
  depth: t.Optional(t.Union([t.Literal('lite'), t.Literal('full')])),
})

export const nodeCheckBatchBody = t.Object({
  nodeIds: t.Optional(t.Array(t.String())),
  depth: t.Optional(t.Union([t.Literal('lite'), t.Literal('full')])),
})

