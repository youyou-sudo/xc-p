import { randomUUID } from 'node:crypto'

export function requestId(): string {
  return randomUUID()
}

export interface Paged<T> {
  items: T[]
  nextCursor: number | null
  total?: number
}

export function parsePaging(query: Record<string, string | undefined>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(query.limit || '50', 10) || 50, 1), 500)
  const offset = Math.max(Number.parseInt(query.cursor || '0', 10) || 0, 0)
  return { limit, offset }
}

export function page<T>(rows: T[], limit: number, offset: number, total?: number): Paged<T> {
  const next = rows.length === limit ? offset + limit : null
  return { items: rows, nextCursor: next, ...(total === undefined ? {} : { total }) }
}

export function parseBool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

  /** 客户端 IP：优先 x-forwarded-for，其次 x-real-ip；面板默认只监听本机。 */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return request.headers.get('x-real-ip') ?? '127.0.0.1'
}
