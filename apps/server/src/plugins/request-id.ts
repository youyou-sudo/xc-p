import { Elysia } from 'elysia'
import { requestId } from '../core/http'

/** 统一响应头：每个成功响应带 x-request-id 与 no-store（PANEL.md §11.2）。 */
export const requestIdPlugin = new Elysia({ name: 'request-id' }).onAfterHandle({ as: 'global' }, ({ set }) => {
  const headers = set.headers as Record<string, string>
  if (!headers['x-request-id']) headers['x-request-id'] = requestId()
  headers['cache-control'] = headers['cache-control'] ?? 'no-store'
})
