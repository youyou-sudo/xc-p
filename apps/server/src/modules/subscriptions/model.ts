import { t } from 'elysia'

/**
 * 同步间隔的 wire 语义（与面板「留空 = 手动同步」一致）：
 * - 省略字段：使用 settings.subsync.defaultIntervalSec；
 * - null：手动同步，落库为 interval_sec NULL，调度器跳过；
 * - number：按秒调度。
 */
const intervalSec = t.Optional(t.Union([t.Number(), t.Null()]))

export const subscriptionCreateBody = t.Object({
  name: t.String({ minLength: 1 }),
  url: t.Optional(t.String()),
  text: t.Optional(t.String()),
  formatHint: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  intervalSec,
  cron: t.Optional(t.Union([t.String(), t.Null()])),
  timeoutMs: t.Optional(t.Number()),
  retries: t.Optional(t.Number()),
  retryBackoffMs: t.Optional(t.Number()),
  headers: t.Optional(t.Any()),
  userAgent: t.Optional(t.Union([t.String(), t.Null()])),
})

export const subscriptionUpdateBody = t.Object({
  name: t.Optional(t.String()),
  url: t.Optional(t.String()),
  text: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  formatHint: t.Optional(t.String()),
  intervalSec,
  cron: t.Optional(t.Union([t.String(), t.Null()])),
  timeoutMs: t.Optional(t.Number()),
  retries: t.Optional(t.Number()),
  userAgent: t.Optional(t.Union([t.String(), t.Null()])),
})

export const subscriptionPreviewBody = t.Object({
  text: t.String(),
  formatHint: t.Optional(t.String()),
})

