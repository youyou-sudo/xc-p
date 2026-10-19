/**
 * 把 params 里的传输层/安全层字段映射成 `streamSettings`。
 * 只在字段真实存在时写入，避免给 Xray 塞它不认识的空结构。
 */

import { cleanPath, isUtlsFingerprint, toBool, toStringList } from './params'

export interface StreamParamView {
  network?: unknown
  path?: unknown
  host?: unknown
  serviceName?: unknown
  mode?: unknown
  headerType?: unknown
  kcpSeed?: unknown
  wsHeaders?: unknown
  httpHost?: unknown
  httpPath?: unknown
  security?: unknown
  transportSecurity?: unknown
  sni?: unknown
  alpn?: unknown
  fingerprint?: unknown
  allowInsecure?: unknown
  publicKey?: unknown
  shortId?: unknown
  spiderX?: unknown
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return undefined
}

function headersOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = str(val)
    if (s !== undefined) out[k] = s
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 生成 streamSettings。返回 undefined 表示「纯 TCP + 无 TLS」，
 * 由调用方决定是否省略该字段。
 */
export function buildStreamSettings(p: StreamParamView): Record<string, unknown> | undefined {
  const network = str(p.network) ?? 'tcp'
  const security = str(p.transportSecurity) ?? str(p.security)
  const sni = str(p.sni)
  const alpn = toStringList(p.alpn)
  const fingerprint = str(p.fingerprint)
  const allowInsecure = toBool(p.allowInsecure)
  const publicKey = str(p.publicKey)
  const shortId = str(p.shortId)
  const spiderX = str(p.spiderX)
  const path = cleanPath(str(p.path))
  const host = str(p.host)
  const serviceName = str(p.serviceName)

  const stream: Record<string, unknown> = { network }

  const isTls = security === 'tls' || security === 'xtls'
  const isReality = security === 'reality'
  if (security === 'none') {
    stream.security = 'none'
  } else if (isReality || publicKey) {
    stream.security = 'reality'
    const reality: Record<string, unknown> = {}
    if (sni) reality.serverName = sni
    if (publicKey) reality.publicKey = publicKey
    if (shortId) reality.shortId = shortId
    if (spiderX) reality.spiderX = spiderX
    if (fingerprint && isUtlsFingerprint(fingerprint)) reality.fingerprint = fingerprint
    if (allowInsecure !== undefined) reality.allowInsecure = allowInsecure
    stream.realitySettings = reality
  } else if (isTls) {
    stream.security = 'tls'
    const tls: Record<string, unknown> = {}
    if (sni) tls.serverName = sni
    if (alpn) tls.alpn = alpn
    if (allowInsecure !== undefined) tls.allowInsecure = allowInsecure
    if (fingerprint && isUtlsFingerprint(fingerprint)) tls.fingerprint = fingerprint
    if (Object.keys(tls).length) stream.tlsSettings = tls
  }

  // 传输层细节
  if (network === 'ws') {
    const ws: Record<string, unknown> = {}
    if (path) ws.path = path
    const headers = headersOf(p.wsHeaders)
    if (headers) ws.headers = headers
    else if (host) ws.headers = { Host: host }
    if (Object.keys(ws).length) stream.wsSettings = ws
  } else if (network === 'grpc') {
    const grpc: Record<string, unknown> = {}
    if (serviceName) grpc.serviceName = serviceName
    const mode = str(p.mode)
    if (mode === 'multi' || mode === 'gun') grpc.multiMode = true
    stream.grpcSettings = grpc
  } else if (network === 'httpupgrade') {
    const hu: Record<string, unknown> = {}
    if (host) hu.host = host
    if (path) hu.path = path
    stream.httpupgradeSettings = hu
  } else if (network === 'xhttp') {
    const x: Record<string, unknown> = {}
    if (host) x.host = host
    if (path) x.path = path
    const mode = str(p.mode)
    if (mode) x.mode = mode
    stream.xhttpSettings = x
  } else if (network === 'kcp') {
    const kcp: Record<string, unknown> = {}
    const headerType = str(p.headerType)
    kcp.header = headerType ? { type: headerType } : { type: 'none' }
    const seed = str(p.kcpSeed)
    if (seed) kcp.seed = seed
    stream.kcpSettings = kcp
  } else if (network === 'h2') {
    const h2: Record<string, unknown> = {}
    const hosts = toStringList(p.httpHost) ?? (host ? [host] : undefined)
    if (hosts) h2.host = hosts
    if (path) h2.path = path
    stream.httpSettings = h2
  } else if (network === 'tcp') {
    const headerType = str(p.headerType)
    if (headerType && headerType !== 'none') {
      stream.tcpSettings = { header: { type: headerType } }
    }
  }

  // 纯 tcp + 无安全层：省略整个对象更贴近 Xray 默认配置
  if (network === 'tcp' && stream.security === undefined && Object.keys(stream).length === 1) {
    return undefined
  }
  return stream
}

/** params -> StreamParamView（保持字段名一致性，集中在这里便于审查） */
export function streamView(params: Record<string, unknown>): StreamParamView {
  return {
    network: params['network'],
    path: params['path'],
    host: params['host'],
    serviceName: params['serviceName'],
    mode: params['mode'],
    headerType: params['headerType'],
    kcpSeed: params['kcpSeed'],
    wsHeaders: params['wsHeaders'],
    httpHost: params['httpHost'],
    httpPath: params['httpPath'],
    // 传输层安全：优先 transportSecurity（避免与 vmess 的 cipher 字段同名冲突）
    security: params['transportSecurity'] ?? params['security'],
    sni: params['sni'],
    alpn: params['alpn'],
    fingerprint: params['fingerprint'],
    allowInsecure: params['allowInsecure'],
    publicKey: params['publicKey'],
    shortId: params['shortId'],
    spiderX: params['spiderX'],
  }
}