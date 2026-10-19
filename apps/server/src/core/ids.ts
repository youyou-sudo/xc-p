import { randomBytes, randomUUID, createHash } from 'node:crypto'

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function randomBase62(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += B62[bytes[i]! % 62]
  return out
}

export function randomId(prefix = ''): string {
  return prefix + randomUUID().replace(/-/g, '')
}

export function shortId(len = 8): string {
  return randomBase62(len)
}

/** rev_20260601T120000_ab12 */
export function revisionId(at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `rev_${stamp}_${randomBase62(4).toLowerCase()}`
}

export function jobId(kind: string): string {
  return `job_${kind}_${Date.now().toString(36)}_${randomBase62(5).toLowerCase()}`
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}
