/**
 * @xc-p/api-client —— 前后端共享的 Eden Treaty 客户端。
 *
 * monorepo 中前端（web/）通过本包复用后端（apps/server/src/app.ts）的 Elysia 路由类型：
 * - `App` 是后端 Elysia 实例的类型（只做类型导入，构建时被擦除）；
 * - `createEdenClient()` 创建同源 Eden Treaty 客户端（相对路径 + keepDomain）；
 * - `unwrap()` 把 Eden 的 `{ data, error }` 结果转成「成功返回 data、失败抛 ApiError」，
 *   与面板既有的 `useResource` / `useAction` 错误处理约定保持一致。
 */
import { treaty } from '@elysiajs/eden'
// App 来自后端声明文件（bun run api:types 生成），避免前端 tsc 直接检查后端源码。
import type { App } from '../types/app'

export type { App }

/** 面板统一错误体（src/core/errors.ts → errorBody） */
export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown }
}

/**
 * Eden 在 onError 返回的对象会被并入每条路由的响应联合类型里。
 * 这里把「只有 error 字段」的联合成员过滤掉，得到真正的成功响应类型。
 * 注意不能简单用 `Exclude<T, { error: unknown }>`：任务对象等成功响应也可能带 error 字段。
 */
type IsOnlyError<T> = T extends { error: unknown }
  ? Exclude<keyof T, 'error'> extends never
    ? true
    : false
  : false
type FilterError<D> = D extends unknown ? (IsOnlyError<D> extends true ? never : D) : never

/** 从 Eden 调用结果中提取成功响应类型 */
export type ApiData<T> = T extends { data: infer D } ? FilterError<NonNullable<D>> : never

/** Eden 结果的最小结构（避免直接依赖内部类型） */
export interface EdenResult {
  data: unknown
  error: unknown
  status: number
  response?: Response
  headers?: unknown
}

/** 面板 API 错误：网络错误、HTTP 状态码与后端统一错误体都归一到这里。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly body: unknown

  constructor(status: number, code: string, message: string, requestId = '', body: unknown = null) {
    super(message || code || 'HTTP ' + status)
    this.name = 'ApiError'
    this.status = status
    this.code = code || 'http_' + status
    this.requestId = requestId
    this.body = body
  }
}

export interface EdenClientOptions {
  /** 部署在独立域名时填绝对地址；同源部署留空即可（配合 keepDomain 使用相对路径）。 */
  baseUrl?: string
  /** 额外请求头，默认由 web/src/lib/api.ts 传入 x-requested-with。 */
  headers?: Record<string, string>
  /** 收到 401 时回调（用于清理会话、跳转登录）。 */
  onUnauthorized?: () => void
}

/**
 * 创建 Eden Treaty 客户端。
 * - `keepDomain: true` 允许 baseUrl 为空字符串，浏览器端请求 `/api/...` 同源相对路径；
 * - 统一携带面板标记头与 same-origin Cookie；
 * - 401 交给 onUnauthorized 处理（Eden 不会自动抛错）。
 */
export function createEdenClient(options: EdenClientOptions = {}) {
  const { baseUrl = '', headers, onUnauthorized } = options
  return treaty<App>(baseUrl, {
    keepDomain: true,
    ...(headers ? { headers } : {}),
    onRequest(_path, init) {
      return { ...init, credentials: 'same-origin' }
    },
    onResponse(response) {
      if (response.status === 401) onUnauthorized?.()
    },
  })
}


function isAbortError(value: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && value instanceof DOMException && value.name === 'AbortError') ||
    (value instanceof Error && value.name === 'AbortError')
  )
}

function errorMessageOf(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const body = value as ApiErrorBody
    if (body.error && typeof body.error.message === 'string') return body.error.message
  }
  if (value instanceof Error) return value.message
  if (typeof value === 'string' && value) return value.slice(0, 300)
  return ''
}

/**
 * 等待 Eden 调用并返回成功数据；失败时抛出 ApiError（401 已由 onUnauthorized 处理）。
 * AbortError 原样抛回，方便 useResource 区分「组件卸载导致的取消」和真正的请求失败。
 */
export async function unwrap<R extends EdenResult>(result: R | Promise<R>): Promise<ApiData<R>> {
  const res = await result
  if (res.error) {
    const error = res.error as { value?: unknown; status?: number; message?: string }
    if (isAbortError(error.value)) throw error.value

    const status = res.status ?? error.status ?? 0
    const value = error.value
    const body = value && typeof value === 'object' ? value : null
    const apiBody = body && 'error' in (body as Record<string, unknown>) ? (body as ApiErrorBody) : null
    const networkish = status === 0 || status === 503
    const code = apiBody?.error?.code ?? (networkish ? 'network_error' : 'http_' + status)
    const message =
      apiBody?.error?.message ??
      (networkish ? '无法连接面板服务端（网络错误或服务未启动）' : errorMessageOf(value) || '请求失败（' + status + '）')
    const requestId = res.response?.headers?.get?.('x-request-id') ?? ''
    throw new ApiError(status, code, message, requestId, body)
  }
  return res.data as ApiData<R>
}