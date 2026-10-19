/**
 * sing-box JSON 订阅解析（PANEL.md §7.2 第 2 步）。
 * sing-box 用 `type` 而不是 `protocol`，并且把传输层/安全层放平在 outbound 顶层；
 * 这里把两者都摊到 params 上，归一化阶段再翻译成 Xray 的 streamSettings。
 */

import {
  collect, isSingBoxOutboundShaped, isXrayOutboundShaped, mapXrayOutbound, type JsonParseOutcome,
} from './xray-json'
import { cleanPath, compactParams, toBool, toInt, toStringList } from './params'
import type { CandidateNode } from './types'

const KNOWN_SINGBOX_TYPES = new Set([
  'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'hysteria',
  'tuic', 'socks', 'http',
])

function tlsOf(entry: Record<string, unknown>): Record<string, unknown> {
  const tls = entry['tls']
  if (!tls || typeof tls !== 'object') return {}
  const t = tls as Record<string, unknown>
  let security: string | undefined
  if (t['reality'] && typeof t['reality'] === 'object') security = 'reality'
  else if (t['enabled'] === true) security = 'tls'
  else if (t['enabled'] === false) security = 'none'
  const reality = (t['reality'] ?? {}) as Record<string, unknown>
  const utls = t['utls'] as Record<string, unknown> | undefined
  return compactParams({
    transportSecurity: security,
    sni: t['server_name'] ?? t['serverName'],
    alpn: toStringList(t['alpn']),
    fingerprint: utls && toBool(utls['enabled']) === true ? utls['fingerprint'] : undefined,
    allowInsecure: toBool(t['insecure']),
    publicKey: reality['public_key'] ?? reality['publicKey'],
    shortId: reality['short_id'] ?? reality['shortId'],
  })
}

function transportOf(entry: Record<string, unknown>): Record<string, unknown> {
  const tr = entry['transport']
  if (!tr || typeof tr !== 'object') return {}
  const t = tr as Record<string, unknown>
  const type = String(t['type'] ?? '').toLowerCase()
  const network = type === 'http' ? 'xhttp' : type
  const headers = t['headers'] as Record<string, unknown> | undefined
  return compactParams({
    network,
    path: cleanPath(typeof t['path'] === 'string' ? t['path'] : undefined),
    host: t['host'] ?? (headers && typeof headers['Host'] === 'string' ? headers['Host'] : undefined),
    serviceName: t['service_name'] ?? t['serviceName'],
    headerType: t['header'] && typeof t['header'] === 'object'
      ? (t['header'] as Record<string, unknown>)['type']
      : undefined,
    kcpSeed: t['seed'],
  })
}

export function mapSingBoxOutbound(
  entry: Record<string, unknown>,
): { candidate?: CandidateNode; skip?: true; reason?: string } {
  const type = String(entry['type'] ?? '').toLowerCase()
  if (!KNOWN_SINGBOX_TYPES.has(type)) return { skip: true, reason: '非代理 outbound：' + type }

  const server = String(entry['server'] ?? '')
  const port = toInt(entry['server_port'] ?? entry['serverPort'])
  const net = transportOf(entry)
  const tls = tlsOf(entry)

  switch (type) {
    case 'shadowsocks':
      return {
        candidate: {
          protocol: 'ss',
          server,
          port,
          credential: String(entry['password'] ?? ''),
          params: compactParams({ method: entry['method'], ...net }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'vmess':
      return {
        candidate: {
          protocol: 'vmess',
          server,
          port,
          credential: String(entry['uuid'] ?? ''),
          params: compactParams({
            alterId: toInt(entry['alter_id'] ?? entry['alterId']) ?? 0,
            security: entry['security'] ?? entry['cipher'] ?? 'auto',
            ...net,
            ...tls,
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'vless':
      return {
        candidate: {
          protocol: 'vless',
          server,
          port,
          credential: String(entry['uuid'] ?? ''),
          params: compactParams({ flow: entry['flow'], encryption: 'none', ...net, ...tls }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'trojan':
      return {
        candidate: {
          protocol: 'trojan',
          server,
          port,
          credential: String(entry['password'] ?? ''),
          params: compactParams({ ...net, ...tls, transportSecurity: tls['transportSecurity'] ?? 'tls' }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'hysteria2':
    case 'hysteria':
      return {
        candidate: {
          protocol: 'hysteria2',
          server,
          port,
          credential: String(entry['password'] ?? entry['auth_str'] ?? entry['auth'] ?? ''),
          params: compactParams({
            sni: tls['sni'],
            alpn: tls['alpn'],
            allowInsecure: tls['allowInsecure'],
            obfs: entry['obfs'] && typeof entry['obfs'] === 'object'
              ? (entry['obfs'] as Record<string, unknown>)['type']
              : undefined,
            obfsPassword: entry['obfs'] && typeof entry['obfs'] === 'object'
              ? (entry['obfs'] as Record<string, unknown>)['password']
              : undefined,
            upMbps: toInt(entry['up_mbps'] ?? entry['upMbps']),
            downMbps: toInt(entry['down_mbps'] ?? entry['downMbps']),
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'tuic':
      return {
        candidate: {
          protocol: 'tuic',
          server,
          port,
          credential: String(entry['uuid'] ?? entry['password'] ?? ''),
          params: compactParams({
            uuid: entry['uuid'],
            password: entry['password'],
            sni: tls['sni'],
            alpn: tls['alpn'],
            allowInsecure: tls['allowInsecure'],
            congestionControl: entry['congestion_control'] ?? entry['congestionControl'],
            udpRelayMode: entry['udp_relay_mode'] ?? entry['udpRelayMode'],
          }),
          name: String(entry['tag'] ?? ''),
        },
      }
    case 'socks': {
      const username = entry['username']
      const password = entry['password']
      return {
        candidate: {
          protocol: 'socks',
          server,
          port,
          credential: username
            ? password ? String(username) + ':' + String(password) : String(username)
            : '',
          params: compactParams({ username, password, tls: tls['transportSecurity'] === 'tls', ...tls }),
          name: String(entry['tag'] ?? ''),
        },
      }
    }
    case 'http': {
      const username = entry['username']
      const password = entry['password']
      return {
        candidate: {
          protocol: 'http',
          server,
          port,
          credential: username
            ? password ? String(username) + ':' + String(password) : String(username)
            : '',
          params: compactParams({ username, password, tls: tls['security'] === 'tls', ...tls }),
          name: String(entry['tag'] ?? ''),
        },
      }
    }
    default:
      return { skip: true, reason: '未映射的协议：' + type }
  }
}

export function parseSingBoxConfig(json: unknown, sourceSubscriptionId: string): JsonParseOutcome {
  let list: Record<string, unknown>[] = []
  if (Array.isArray(json)) list = json as Record<string, unknown>[]
  else if (json && typeof json === 'object') {
    const ob = (json as Record<string, unknown>)['outbounds']
    if (Array.isArray(ob)) list = ob as Record<string, unknown>[]
  }
  return collect(list, sourceSubscriptionId, mapSingBoxOutbound)
}

/* ------------------------------------------------ JSON 节点数组（自建面板） */

const JSON_ARRAY_TYPE_KEYS = ['type', 'protocol', 'kind', 'scheme'] as const

function pick(entry: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = entry[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * `[{...}]` 形态的节点数组：字段名混乱，按多候选键取值。
 * 先尝试 Xray/sing-box 的 outbound 形态，再退化到扁平字段。
 */
export function parseJsonNodeArray(json: unknown, sourceSubscriptionId: string): JsonParseOutcome {
  if (!Array.isArray(json)) {
    return {
      nodes: [],
      errors: [{ lineNo: 1, raw: '', errorKind: 'bad_json', errorMsg: '顶层不是数组' }],
      skipped: 0,
    }
  }
  const list = json as Record<string, unknown>[]
  // outbound 形态：sing-box 的 type+server/server_port，或 Xray 的 protocol+settings.servers/vnext
  const isSingBoxOutbound = list.some((e) => isSingBoxOutboundShaped(e))
  if (isSingBoxOutbound) return parseSingBoxConfig(list, sourceSubscriptionId)

  const isXrayOutbound = list.some((e) => isXrayOutboundShaped(e))
  if (isXrayOutbound) return collect(list, sourceSubscriptionId, mapXrayOutbound)

  return collect(list, sourceSubscriptionId, mapFlatNode)
}

function mapFlatNode(entry: Record<string, unknown>): { candidate?: CandidateNode; skip?: true; reason?: string } {
  const rawType = pick(entry, [...JSON_ARRAY_TYPE_KEYS])
  const type = String(rawType ?? '').toLowerCase()
  if (!type) return { skip: true, reason: '缺少 type 字段' }
  const server = String(pick(entry, ['server', 'address', 'host', 'add']) ?? '')
  const port = toInt(pick(entry, ['port', 'server_port', 'serverPort']))
  const name = String(pick(entry, ['name', 'ps', 'remark', 'tag', 'title']) ?? '')
  const password = String(pick(entry, ['password', 'pass', 'auth', 'auth_str']) ?? '')
  const uuid = String(pick(entry, ['uuid', 'id', 'user_id']) ?? '')
  const method = String(pick(entry, ['method', 'cipher', 'scy']) ?? '')
  const net = compactParams({
    network: pick(entry, ['network', 'net', 'transport']),
    path: cleanPath(String(pick(entry, ['path', 'ws_path']) ?? '')),
    host: pick(entry, ['host', 'ws_host', 'servername', 'sni']),
    serviceName: pick(entry, ['serviceName', 'service_name', 'grpc_service_name']),
    transportSecurity: pick(entry, ['security', 'tls']),
    sni: pick(entry, ['sni', 'servername', 'server_name']),
    alpn: toStringList(pick(entry, ['alpn'])),
    fingerprint: pick(entry, ['fp', 'fingerprint', 'client-fingerprint']),
    allowInsecure: toBool(pick(entry, ['allowInsecure', 'skip-cert-verify', 'insecure'])),
    publicKey: pick(entry, ['pbk', 'publicKey', 'public_key']),
    shortId: pick(entry, ['sid', 'shortId', 'short_id']),
    flow: pick(entry, ['flow']),
  })
  const alterId = toInt(pick(entry, ['alterId', 'alter_id', 'aid'])) ?? 0

  switch (type) {
    case 'ss':
    case 'shadowsocks':
      return { candidate: { protocol: 'ss', server, port, credential: password, params: { method, ...net }, name } }
    case 'ssr':
    case 'shadowsocksr':
      return {
        candidate: {
          protocol: 'ssr',
          server,
          port,
          credential: password,
          params: compactParams({
            method,
            protocol: entry['protocol'],
            obfs: entry['obfs'],
            obfsParam: entry['obfsParam'],
            protocolParam: entry['protocolParam'],
          }),
          name,
        },
      }
    case 'vmess':
      return {
        candidate: {
          protocol: 'vmess',
          server,
          port,
          credential: uuid,
          params: { alterId, security: method || 'auto', ...net },
          name,
        },
      }
    case 'vless':
      return { candidate: { protocol: 'vless', server, port, credential: uuid, params: { encryption: 'none', ...net }, name } }
    case 'trojan':
      return { candidate: { protocol: 'trojan', server, port, credential: password, params: net, name } }
    case 'hysteria2':
    case 'hy2':
    case 'hysteria':
      return { candidate: { protocol: 'hysteria2', server, port, credential: password || uuid, params: net, name } }
    case 'tuic':
      return {
        candidate: {
          protocol: 'tuic',
          server,
          port,
          credential: uuid || password,
          params: compactParams({ uuid, password, ...net }),
          name,
        },
      }
    case 'socks':
    case 'socks5':
      return {
        candidate: {
          protocol: 'socks',
          server,
          port,
          credential: String(pick(entry, ['username', 'user']) ?? '') || password,
          params: compactParams({ username: pick(entry, ['username', 'user']), password, ...net }),
          name,
        },
      }
    case 'http':
    case 'https':
      return {
        candidate: {
          protocol: 'http',
          server,
          port,
          credential: String(pick(entry, ['username', 'user']) ?? '') || password,
          params: compactParams({ username: pick(entry, ['username', 'user']), password, ...net }),
          name,
        },
      }
    default:
      return { skip: true, reason: '未知类型：' + type }
  }
}