/**
 * Xray / v2ray JSON 订阅解析：顶层或数组内的 `outbounds` -> NodeInput。
 * 只认「能映射到内部模型」的协议，其余（freedom/blackhole/dns/wireguard...）跳过不算错误。
 */

import { compactParams, toBool, toInt, toStringList } from './params'
import type { CandidateNode, NodeInput } from './types'

export interface JsonParseOutcome {
  nodes: NodeInput[]
  errors: { lineNo: number; raw: string; errorKind: string; errorMsg: string }[]
  /** 识别到但本面板不处理的 outbound（freedom/blackhole/...）数量 */
  skipped: number
}

/** 该 outbound 是否是本模块认识的代理协议 */
const KNOWN_XRAY_PROTOCOLS = new Set([
  'shadowsocks', 'ss', 'vmess', 'vless', 'trojan', 'socks', 'http',
  'hysteria2', 'hysteria', 'tuic', 'shadowsocksr', 'ssr',
])

export function looksLikeXrayConfig(json: unknown): boolean {
  const list = outboundList(json)
  if (!list || !list.length) return false
  return list.some((o) => o && typeof o === 'object' && 'protocol' in (o as object))
}

export function looksLikeSingBoxConfig(json: unknown): boolean {
  const list = outboundList(json)
  if (!list) return false
  return list.some((o) => isSingBoxOutboundShaped(o))
}

/**
 * sing-box outbound 的判别标志：`type` + `server/server_port`，
 * 且带 sing-box 独有的 `transport`/`tls` 嵌套对象。
 * 只看 type+server 会把「扁平 JSON 节点数组」误判成 sing-box（它们同样有 type/server/port）。
 */
export function isSingBoxOutboundShaped(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (!('type' in e) || 'protocol' in e) return false
  const hasServer = 'server' in e || 'server_port' in e || 'serverPort' in e
  if (!hasServer) return false
  const hasSingBoxMarker =
    (e['transport'] && typeof e['transport'] === 'object') ||
    (e['tls'] && typeof e['tls'] === 'object') ||
    'server_port' in e ||
    'serverPort' in e
  return Boolean(hasSingBoxMarker)
}

function outboundList(json: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(json)) return json as Record<string, unknown>[]
  if (json && typeof json === 'object') {
    const ob = (json as Record<string, unknown>)['outbounds']
    if (Array.isArray(ob)) return ob as Record<string, unknown>[]
  }
  return undefined
}

/** 单条是否长得像 v2ray/Xray outbound（用于数组形态的判别） */
export function isXrayOutboundShaped(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (!('protocol' in e)) return false
  const settings = (e['settings'] ?? {}) as Record<string, unknown>
  return (
    Array.isArray(settings['servers']) ||
    Array.isArray(settings['vnext']) ||
    Array.isArray(e['servers']) ||
    Array.isArray(e['vnext'])
  )
}

function serverOf(entry: Record<string, unknown>): { address: string; port: number | undefined; user: Record<string, unknown> | undefined; extra: Record<string, unknown> } | undefined {
  // v2ray/Xray 的标准位置是 settings.servers / settings.vnext；
  // 少数自建面板把 servers/vnext 直接放在 outbound 顶层，这里两种都接受。
  const settings = (entry['settings'] ?? {}) as Record<string, unknown>
  const servers = settings['servers'] ?? entry['servers']
  if (Array.isArray(servers) && servers.length) {
    const s = servers[0] as Record<string, unknown>
    return { address: String(s['address'] ?? ''), port: toInt(s['port']), user: s, extra: s }
  }
  const vnext = settings['vnext'] ?? entry['vnext']
  if (Array.isArray(vnext) && vnext.length) {
    const s = vnext[0] as Record<string, unknown>
    const users = s['users']
    const user = Array.isArray(users) && users.length ? (users[0] as Record<string, unknown>) : undefined
    return { address: String(s['address'] ?? ''), port: toInt(s['port']), user, extra: s }
  }
  return undefined
}

/** Xray outbound -> CandidateNode；无法映射时返回 { skip: true } */
export function mapXrayOutbound(
  entry: Record<string, unknown>,
): { candidate?: CandidateNode; skip?: true; reason?: string } {
  const proto = String(entry['protocol'] ?? '').toLowerCase()
  if (!KNOWN_XRAY_PROTOCOLS.has(proto)) return { skip: true, reason: '非代理 outbound：' + proto }

  const target = serverOf(entry)
  if (!target || !target.address) return { skip: true, reason: 'outbound 未包含 servers/vnext 地址' }

  const stream = (entry['streamSettings'] ?? {}) as Record<string, unknown>
  const network = stream['network'] as string | undefined
  const security = stream['security'] as string | undefined
  const tls = (stream['tlsSettings'] ?? stream['realitySettings'] ?? {}) as Record<string, unknown>
  const ws = (stream['wsSettings'] ?? {}) as Record<string, unknown>
  const grpcSettings = (stream['grpcSettings'] ?? {}) as Record<string, unknown>
  const xhttp = (stream['xhttpSettings'] ?? {}) as Record<string, unknown>
  const httpupgrade = (stream['httpupgradeSettings'] ?? {}) as Record<string, unknown>
  const kcpSettings = (stream['kcpSettings'] ?? {}) as Record<string, unknown>
  const tcpSettings = (stream['tcpSettings'] ?? {}) as Record<string, unknown>
  const wsHeaders = ws['headers'] as Record<string, unknown> | undefined
  const tcpHeader = tcpSettings['header'] as Record<string, unknown> | undefined

  const common = compactParams({
    network,
    transportSecurity: security,
    sni: tls['serverName'],
    alpn: toStringList(tls['alpn']),
    fingerprint: tls['fingerprint'],
    allowInsecure: toBool(tls['allowInsecure']),
    path: ws['path'] ?? xhttp['path'] ?? httpupgrade['path'],
    host: xhttp['host'] ?? httpupgrade['host'],
    wsHeaders,
    serviceName: grpcSettings['serviceName'],
    mode: xhttp['mode'] ?? (grpcSettings['multiMode'] === true ? 'multi' : undefined),
    headerType: tcpHeader ? tcpHeader['type'] : undefined,
    kcpSeed: kcpSettings['seed'],
    publicKey: tls['publicKey'],
    shortId: tls['shortId'],
    spiderX: tls['spiderX'],
  })

  const user = target.user ?? {}
  switch (proto) {
    case 'shadowsocks':
    case 'ss':
      return {
        candidate: {
          protocol: 'ss',
          server: target.address,
          port: target.port,
          credential: String(target.extra['password'] ?? ''),
          params: compactParams({
            method: target.extra['method'],
            plugin: target.extra['plugin'],
            pluginOptsRaw: target.extra['pluginOpts'],
            udpOverTcp: toBool(target.extra['uot']),
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'shadowsocksr':
    case 'ssr':
      return {
        candidate: {
          protocol: 'ssr',
          server: target.address,
          port: target.port,
          credential: String(target.extra['password'] ?? ''),
          params: compactParams({
            method: target.extra['method'],
            protocol: target.extra['protocol'],
            protocolParam: target.extra['protocolParam'] ?? target.extra['protoparam'],
            obfs: target.extra['obfs'],
            obfsParam: target.extra['obfsParam'] ?? target.extra['obfsparam'],
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'vmess':
      return {
        candidate: {
          protocol: 'vmess',
          server: target.address,
          port: target.port,
          credential: String(user['id'] ?? ''),
          params: compactParams({
            alterId: toInt(user['alterId']) ?? 0,
            security: user['security'],
            ...common,
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'vless':
      return {
        candidate: {
          protocol: 'vless',
          server: target.address,
          port: target.port,
          credential: String(user['id'] ?? ''),
          params: compactParams({
            flow: user['flow'],
            encryption: user['encryption'] ?? 'none',
            ...common,
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'trojan':
      return {
        candidate: {
          protocol: 'trojan',
          server: target.address,
          port: target.port,
          credential: String(target.extra['password'] ?? ''),
          params: compactParams({ ...common, transportSecurity: security ?? 'tls' }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'socks': {
      const username = user['user']
      const password = user['pass'] ?? user['password']
      const credential = username
        ? password ? String(username) + ':' + String(password) : String(username)
        : ''
      return {
        candidate: {
          protocol: 'socks',
          server: target.address,
          port: target.port,
          credential,
          params: compactParams({ username, password, tls: security === 'tls', ...common }),
          name: String(entry['tag'] ?? ''),
        },
      }
    }
    case 'http': {
      const username = user['user'] ?? user['username']
      const password = user['pass'] ?? user['password']
      const credential = username
        ? password ? String(username) + ':' + String(password) : String(username)
        : ''
      return {
        candidate: {
          protocol: 'http',
          server: target.address,
          port: target.port,
          credential,
          params: compactParams({ username, password, tls: security === 'tls', ...common }),
          name: String(entry['tag'] ?? ''),
        },
      }
    }
    case 'hysteria2':
    case 'hysteria':
      return {
        candidate: {
          protocol: 'hysteria2',
          server: target.address,
          port: target.port,
          credential: String(target.extra['password'] ?? target.extra['auth'] ?? user['password'] ?? ''),
          params: compactParams({ sni: common.sni, alpn: common.alpn, allowInsecure: common.allowInsecure }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'tuic':
      return {
        candidate: {
          protocol: 'tuic',
          server: target.address,
          port: target.port,
          credential: String(target.extra['uuid'] ?? user['uuid'] ?? ''),
          params: compactParams({
            uuid: target.extra['uuid'] ?? user['uuid'],
            password: target.extra['password'] ?? user['password'],
            sni: common.sni,
            alpn: common.alpn,
            congestionControl: target.extra['congestion_control'] ?? target.extra['congestionControl'],
            allowInsecure: common.allowInsecure,
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    default:
      return { skip: true, reason: '未映射的协议：' + proto }
  }
}

export function parseXrayConfig(json: unknown, sourceSubscriptionId: string): JsonParseOutcome {
  const list = outboundList(json) ?? []
  return collect(list, sourceSubscriptionId, mapXrayOutbound)
}

export function collect(
  list: Record<string, unknown>[],
  sourceSubscriptionId: string,
  mapper: (entry: Record<string, unknown>) => { candidate?: CandidateNode; skip?: true; reason?: string },
): JsonParseOutcome {
  const nodes: NodeInput[] = []
  const errors: JsonParseOutcome['errors'] = []
  let skipped = 0
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    const lineNo = i + 1
    if (!entry || typeof entry !== 'object') {
      errors.push({ lineNo, raw: JSON.stringify(entry).slice(0, 200), errorKind: 'bad_json', errorMsg: '条目不是对象' })
      continue
    }
    let mapped: { candidate?: CandidateNode; skip?: true; reason?: string }
    try {
      mapped = mapper(entry)
    } catch (err) {
      errors.push({
        lineNo,
        raw: JSON.stringify(entry).slice(0, 200),
        errorKind: 'bad_json',
        errorMsg: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (mapped.skip || !mapped.candidate) {
      skipped++
      continue
    }
    const c = mapped.candidate
    const port = toInt(c.port)
    const server = (c.server ?? '').trim()
    if (!server || port === undefined || port <= 0 || port > 65535) {
      errors.push({
        lineNo,
        raw: JSON.stringify(entry).slice(0, 200),
        errorKind: !server ? 'missing_field' : 'bad_port',
        errorMsg: !server ? '缺少服务器地址' : '非法端口：' + String(c.port ?? ''),
      })
      continue
    }
    nodes.push({
      protocol: c.protocol as NodeInput['protocol'],
      server,
      port,
      credential: c.credential ?? '',
      params: compactParams(c.params ?? {}),
      name: (c.name ?? '').trim(),
      raw: JSON.stringify(entry),
      sourceSubscriptionId,
    })
  }
  return { nodes, errors, skipped }
}