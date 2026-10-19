/**
 * L4 网关的公共类型与纯函数工具（PANEL.md §10.1，IMPL-CONTRACTS.md §3）。
 * 只依赖 Bun/Node 内置模块，不引入任何代理协议实现库。
 */

/** 网关配置（settings.gateway） */
export interface GatewayConfig {
  enabled: boolean
  /** "0.0.0.0:7890" */
  listen: string
  authMode: 'strict' | 'username-only'
  tls: { enabled: boolean; certFile: string; keyFile: string }
  maxConcurrentPerUser: number
  maxConcurrentPerIp: number
  idleTimeoutSec: number
  dialTimeoutMs: number
  authFailBanCount: number
  authFailBanSec: number
  /** 面板可只开一种；默认都开 */
  protocols: { http: boolean; socks5: boolean }
}

/** 用户名 → 节点环回入站 */
export interface RouteTarget {
  nodeId: string
  port: number
  tag?: string
}

/** 网关对外部（DB / 事件 / 日志）的依赖回调 */
export interface GatewayDeps {
  getConfig(): GatewayConfig
  /** username(节点ID 或 alias) → 环回端口；未找到返回 undefined */
  resolveRoute(username: string): RouteTarget | undefined
  /** strict 模式校验用户名+密码；username-only 模式只要求路由存在 */
  verifyCredential(username: string, password: string): boolean
  isBanned(ip: string): boolean
  onAuthFailure(ip: string): void
  onAuthSuccess(ip: string): void
  onOpen(info: {
    nodeId: string
    username: string
    clientIp: string
    protocol: 'http' | 'socks5'
    target: string
  }): number
  onClose(
    connId: number,
    reason: 'client' | 'remote' | 'kicked' | 'shutdown' | 'error',
    up: number,
    down: number,
  ): void
  onBytes(connId: number, up: number, down: number): void
  log(level: 'info' | 'warn' | 'error', msg: string, detail?: unknown): void
}

export interface GatewayStats {
  listen: string
  activeConns: number
  activeByNode: Record<string, number>
  activeByIp: Record<string, number>
  authFailures5m: number
  bannedIps: string[]
  totalOpened: number
  totalClosed: number
  bytesUp: number
  bytesDown: number
}

/** 连接表的一行（内存态），id 由 deps.onOpen 返回 */
export interface ConnectionRow {
  id: number
  nodeId: string
  username: string
  clientIp: string
  target: string
  startedAt: number
  upBytes: number
  downBytes: number
  protocol: string
}

/**
 * 网关内部的客户端 socket 抽象：明文路径包装 Bun.Socket，
 * TLS 路径包装 node:tls.TLSSocket（Bun 1.4 的 socket.upgradeTLS 不会转交事件）。
 */
export interface SessionSocket {
  readonly remoteAddress: string
  write(data: Uint8Array): number
  /** 半关：发送 FIN，仍可读 */
  end(data?: Uint8Array): void
  /** 关闭（发 RST） */
  close(): void
}

/** 关闭原因（与 DB 的 close_reason 枚举一致） */
export type CloseReason = 'client' | 'remote' | 'kicked' | 'shutdown' | 'error'

/** 解析出的代理凭据 */
export interface Credential {
  username: string
  password: string
}

/** 解析出的代理请求目标 */
export interface ProxyRequest {
  /** "host:port" */
  target: string
  /** 客户端发给环回入站的原始字节（原样转发，不做改写） */
  raw: Uint8Array
  /** 请求头之后紧跟的隧道数据（HTTP 快速开局时可能出现） */
  rest: Uint8Array
}

/** 解析 SOCKS5 用户名/密码（RFC 1929）。格式非法返回 undefined。 */
export function parseSocks5Credential(blob: Uint8Array): Credential | undefined {
  if (blob.length < 3) return undefined
  const ulen = blob[1]!
  if (blob.length < 2 + ulen + 1) return undefined
  const plen = blob[2 + ulen]!
  if (blob.length < 3 + ulen + plen) return undefined
  if (blob[0] !== 0x01) return undefined
  const username = utf8(blob.subarray(2, 2 + ulen))
  const password = utf8(blob.subarray(3 + ulen, 3 + ulen + plen))
  return { username, password }
}

/** 解析 Basic 凭据。user/pass 均可为空串（由调用方判定是否合法）。 */
export function parseBasicCredential(value: string): Credential | undefined {
  const s = value.trim()
  if (!/^basic\s+/i.test(s)) return undefined
  const b64 = s.slice(s.indexOf(' ') + 1).trim()
  if (!b64) return undefined
  let decoded: Uint8Array
  try {
    decoded = base64Decode(b64)
  } catch {
    return undefined
  }
  const text = utf8(decoded)
  const sep = text.indexOf(':')
  if (sep < 0) return { username: text, password: '' }
  return { username: text.slice(0, sep), password: text.slice(sep + 1) }
}

/** RFC1929 常量 */
export const SOCKS5_VERSION = 0x05
export const SOCKS5_AUTH_VERSION = 0x01
export const SOCKS5_CMD_CONNECT = 0x01
export const SOCKS5_CMD_UDP_ASSOCIATE = 0x03
export const SOCKS5_REP_SUCCEEDED = 0x00
export const SOCKS5_REP_GENERAL_FAILURE = 0x01
export const SOCKS5_REP_CMD_NOT_SUPPORTED = 0x07
export const SOCKS5_REP_ADDR_NOT_SUPPORTED = 0x08

export const HTTP_407 =
  'HTTP/1.1 407 Proxy Authentication Required\r\n' +
  'Proxy-Authenticate: Basic realm="xc-p"\r\n' +
  'Proxy-Connection: close\r\n' +
  'Content-Length: 0\r\n' +
  'Connection: close\r\n' +
  '\r\n'

export const HTTP_429 =
  'HTTP/1.1 429 Too Many Requests\r\n' +
  'Proxy-Connection: close\r\n' +
  'Content-Length: 0\r\n' +
  'Connection: close\r\n' +
  '\r\n'

export const HTTP_502 =
  'HTTP/1.1 502 Bad Gateway\r\n' +
  'Proxy-Connection: close\r\n' +
  'Content-Length: 0\r\n' +
  'Connection: close\r\n' +
  '\r\n'

export const HTTP_400 =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Proxy-Connection: close\r\n' +
  'Content-Length: 0\r\n' +
  'Connection: close\r\n' +
  '\r\n'

 export function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function base64Decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/** 解析 "0.0.0.0:7890" / "[::]:7890" / ":7890" */
export function splitListen(listen: string): { hostname: string; port: number } {
  const s = (listen || '').trim()
  let hostname = '0.0.0.0'
  let portPart = s
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end < 0) throw new Error(`gateway.listen 非法（缺少 ']'）: ${listen}`)
    hostname = s.slice(1, end)
    portPart = s.slice(end + 1).replace(/^:/, '')
  } else {
    const idx = s.lastIndexOf(':')
    if (idx >= 0) {
      hostname = s.slice(0, idx)
      portPart = s.slice(idx + 1)
    }
    if (!hostname) hostname = '0.0.0.0'
  }
  const port = Number.parseInt(portPart, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`gateway.listen 端口非法: ${listen}`)
  }
  return { hostname, port }
}

/** "CONNECT host:port HTTP/1.1" 原始请求（网关转发给环回 http 入站用） */
export function buildConnectRequest(target: string): Uint8Array {
  return new TextEncoder().encode(
    `CONNECT ${target} HTTP/1.1\r\n` +
      `Host: ${target}\r\n` +
      'Proxy-Authorization: Basic eGMtcDp4Yy1w\r\n' + // xc-p:xc-p，环回入站不校验
      'Proxy-Connection: Keep-Alive\r\n' +
      '\r\n',
  )
}
 
export function formatAddr(buf: Uint8Array, offset: number): string | undefined {
  const atyp = buf[offset]
  if (atyp === 0x01) {
    if (buf.length < offset + 7) return undefined
    return `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}:${(buf[offset + 5]! << 8) | buf[offset + 6]!}`
  }
  if (atyp === 0x03) {
    if (buf.length < offset + 2) return undefined
    const len = buf[offset + 1]!
    if (buf.length < offset + 2 + len + 2) return undefined
    const host = utf8(buf.subarray(offset + 2, offset + 2 + len))
    const port = (buf[offset + 2 + len]! << 8) | buf[offset + 3 + len]!
    return `${host}:${port}`
  }
  if (atyp === 0x04) {
    if (buf.length < offset + 19) return undefined
    const seg: string[] = []
    for (let i = 0; i < 8; i += 2) {
      seg.push(((buf[offset + 1 + i]! << 8) | buf[offset + 2 + i]!).toString(16))
    }
    const port = (buf[offset + 17]! << 8) | buf[offset + 18]!
    return `[${seg.join(':')}]:${port}`
  }
  return undefined
}
 
