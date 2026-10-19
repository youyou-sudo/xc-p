/**
 * 分享链接的解析原语：URI 切分、查询参数、SIP002 的 userinfo 变体。
 * 只做「链接 -> 原始字段」的搬运，协议语义在 links.ts 里。
 */

import { normalizeBase64, tryBase64Decode } from './b64'

export interface RawLink {
  scheme: string
  /** scheme:// 之后、'#' 之前的全部内容 */
  rest: string
  /** 未解码的 fragment（名称） */
  fragmentRaw: string
  /** 去掉外层大括号的原始串 */
  raw: string
}

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s

/** 把一行文本切成 scheme / 主体 / fragment；不是链接则返回 undefined */
export function splitLink(line: string): RawLink | undefined {
  const raw = line.trim()
  const m = SCHEME_RE.exec(raw)
  if (!m) return undefined
  const scheme = m[1].toLowerCase()
  let body = m[2]
  let fragmentRaw = ''
  const hash = body.indexOf('#')
  if (hash >= 0) {
    fragmentRaw = body.slice(hash + 1)
    body = body.slice(0, hash)
  }
  return { scheme, rest: body, fragmentRaw, raw }
}

/** fragment 里的名称，容错百分号编码与 `+` 空格写法 */
export function decodeFragment(fragmentRaw: string): string {
  if (!fragmentRaw) return ''
  const plus = fragmentRaw.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(plus).trim()
  } catch {
    return plus.trim()
  }
}

export function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 解析 `k=v&k=v` 查询串。
 * 同名参数保留**首个**（订阅链接里重复参数以第一个为准更符合 Xray/sing-box 的直觉），
 * 同时把全部值挂在 `key[]` 形式的数组里以便调用方取多值（如 alpn 之外的扩展字段）。
 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!query) return out
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = decodeComponent(eq < 0 ? part : part.slice(0, eq))
    const v = eq < 0 ? '' : decodeComponent(part.slice(eq + 1))
    if (!k) continue
    if (!(k in out)) out[k] = v
  }
  return out
}

/**
 * SIP002 的 userinfo：可能是
 *   1) `base64(method:password)`（整体编码，含 `:` 在明文里）
 *   2) 明文 `method:password`（SIP002 正式写法，冒号不编码）
 *   3) `base64(method)``:``base64(password)` —— 少数插件站点的变体
 *   4) 只有一段，当作 password（method 从查询串拿）
 * 返回 null 表示该段无法解释为合法 SS 凭据。
 */
export function parseSsUserInfo(userinfo: string): { method: string; password: string } | null {
  const decodeMaybe = (s: string): string => {
    // 先按明文处理：只有当明文里缺少 ':' 时才尝试 base64
    if (s.includes(':')) return s
    return tryBase64Decode(s) ?? s
  }

  if (userinfo.includes(':')) {
    const idx = userinfo.indexOf(':')
    const left = userinfo.slice(0, idx)
    const right = userinfo.slice(idx + 1)
    // 变体 3：左右分别 base64
    const leftDecoded = decodeMaybe(left)
    const rightDecoded = decodeMaybe(right)
    if (leftDecoded.includes(':')) {
      // 变体 1 的残留：整体再解一次
      const whole = tryBase64Decode(normalizeBase64(userinfo))
      if (whole && whole.includes(':')) {
        const j = whole.indexOf(':')
        return { method: whole.slice(0, j), password: whole.slice(j + 1) }
      }
    }
    return { method: leftDecoded.trim(), password: rightDecoded }
  }

  // 变体 1：整体 base64(method:password)
  const whole = tryBase64Decode(userinfo)
  if (whole && whole.includes(':')) {
    const j = whole.indexOf(':')
    return { method: whole.slice(0, j).trim(), password: whole.slice(j + 1) }
  }
  // 变体 4：只有一段（通常是 base64 的 password）
  const only = whole ?? userinfo
  return { method: '', password: only }
}
