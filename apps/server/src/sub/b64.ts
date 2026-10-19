/**
 * 分享链接里各种 base64 变体的宽容解码。
 * 订阅站点的写法极不统一：标准/URL-safe 字母表、有/无 padding、以及被 URL 编码过的 `=`。
 */

const B64_CHARS = /^[A-Za-z0-9+/=_-]+$/

/** 先还原常见的 URL 编码与空白（部分站点把 payload 整段 urlencode 了） */
export function unfoldText(text: string): string {
  return text
    .replace(/%3D/gi, '=')
    .replace(/%2B/gi, '+')
    .replace(/%2F/gi, '/')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/**
 * 标准/URL-safe 字母表统一到标准字母表，并补齐 padding。
 * 长度模 4 余 1 的串在 base64 里无解，原样返回（由解码方判定失败）。
 */
export function normalizeBase64(input: string): string {
  const s = input.replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const rest = s.length % 4
  if (rest === 1) return s
  if (rest === 2) return s + '=='
  if (rest === 3) return s + '='
  return s
}

/**
 * 宽容 base64 解码。只在「看起来像 base64 且解出来是合法 UTF-8」时返回字符串，
 * 否则返回 undefined —— 调用方据此判定「这不是 base64 整体编码」。
 */
export function tryBase64Decode(input: string): string | undefined {
  const raw = unfoldText(input)
  if (!raw || raw.length < 4) return undefined
  if (!B64_CHARS.test(raw)) return undefined
  const norm = normalizeBase64(raw)
  // 长度模 4 余 1 说明输入被截断，不能猜；直接判定不是 base64
  if (norm.length === 0 || norm.length % 4 !== 0) return undefined
  let binary: string
  try {
    binary = atob(norm)
  } catch {
    return undefined
  }
  // atob 得到的是 latin1 字节串，逐字节还原为 UTF-8
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  // 解码结果里出现 NUL 基本可以判定不是文本
  if (text.includes('\u0000')) return undefined
  return text
}

export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}