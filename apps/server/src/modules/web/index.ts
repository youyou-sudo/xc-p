import { Elysia } from 'elysia'
import { AppError } from '../../core/errors'
import { serveWebAsset } from '../../web/serve'

/**
 * 静态面板（Furin embed 产物）。
 * /_client/* 内容哈希 → immutable；HTML / ndjson → no-store；未知路径 → SPA 壳。
 */
export function webModule() {
  return new Elysia({ name: 'web' }).get('/*', ({ params, request }) => {
    let pathname: string
    try {
      pathname = decodeURIComponent('/' + String((params as Record<string, string>)['*'] ?? ''))
    } catch {
      throw new AppError('not_found', '资源路径非法', 404)
    }
    if (pathname.startsWith('/api') || pathname.startsWith('/v1')) {
      throw new AppError('not_found', '接口不存在', 404)
    }
    return serveWebAsset(pathname, request)
  })
}
