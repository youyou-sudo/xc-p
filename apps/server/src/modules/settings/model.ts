import { t } from 'elysia'

/**
 * /api/settings/test 的可选探测目标；省略 body 或 what = 全部探测。
 * body 整体可选，保持旧客户端「空 body 触发全部」的行为。
 */
export const settingsTestBody = t.Optional(
  t.Object({
    what: t.Optional(t.String()),
    binary: t.Optional(t.String()),
  }),
)

