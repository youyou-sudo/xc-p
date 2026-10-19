/**
 * params 归一化助手。
 * params 是**原始参数袋**：解析阶段尽量原样保留上游字段（便于面板展示与 params_hash 的变化检测），
 * 而「哪些字段进入 Xray outbound」由 normalize.ts 白名单决定。
 */

/** 已知 uTLS 指纹模板（Xray 的 tlsSettings.fingerprint 只接受这些值） */
export const UTLS_FINGERPRINTS = [
  'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360',
  'qq', 'random', 'randomized',
] as const

export function isUtlsFingerprint(value: string): boolean {
  return (UTLS_FINGERPRINTS as readonly string[]).includes(value)
}

/** 去掉 undefined / null / 空串；数组去重去空；对象递归清理后若为空则丢弃 */
export function compactParams(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const cleaned = cleanValue(v)
    if (cleaned === undefined) continue
    out[k] = cleaned
  }
  return out
}

function cleanValue(v: unknown): unknown {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) {
    const arr = v.map(cleanValue).filter((x) => x !== undefined)
    return arr.length ? arr : undefined
  }
  if (typeof v === 'object') {
    const nested = compactParams(v as Record<string, unknown>)
    return Object.keys(nested).length ? nested : undefined
  }
  return undefined
}

export function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') {
    const t = v.trim()
    if (!/^[0-9]+$/.test(t)) return undefined
    const n = Number.parseInt(t, 10)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(t)) return true
    if (['0', 'false', 'no', 'off'].includes(t)) return false
  }
  return undefined
}

/** 'h2,http/1.1' / ['h2','http/1.1'] / 'h2 http/1.1' -> ['h2','http/1.1'] */
export function toStringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  const parts = Array.isArray(v)
    ? v.map((x) => String(x))
    : String(v).split(/[,\s]+/)
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out.length ? out : undefined
}

/** 把 k=v; k2=v2 形式的 plugin opts 解析成对象，用于展示与哈希 */
export function parsePluginOpts(opts: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of opts.split(';')) {
    const t = part.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq < 0) out[t] = 'true'
    else out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}

/** 从 URL 形式的 path 里取干净路径 */
export function cleanPath(v: string | undefined): string | undefined {
  if (!v) return undefined
  const t = v.trim()
  if (!t) return undefined
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      return (u.pathname || '/') + (u.search || '')
    } catch {
      return t
    }
  }
  return t
}

 export function normalizeNetwork(v: string | undefined): string | undefined {
  if (!v) return undefined
  const t = v.trim().toLowerCase()
  if (!t) return undefined
  if (t === 'http') return 'xhttp'
  if (t === 'h2' || t === 'quic') return t
  return t
}
 
