/**
 * 归一化（PANEL.md §7.3）：NodeInput -> NormalizedNode。
 *
 * - `fingerprint` 决定「是不是同一个节点」= sha1(protocol|server|port|credential)
 * - `paramsHash` 决定「参数是否变了」= sha1(params 深度排序后的稳定 JSON)
 * - `protocolSupported` 由 D9 矩阵在归一化阶段写死，发布阶段不再二次猜测
 * - `outbound` 是**不含 tag** 的 Xray outbound 模板
 *
 * outbound 的字段白名单是对着 `.tools/xray.exe` 的 `run -test` 实测出来的
 * （v25.9.11 与升级后的 v26.3.27 都验过）：都不认识 hysteria2 / tuic / shadowsocksr
 * （unknown config id），也不接受 network=h2/quic（已迁移到 xhttp），这些在渲染时被显式
 * 降级而不是交给 Xray 报错。v26.2.6 起上游把 `allowInsecure` 标为延时废弃（UTC 2026-06-01
 * 起报错），渲染若仍带 allowInsecure=true 会被发布期构建校验按节点排除（见 §9.3 / B7）。
 */

import { createHash } from 'node:crypto'
import { buildStreamSettings, streamView } from './stream'
import type { NodeInput, NormalizedNode, Protocol } from './types'

/** D9 协议支持矩阵；ssr 及其他一律 false */
export const PROTOCOL_SUPPORT_MATRIX: Record<Protocol, boolean> = {
  ss: true,
  ssr: false,
  vmess: true,
  vless: true,
  trojan: true,
  hysteria2: true,
  tuic: true,
  socks: true,
  http: true,
}

function sha1(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex')
}

export function fingerprintOf(p: { protocol: string; server: string; port: number; credential: string }): string {
  return sha1([p.protocol, p.server, p.port, p.credential].join('|'))
}

/** 深度排序的稳定序列化：对象键排序、数组保序、undefined 丢弃 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null'
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'undefined') return 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
  }
  return 'null'
}

export function paramsHashOf(params: Record<string, unknown>): string {
  return sha1(stableStringify(params))
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v.trim())) return Number.parseInt(v.trim(), 10)
  return undefined
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(t)) return true
    if (['0', 'false', 'no', 'off'].includes(t)) return false
  }
  return undefined
}

function normalizeServer(server: string): string {
  let s = server.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s.toLowerCase()
}

/**
 * 身份凭据：SS/VMess/VLESS 的 base64 凭据（SS 2022 的多用户形态是 `key:key`）
 * 与密码里的 `+`/`/` 是敏感的，**不做 URL 解码**，只裁剪首尾空白。
 */
export function credentialOf(input: NodeInput): string {
  return (input.credential ?? '').trim()
}

/** SS 2022（`2022-blake3-*`）：method 直接透传，password 允许 `server-key:user-key` 多用户形态 */
function isSs2022(method: string): boolean {
  return /^2022-blake3-/.test(method)
}

/** 把 pluginOpts 对象/原始串还原为 Xray 需要的 `k=v;k=v` */
function pluginOptsString(params: Record<string, unknown>): string | undefined {
  const raw = str(params['pluginOptsRaw'])
  if (raw) return raw
  const obj = params['pluginOpts']
  if (!obj) return undefined
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => (v === 'true' || v === true ? k : k + '=' + String(v)))
      .join(';')
  }
  return undefined
}

function splitUserPass(credential: string, params: Record<string, unknown>): { user?: string; pass?: string } {
  const pUser = str(params['username'])
  const pPass = str(params['password'])
  if (pUser !== undefined) return { user: pUser, pass: pPass }
  if (!credential) return {}
  const idx = credential.indexOf(':')
  if (idx < 0) return { user: credential }
  return { user: credential.slice(0, idx), pass: credential.slice(idx + 1) }
}

/** 构造不含 tag 的 Xray outbound 模板 */
export function buildOutbound(input: NodeInput, credential: string): Record<string, unknown> {
  const params = input.params ?? {}
  const outbound: Record<string, unknown> = {}
  let settings: Record<string, unknown> | undefined

  switch (input.protocol) {
    case 'ss':
    case 'ssr': {
      const method = str(params['method']) ?? 'none'
      const server: Record<string, unknown> = {
        address: input.server,
        port: input.port,
        method,
        password: credential,
      }
      if (isSs2022(method)) {
        const uot = bool(params['udpOverTcp'])
        if (uot !== undefined) server.uot = uot
      }
      const plugin = str(params['plugin'])
      if (input.protocol === 'ss' && plugin) {
        server.plugin = plugin
        const opts = pluginOptsString(params)
        if (opts) server.pluginOpts = opts
      }
      settings = { servers: [server] }
      outbound.protocol = input.protocol === 'ssr' ? 'shadowsocksr' : 'shadowsocks'
      break
    }
    case 'vmess': {
      const user: Record<string, unknown> = {
        id: credential,
        alterId: num(params['alterId']) ?? 0,
        security: str(params['security']) ?? 'auto',
      }
      const flow = str(params['flow'])
      if (flow) user.flow = flow
      settings = { vnext: [{ address: input.server, port: input.port, users: [user] }] }
      outbound.protocol = 'vmess'
      break
    }
    case 'vless': {
      const user: Record<string, unknown> = {
        id: credential,
        encryption: str(params['encryption']) ?? 'none',
      }
      const flow = str(params['flow'])
      if (flow) user.flow = flow
      settings = { vnext: [{ address: input.server, port: input.port, users: [user] }] }
      outbound.protocol = 'vless'
      break
    }
    case 'trojan':
      settings = { servers: [{ address: input.server, port: input.port, password: credential }] }
      outbound.protocol = 'trojan'
      break
    case 'socks':
    case 'http': {
      const server: Record<string, unknown> = { address: input.server, port: input.port }
      const { user, pass } = splitUserPass(credential, params)
      if (user) {
        server.users = pass ? [{ user, pass }] : [{ user }]
      }
      settings = { servers: [server] }
      outbound.protocol = input.protocol === 'socks' ? 'socks' : 'http'
      break
    }
    case 'hysteria2':
      // 本构建不认 hysteria2，仅保留语义化模板（protocol_supported 已标记，不会进发布快照）
      settings = { servers: [{ address: input.server, port: input.port, password: credential }] }
      outbound.protocol = 'hysteria2'
      break
    case 'tuic':
      settings = {
        servers: [{
          address: input.server,
          port: input.port,
          uuid: credential,
          password: str(params['password']) ?? '',
        }],
      }
      outbound.protocol = 'tuic'
      break
    default:
      settings = { servers: [{ address: input.server, port: input.port, password: credential }] }
      outbound.protocol = String(input.protocol)
      break
  }

  if (settings) outbound.settings = settings

  // 本构建已移除 h2/quic 传输（迁移到 xhttp）；映射过去比让 Xray 拒绝更贴近现实
  const net = str(params['network'])
  const streamParams = net === 'h2' || net === 'quic' ? { ...params, network: 'xhttp' } : params
  const stream = buildStreamSettings(streamView(streamParams))
  if (stream) outbound.streamSettings = stream
  return outbound
}

export function normalizeNode(input: NodeInput): NormalizedNode {
  const protocol = input.protocol
  const server = normalizeServer(input.server)
  const credential = credentialOf(input)
  return {
    protocol,
    server,
    port: input.port,
    credential,
    params: input.params,
    name: input.name,
    raw: input.raw,
    fingerprint: fingerprintOf({ protocol, server, port: input.port, credential }),
    paramsHash: paramsHashOf(input.params),
    protocolSupported: PROTOCOL_SUPPORT_MATRIX[protocol] === true,
    outbound: buildOutbound({ ...input, server }, credential),
  }
}

/** 批量归一化（同一订阅内按 fingerprint 去重，保留首次出现） */
export function normalizeNodes(inputs: NodeInput[]): NormalizedNode[] {
  const seen = new Set<string>()
  const out: NormalizedNode[] = []
  for (const input of inputs) {
    const node = normalizeNode(input)
    if (seen.has(node.fingerprint)) continue
    seen.add(node.fingerprint)
    out.push(node)
  }
  return out
}
