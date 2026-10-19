/**
 * Clash / mihomo YAML 订阅解析（PANEL.md §7.2 第 3 步）。
 * 只消费 `proxies` 列表；其余键（proxy-groups / rules / proxy-providers）不影响解析。
 */

import { parse as parseYaml } from 'yaml'
import { cleanPath, compactParams, normalizeNetwork, toBool, toInt, toStringList } from './params'
import type { CandidateNode, NodeInput } from './types'

export interface ClashParseOutcome {
  nodes: NodeInput[]
  errors: { lineNo: number; raw: string; errorKind: string; errorMsg: string }[]
}

/** 判断文本是否是 Clash 风格 YAML（不必成功解析，只要结构像） */
export function looksLikeClash(body: string): boolean {
  return /^\s*(proxies|proxy-providers|proxy-groups)\s*:/m.test(body)
}

export function parseClashYaml(body: string, sourceSubscriptionId: string): ClashParseOutcome {
  let doc: unknown
  try {
    doc = parseYaml(body)
  } catch (err) {
    return {
      nodes: [],
      errors: [{
        lineNo: 1,
        raw: body.slice(0, 200),
        errorKind: 'bad_yaml',
        errorMsg: err instanceof Error ? err.message : String(err),
      }],
    }
  }

  const root = doc as Record<string, unknown> | null
  const list = root && typeof root === 'object' ? root['proxies'] : undefined
  if (!Array.isArray(list)) {
    return {
      nodes: [],
      errors: [{
        lineNo: 1,
        raw: 'proxies',
        errorKind: 'format_unknown',
        errorMsg: 'YAML 里没有 proxies 数组',
      }],
    }
  }

  const nodes: NodeInput[] = []
  const errors: ClashParseOutcome['errors'] = []

  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    // YAML 数组里的换行被折叠，用条目序号作为 lineNo（1-based）
    const lineNo = i + 1
    try {
      const c = mapClashProxy(entry as Record<string, unknown>)
      nodes.push({
        protocol: c.protocol as NodeInput['protocol'],
        server: c.server!,
        port: Number(c.port),
        credential: c.credential ?? '',
        params: compactParams(c.params ?? {}),
        name: (c.name ?? '').trim(),
        raw: JSON.stringify(entry),
        sourceSubscriptionId,
      })
    } catch (err) {
      errors.push({
        lineNo,
        raw: JSON.stringify(entry).slice(0, 200),
        errorKind: err instanceof ClashError ? err.kind : 'bad_yaml',
        errorMsg: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { nodes, errors }
}

class ClashError extends Error {
  kind: string
  constructor(kind: string, msg: string) {
    super(msg)
    this.kind = kind
  }
}

function reqStr(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  throw new ClashError('missing_field', '缺少字段：' + key)
}

function reqPort(p: Record<string, unknown>): number {
  const port = toInt(p['port'])
  if (port === undefined || port <= 0 || port > 65535) {
    throw new ClashError('bad_port', '非法端口：' + String(p['port'] ?? ''))
  }
  return port
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

function wsOpts(p: Record<string, unknown>): { path?: string; host?: string; headers?: Record<string, string> } {
  const raw = p['ws-opts'] as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return {}
  const headers: Record<string, string> = {}
  const h = raw['headers']
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v
    }
  }
  return {
    path: cleanPath(typeof raw['path'] === 'string' ? raw['path'] : undefined),
    host: typeof headers['Host'] === 'string' ? headers['Host'] : (typeof headers['host'] === 'string' ? headers['host'] : undefined),
    headers: Object.keys(headers).length ? headers : undefined,
  }
}

function grpcOpts(p: Record<string, unknown>): { serviceName?: string } {
  const raw = p['grpc-opts'] as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return {}
  return { serviceName: typeof raw['grpc-service-name'] === 'string' ? raw['grpc-service-name'] : undefined }
}

function tlsParams(p: Record<string, unknown>, defaults: { security?: string } = {}): Record<string, unknown> {
  const tls = toBool(p['tls'])
  const sni = str(p, 'servername') ?? str(p, 'sni')
  const fingerprint = str(p, 'client-fingerprint') ?? str(p, 'fingerprint')
  const skipCert = toBool(p['skip-cert-verify'])
  const reality: Record<string, unknown> = {}
  const realityOpts = p['reality-opts'] as Record<string, unknown> | undefined
  if (realityOpts && typeof realityOpts === 'object') {
    if (typeof realityOpts['public-key'] === 'string') reality.publicKey = realityOpts['public-key']
    if (typeof realityOpts['short-id'] === 'string') reality.shortId = realityOpts['short-id']
  }
  const security = Object.keys(reality).length
    ? 'reality'
    : tls === true
      ? 'tls'
      : tls === false
        ? 'none'
        : defaults.security
  return compactParams({
    transportSecurity: security,
    sni,
    alpn: toStringList(p['alpn']),
    fingerprint,
    allowInsecure: skipCert,
    publicKey: reality.publicKey,
    shortId: reality.shortId,
  })
}

function networkParams(p: Record<string, unknown>): Record<string, unknown> {
  const network = normalizeNetwork(str(p, 'network'))
  const ws = wsOpts(p)
  const grpc = grpcOpts(p)
  const h2 = p['h2-opts'] as Record<string, unknown> | undefined
  return compactParams({
    network,
    path: ws.path ?? cleanPath(str(p, 'path')),
    host: ws.host ?? str(p, 'host'),
    wsHeaders: ws.headers,
    serviceName: grpc.serviceName,
    httpHost: h2 && Array.isArray(h2['host']) ? (h2['host'] as unknown[]).map(String) : undefined,
    httpPath: h2 ? cleanPath(typeof h2['path'] === 'string' ? h2['path'] : undefined) : undefined,
    headerType: str(p, 'header-type'),
  })
}

/** Clash 单条 proxy -> CandidateNode */
export function mapClashProxy(p: Record<string, unknown>): CandidateNode {
  if (!p || typeof p !== 'object') throw new ClashError('bad_yaml', 'proxy 条目不是对象')
  const type = String(p['type'] ?? '').toLowerCase()
  const name = str(p, 'name') ?? ''
  const server = reqStr(p, 'server')
  const port = reqPort(p)
  const net = networkParams(p)
  const tls = tlsParams(p)

  switch (type) {
    case 'ss': {
      const cipher = str(p, 'cipher') ?? str(p, 'method')
      if (!cipher) throw new ClashError('missing_field', 'ss 缺少 cipher')
      const password = str(p, 'password') ?? ''
      const plugin = str(p, 'plugin')
      const pluginOpts: Record<string, string> = {}
      const pluginRaw = p['plugin-opts'] as Record<string, unknown> | undefined
      if (pluginRaw && typeof pluginRaw === 'object') {
        for (const [k, v] of Object.entries(pluginRaw)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') pluginOpts[k] = String(v)
        }
      }
      const params: Record<string, unknown> = { method: cipher, plugin }
      if (Object.keys(pluginOpts).length) params.pluginOpts = pluginOpts
      if (toBool(p['udp-over-tcp']) !== undefined) params.udpOverTcp = toBool(p['udp-over-tcp'])
      return { protocol: 'ss', server, port, credential: password, params, name, raw: '' }
    }
    case 'ssr': {
      return {
        protocol: 'ssr',
        server,
        port,
        credential: str(p, 'password') ?? '',
        params: compactParams({
          method: str(p, 'cipher'),
          protocol: str(p, 'protocol'),
          protocolParam: str(p, 'protocol-param'),
          obfs: str(p, 'obfs'),
          obfsParam: str(p, 'obfs-param'),
        }),
        name,
        raw: '',
      }
    }
    case 'vmess': {
      const uuid = str(p, 'uuid')
      if (!uuid) throw new ClashError('missing_field', 'vmess 缺少 uuid')
      return {
        protocol: 'vmess',
        server,
        port,
        credential: uuid,
        params: compactParams({
          alterId: toInt(p['alterId'] ?? p['alter-id']) ?? 0,
          security: str(p, 'cipher') ?? 'auto',
          ...net,
          ...tls,
        }),
        name,
        raw: '',
      }
    }
    case 'vless': {
      const uuid = str(p, 'uuid')
      if (!uuid) throw new ClashError('missing_field', 'vless 缺少 uuid')
      return {
        protocol: 'vless',
        server,
        port,
        credential: uuid,
        params: compactParams({
          flow: str(p, 'flow'),
          encryption: 'none',
          ...net,
          ...tls,
        }),
        name,
        raw: '',
      }
    }
    case 'trojan': {
      const password = str(p, 'password')
      if (!password) throw new ClashError('missing_field', 'trojan 缺少 password')
      return {
        protocol: 'trojan',
        server,
        port,
        credential: password,
        params: compactParams({
          ...net,
          ...tlsParams(p, { security: 'tls' }),
        }),
        name,
        raw: '',
      }
    }
    case 'hysteria2':
    case 'hysteria': {
      return {
        protocol: 'hysteria2',
        server,
        port,
        credential: str(p, 'password') ?? str(p, 'auth') ?? '',
        params: compactParams({
          sni: str(p, 'sni') ?? str(p, 'servername'),
          alpn: toStringList(p['alpn']),
          allowInsecure: toBool(p['skip-cert-verify']),
          obfs: str(p, 'obfs'),
          obfsPassword: str(p, 'obfs-password'),
          upMbps: toInt(p['up'] ?? p['up-mbps']),
          downMbps: toInt(p['down'] ?? p['down-mbps']),
          fingerprint: str(p, 'fingerprint'),
        }),
        name,
        raw: '',
      }
    }
    case 'tuic': {
      const uuid = str(p, 'uuid') ?? ''
      const password = str(p, 'password') ?? ''
      return {
        protocol: 'tuic',
        server,
        port,
        credential: uuid || password,
        params: compactParams({
          uuid,
          password,
          sni: str(p, 'sni') ?? str(p, 'servername'),
          alpn: toStringList(p['alpn']),
          congestionControl: str(p, 'congestion-controller') ?? str(p, 'congestion-control'),
          udpRelayMode: str(p, 'udp-relay-mode'),
          allowInsecure: toBool(p['skip-cert-verify']),
        }),
        name,
        raw: '',
      }
    }
    case 'socks5':
    case 'socks': {
      const username = str(p, 'username')
      const password = str(p, 'password') ?? ''
      return {
        protocol: 'socks',
        server,
        port,
        credential: username ? (password ? username + ':' + password : username) : '',
        params: compactParams({
          username,
          password,
          tls: toBool(p['tls']),
          ...(toBool(p['tls']) ? tlsParams(p) : {}),
        }),
        name,
        raw: '',
      }
    }
    case 'http': {
      const username = str(p, 'username')
      const password = str(p, 'password') ?? ''
      return {
        protocol: 'http',
        server,
        port,
        credential: username ? (password ? username + ':' + password : username) : '',
        params: compactParams({
          username,
          password,
          tls: toBool(p['tls']),
          ...(toBool(p['tls']) ? tlsParams(p) : {}),
        }),
        name,
        raw: '',
      }
    }
    default:
      throw new ClashError('bad_protocol', '不支持的 Clash 协议：' + type)
  }
}