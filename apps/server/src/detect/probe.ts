import { logger } from '../core/log'

export type ErrorKind =
  | 'tcp_timeout' | 'tcp_refused' | 'tcp_unreachable' | 'dns_failed' | 'tls_error' | 'total_timeout'
  | 'gateway_unreachable' | 'proxy_auth' | 'proxy_handshake' | 'http_status' | 'empty_reply' | 'no_proxy_effect'
  | 'xray_api_unreachable' | 'xray_tag_conflict' | 'xray_build_failed' | 'xray_port_conflict' | 'xray_down'
  | 'ip_echo_failed' | 'unsupported_protocol' | 'internal'

export interface TcpResult { ok: boolean; ms: number; errorKind?: ErrorKind; errorMsg?: string }
export interface HttpResult { ok: boolean; ms: number; status?: number; body?: string; errorKind?: ErrorKind; errorMsg?: string }

/** S1：TCP 可达性（连接 gateway:7890）。 */
export async function tcpConnect(host: string, port: number, timeoutMs: number): Promise<TcpResult> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const socket = await new Promise<{ write: (d: Uint8Array) => void; end: () => void }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('__timeout__')), timeoutMs)
      Bun.connect({
        hostname: host,
        port,
        socket: {
          open: (s: any) => {
            resolve(s)
          },
          data: () => undefined,
          close: () => undefined,
          error: (_s: any, e: Error) => reject(e),
          connectError: (_s: any, e: Error) => reject(e),
        },
      }).catch(reject)
    })
    if (timer) clearTimeout(timer)
    try {
      socket.end()
    } catch {
      /* ignore */
    }
    return { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    if (timer) clearTimeout(timer)
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, ms: Date.now() - t0, errorKind: classifyNetworkError(msg), errorMsg: msg }
  }
}

export function classifyNetworkError(msg: string): ErrorKind {
  const m = msg.toLowerCase()
  if (m.includes('__timeout__') || m.includes('timed out') || m.includes('timeout')) return 'tcp_timeout'
  if (m.includes('refused') || m.includes('econnrefused')) return 'tcp_refused'
  if (m.includes('getaddrinfo') || m.includes('dns') || m.includes('name not resolved')) return 'dns_failed'
  if (m.includes('unreachable') || m.includes('ehostunreach') || m.includes('enetunreach')) return 'tcp_unreachable'
  if (m.includes('tls') || m.includes('certificate') || m.includes('ssl')) return 'tls_error'
  return 'internal'
}

/**
 * 经网关发起真实请求（PANEL.md D7 / §8.1 S2/S3）。
 * 首选 Bun fetch 的 proxy 选项（端到端走 网关 → 环回入站 → outbound → 目标）；
 * Bun 版本不支持时回退到 curl -x。
 */
export async function fetchViaProxy(
  url: string,
  proxyUrl: string,
  timeoutMs: number,
  opts: { headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      proxy: proxyUrl,
      signal: ctrl.signal,
      redirect: 'manual',
      headers: opts.headers,
    } as RequestInit & { proxy: string })
    const ms = Date.now() - t0
    let body = ''
    try {
      body = await res.text()
    } catch {
      body = ''
    }
    clearTimeout(timer)
    if (res.status === 407) return { ok: false, ms, status: 407, errorKind: 'proxy_auth', errorMsg: '网关返回 407 代理认证失败' }
    if (res.status >= 400) return { ok: false, ms, status: res.status, body, errorKind: 'http_status', errorMsg: 'HTTP ' + res.status }
    return { ok: true, ms, status: res.status, body }
  } catch (e) {
    clearTimeout(timer)
    const msg = e instanceof Error ? e.message : String(e)
    const kind = proxyErrorKind(msg)
    logger.debug('fetchViaProxy failed', { url, msg })
    return { ok: false, ms: Date.now() - t0, errorKind: kind, errorMsg: msg }
  }
}

export function proxyErrorKind(msg: string): ErrorKind {
  const m = msg.toLowerCase()
  if (m.includes('407')) return 'proxy_auth'
  if (m.includes('connect') && m.includes('refused')) return 'gateway_unreachable'
  if (m.includes('socks')) return 'proxy_handshake'
  if (m.includes('proxy')) return 'proxy_handshake'
  if (m.includes('abort')) return 'total_timeout'
  return classifyNetworkError(msg)
}

export interface ExitInfo { ip?: string; country?: string; region?: string; asn?: string; isp?: string }

/** 解析多种 IP 回显格式（api.ip.sb/geoip、ipinfo.io/json、ip-api.com/json） */
export function parseExitInfo(text: string): ExitInfo {
  const out: ExitInfo = {}
  const ipMatch = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text) ?? /"ip"\s*:\s*"([^"]+)"/.exec(text)
  if (ipMatch) out.ip = ipMatch[1]
  try {
    const j = JSON.parse(text) as Record<string, any>
    if (typeof j.ip === 'string') out.ip = j.ip
    if (typeof j.query === 'string') out.ip = j.query
    if (typeof j.country === 'string') out.country = j.country.toUpperCase()
    if (typeof j.country_code === 'string') out.country = j.country_code.toUpperCase()
    if (typeof j.countryCode === 'string') out.country = j.countryCode.toUpperCase()
    if (typeof j.region === 'string') out.region = j.region
    if (typeof j.regionName === 'string') out.region = j.regionName
    if (typeof j.city === 'string' && !out.region) out.region = j.city
    if (typeof j.asn === 'string') out.asn = j.asn
    if (j.connection && typeof j.connection.asn === 'number') out.asn = 'AS' + j.connection.asn
    if (j.connection && typeof j.connection.isp === 'string') out.isp = j.connection.isp
    if (typeof j.org === 'string') out.isp = out.isp ?? j.org
    if (typeof j.as === 'string') out.asn = out.asn ?? j.as
  } catch {
    /* 非 JSON，保持正则结果 */
  }
  return out
}
