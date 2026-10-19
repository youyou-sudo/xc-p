import { t } from 'elysia'

export const runtimePublishBody = t.Object({
  dryRun: t.Optional(t.Boolean()),
})

export const runtimeReconcileBody = t.Object({
  dryRun: t.Optional(t.Boolean()),
})

export const runtimeRollbackBody = t.Object({
  revisionId: t.String({ minLength: 1 }),
})

