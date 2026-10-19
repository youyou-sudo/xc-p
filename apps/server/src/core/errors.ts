export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'validation_failed' | 'rate_limited' | 'internal'
  | 'xray_api_unreachable' | 'xray_tag_conflict' | 'xray_build_failed'
  | 'xray_port_conflict' | 'xray_down' | 'publish_aborted' | 'unsupported_protocol'
  | 'port_pool_exhausted' | 'kv_not_modified'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, status = 400, detail?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export const unauthorized = (m = 'unauthorized') => new AppError('unauthorized', m, 401)
export const forbidden = (m = 'forbidden') => new AppError('forbidden', m, 403)
 export const conflict = (m: string, d?: unknown) => new AppError('conflict', m, 409, d)
export const validationFailed = (m: string, d?: unknown) => new AppError('validation_failed', m, 422, d)
export const internal = (m: string, d?: unknown) => new AppError('internal', m, 500, d)

export function errorBody(e: unknown): { error: { code: string; message: string; detail?: unknown } } {
  if (e instanceof AppError) {
    return { error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } }
  }
  const message = e instanceof Error ? e.message : String(e)
  return { error: { code: 'internal', message } }
}

export function statusOf(e: unknown): number {
  return e instanceof AppError ? e.status : 500
}
