/**
 * 分享链接（ss/ssr/vmess/vless/trojan/hysteria2/tuic/socks/http）的逐行解析。
 * 每条协议返回 CandidateNode（字段尽力而为），统一由 finalize 校验并转成 NodeInput。
 */

import { unfoldText, tryBase64Decode } from './b64'
import { decodeComponent, decodeFragment, parseQuery, parseSsUserInfo, splitLink } from './link-uri'
import {
  cleanPath, compactParams, normalizeNetwork, parsePluginOpts,
  toBool, toInt, toStringList,
} from './params'
import type { CandidateNode, NodeInput, ParseOne } from './types'

export interface LinkContext {
  sourceSubscriptionId: string
}

/** 链接里出现的明文 scheme（用于格式识别第 5 步） */
export const LINK_SCHEMES = [
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'hysteria',
  'tuic', 'socks', 'socks5', 'socks4', 'http', 'https',
] as const

/** SS 加密方法名（aes-256-gcm / 2022-blake3-aes-128-gcm / chacha20-ietf-poly1305 ...） */
const SS_METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/

const LINK_SCHEME_RE = new RegExp(
  '^(?:' + LINK_SCHEMES.join('|') + ')://',
  'i',
)

export function isLinkLine(line: string): boolean {
  return LINK_SCHEME_RE.test(line.trim())
}

/** 把一行分享链接解析为节点；失败给出错误分类 */
export function parseLinkLine(line: string, ctx: LinkContext): ParseOne {
  const trimmed = line.trim()
  if (!trimmed) return { ok: false, protocol: '', errorKind: 'bad_link', errorMsg: '空行' }

  const link = splitLink(trimmed)
  if (!link) return { ok: false, protocol: '', errorKind: 'bad_link', errorMsg: '不是合法的分享链接' }

  try {
    switch (link.scheme) {
      case 'ss': return finalize(parseSs(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'ssr': return finalize(parseSsr(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'vmess': return finalize(parseVmess(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'vless': return finalize(parseVless(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'trojan': return finalize(parseTrojan(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'hysteria2':
      case 'hy2':
      case 'hysteria': return finalize(parseHysteria2(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'tuic': return finalize(parseTuic(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'socks':
      case 'socks5': return finalize(parseSocks(link.raw, link.rest, link.fragmentRaw), ctx)
      case 'socks4':
        return { ok: false, protocol: 'socks', errorKind: 'bad_protocol', errorMsg: 'Socks4 出站不被支持，请使用 socks5' }
      case 'http':
      case 'https': return finalize(parseHttp(link.raw, link.rest, link.fragmentRaw), ctx)
      default:
        return { ok: false, protocol: link.scheme, errorKind: 'bad_protocol', errorMsg: '未知协议：' + link.scheme }
    }
  } catch (err) {
    return {
      ok: false,
      protocol: link.scheme,
      errorKind: 'bad_link',
      errorMsg: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 把 CandidateNode 补齐为 NodeInput 并做最小校验 */
function finalize(c: CandidateNode, ctx: LinkContext): ParseOne {
  const protocol = c.protocol
  const server = (c.server ?? '').trim().replace(/^\[|\]$/g, '')
  if (!server) {
    return { ok: false, protocol, errorKind: 'missing_field', errorMsg: '缺少服务器地址' }
  }
  const port = toInt(c.port)
  if (port === undefined || port <= 0 || port > 65535) {
    return { ok: false, protocol, errorKind: 'bad_port', errorMsg: '非法端口：' + String(c.port ?? '') }
  }
  const node: NodeInput = {
    protocol: protocol as NodeInput['protocol'],
    server,
    port,
    credential: c.credential ?? '',
    params: compactParams(c.params ?? {}),
    name: (c.name ?? '').trim(),
    raw: c.raw ?? '',
    sourceSubscriptionId: ctx.sourceSubscriptionId,
  }
  return { ok: true, node }
}

/* ------------------------------------------------------------------ ss */

function parseSs(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  // SIP002：ss://<userinfo>@<host>:<port>?plugin=...  或  ss://<base64(method:pass@host:port)>#name
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest

  let userinfo = ''
  let hostport = ''

  const at = findUserInfoSeparator(beforeQuery)
  if (at >= 0) {
    userinfo = beforeQuery.slice(0, at)
    hostport = beforeQuery.slice(at + 1)
  } else {
    // 整体 base64 包裹的 legacy 写法
    const decoded = tryBase64Decode(beforeQuery)
    if (!decoded) throw new Error('SS 链接既没有 userinfo@host 结构，也不是合法的 base64')
    const innerAt = findUserInfoSeparator(decoded)
    if (innerAt < 0) throw new Error('SS base64 载荷里缺少 method:password@host:port 结构')
    userinfo = decoded.slice(0, innerAt)
    hostport = decoded.slice(innerAt + 1)
  }

  const { host, port } = splitHostPort(hostport)
  const cred = parseSsUserInfo(decodeComponent(userinfo))
  if (!cred) throw new Error('SS 凭据无法解析')
  // 合法性闸门：method 必须像加密算法名；否则整个链接判定为坏行
  // （避免把 `ss://<垃圾>@host:port` 当成 method 为空的节点）
  if (cred.method && !SS_METHOD_RE.test(cred.method)) {
    throw new Error('SS method 非法：' + cred.method)
  }
  if (!cred.method && !query['method']) {
    throw new Error('SS 链接缺少 method')
  }

  const params: Record<string, unknown> = { method: cred.method }
  applySsPluginParams(params, query)

  for (const [k, v] of Object.entries(query)) {
    if (k === 'plugin' || k === 'plugin-opts' || k === 'plugin_opts') continue
    if (k === 'method' && !params.method) params.method = v
    if (k === 'uot') params.udpOverTcp = toBool(v)
  }
  return {
    protocol: 'ss',
    server: host,
    port,
    credential: cred.password,
    params,
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/** 找到 userinfo 与 host 的分隔 '@'（host 部分不会带 '@'，取最后一个） */
function findUserInfoSeparator(s: string): number {
  const idx = s.lastIndexOf('@')
  if (idx < 0) return -1
  // 排除 IPv6 字面量内部的 @（几乎不存在，但防御一下）
  return idx
}

/** plugin=obfs-local;obfs=http;obfs-host=x 与 plugin=v2ray-plugin 的常见写法 */
export function applySsPluginParams(params: Record<string, unknown>, query: Record<string, string>): void {
  const plugin = query['plugin']
  if (!plugin) return
  const semi = plugin.indexOf(';')
  const name = (semi >= 0 ? plugin.slice(0, semi) : plugin).trim()
  const inlineOpts = semi >= 0 ? plugin.slice(semi + 1) : ''
  const queryOpts = query['plugin-opts'] ?? query['plugin_opts'] ?? ''
  const optsText = [inlineOpts, queryOpts].filter(Boolean).join(';')
  params.plugin = name
  const opts = parsePluginOpts(optsText)
  if (Object.keys(opts).length) params.pluginOpts = opts
  if (Object.keys(opts).length) params.pluginOptsRaw = optsText
}

/* ----------------------------------------------------------------- ssr */

function parseSsr(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  // 两种写法都存在：
  //   A) SSR 标准形态：整段 base64，参数在**解码后**的载荷里（...base64password/?obfsparam=..）
  //   B) 少数站点把参数放在 base64 之外（...base64payload?obfsparam=..）
  // 因此先按 B 切一次，解码后再按 A 补一次，后者覆盖前者。
  const outerQ = rest.indexOf('?')
  const outerQuery = outerQ >= 0 ? parseQuery(rest.slice(outerQ + 1)) : {}
  let body = outerQ >= 0 ? rest.slice(0, outerQ) : rest
  // 载荷里未编码的 '/' 会把 query 一起裹进 base64，先把 query 摘出来再加入解码输入
  const slashQ = body.indexOf('/?')
  let innerQueryText = ''
  if (slashQ >= 0) {
    innerQueryText = body.slice(slashQ + 2)
    body = body.slice(0, slashQ)
  }
  const decoded = tryBase64Decode(body)
  if (!decoded) throw new Error('SSR 载荷不是合法的 base64')

  const innerQ = decoded.indexOf('?')
  const innerQuery = innerQ >= 0
    ? parseQuery(decoded.slice(innerQ + 1))
    : innerQueryText ? parseQuery(innerQueryText) : {}
  const payloadText = innerQ >= 0 ? decoded.slice(0, innerQ) : decoded

  const query: Record<string, string> = { ...innerQuery, ...outerQuery }
  // 载荷形态：host:port:protocol:method:obfs:base64(password)[/]
  const parts = payloadText.replace(/\/+$/, '').split(':')
  if (parts.length < 6) {
    throw new Error('SSR 载荷字段不足（需要 host:port:protocol:method:obfs:password_base64）')
  }
  const passwordB64 = parts.slice(5).join(':').split(/[?/]/)[0]
  const password = tryBase64Decode(passwordB64) ?? passwordB64

  // 注意：parseQuery 已经做过一次 decodeURIComponent，这里只补 base64 解码
  const obfsParam = decodeBase64Maybe(cleanQueryValue(query['obfsparam'] ?? query['obfs-param'] ?? ''))
  const protocolParam = decodeBase64Maybe(cleanQueryValue(query['protoparam'] ?? query['protocol-param'] ?? ''))
  const remarks = decodeBase64Maybe(cleanQueryValue(query['remarks'] ?? ''))

  return {
    protocol: 'ssr',
    server: parts[0],
    port: toInt(parts[1]),
    credential: password,
    params: compactParams({
      method: parts[3],
      protocol: parts[2],
      protocolParam,
      obfs: parts[4],
      obfsParam,
      group: query['group'],
    }),
    name: decodeFragment(fragmentRaw) || remarks,
    raw,
  }
}

/**
 * SSR 的 obfsparam/protoparam/remarks 约定是 base64url，但大量站点直接给明文。
 * 只有在「解码结果确实像结构化内容」时才采用解码值。
 */
function cleanQueryValue(value: string): string {
  // query 里可能残留 `key=value/` 的收尾斜杠
  return value.trim().replace(/\/+$/, '')
}

function decodeBase64Maybe(value: string): string {
  const v = value.trim()
  if (!v) return ''
  if (!/^[A-Za-z0-9_+\-/]+={0,2}$/.test(v) || v.length < 6) return v
  const decoded = tryBase64Decode(v)
  if (decoded === undefined) return v
  const looksLikeText = /[\u4e00-\u9fff\s]/.test(decoded) || /^[A-Za-z0-9.-]+$/.test(decoded)
  if (!looksLikeText) return v
  if (decoded.trim() === '') return v
  return decoded.trim()
}

/* --------------------------------------------------------------- vmess */

function parseVmess(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const body = rest.split('?')[0]
  const query = rest.includes('?') ? parseQuery(rest.slice(rest.indexOf('?') + 1)) : {}

  // base64 JSON（标准写法）；少数站点直接给明文 JSON
  let json: Record<string, unknown> | undefined
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      throw new Error('VMess 明文 JSON 解析失败')
    }
  } else {
    const decoded = tryBase64Decode(trimmed)
    if (!decoded) throw new Error('VMess 载荷不是合法的 base64 或 JSON')
    try {
      json = JSON.parse(decoded) as Record<string, unknown>
    } catch {
      throw new Error('VMess base64 解码后不是合法 JSON')
    }
  }

  const cfg = json as {
    v?: string; ps?: string; add?: string; port?: string | number
    id?: string; aid?: string | number; scy?: string; net?: string; type?: string
    host?: string; path?: string; tls?: string; sni?: string; alpn?: string
    fp?: string; allowInsecure?: string | number | boolean; serviceName?: string
  }

  if (!cfg.id || !String(cfg.id).trim()) throw new Error('VMess 缺少 id（uuid）')

  const network = normalizeNetwork(cfg.net ?? '')
  const tls = (cfg.tls ?? '').toString().toLowerCase()
  const security = tls === 'tls' || tls === 'reality' || tls === 'xtls' ? tls : tls === 'none' ? 'none' : undefined

  const queryNet = normalizeNetwork(query['type'] ?? query['net'] ?? '')
  const finalNet = queryNet ?? network
  const path = cleanPath(cfg.path ?? query['path'])
  const host = cfg.host ?? query['host'] ?? ''
  const serviceName = cfg.serviceName ?? query['serviceName'] ?? ''
  const sni = cfg.sni ?? query['sni'] ?? host

  return {
    protocol: 'vmess',
    server: cfg.add ?? '',
    port: toInt(cfg.port),
    credential: cfg.id ?? '',
    params: compactParams({
      alterId: toInt(cfg.aid) ?? 0,
      security: (cfg.scy ?? query['scy'] ?? 'auto').toString(),
      network: finalNet,
      headerType: cfg.type,
      path,
      host,
      serviceName,
      transportSecurity: security ?? query['security'],
      sni,
      alpn: toStringList(cfg.alpn ?? query['alpn']),
      fingerprint: cfg.fp ?? query['fp'],
      allowInsecure: toBool(cfg.allowInsecure ?? query['allowInsecure'] ?? query['insecure']),
      remark: cfg.ps,
      v: cfg.v,
    }),
    name: decodeFragment(fragmentRaw) || (cfg.ps ?? ''),
    raw,
  }
}

/* --------------------------------------------------------------- vless */

function parseVless(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  if (at < 0) throw new Error('VLESS 链接缺少 uuid@host:port 结构')
  const uuid = decodeComponent(beforeQuery.slice(0, at))
  const { host, port } = splitHostPort(beforeQuery.slice(at + 1))
  if (!uuid) throw new Error('VLESS 链接缺少 uuid')

  return {
    protocol: 'vless',
    server: host,
    port,
    credential: uuid,
    params: compactParams({
      flow: query['flow'],
      encryption: query['encryption'] ?? 'none',
      network: normalizeNetwork(query['type']),
      path: cleanPath(query['path']),
      host: query['host'],
      serviceName: query['serviceName'],
      mode: query['mode'],
      headerType: query['headerType'],
      transportSecurity: query['security'],
      sni: query['sni'],
      alpn: toStringList(query['alpn']),
      fingerprint: query['fp'],
      publicKey: query['pbk'],
      shortId: query['sid'],
      spiderX: query['spx'],
      allowInsecure: toBool(query['allowInsecure'] ?? query['insecure']),
      kcpSeed: query['seed'],
    }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/* -------------------------------------------------------------- trojan */

function parseTrojan(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  if (at < 0) throw new Error('Trojan 链接缺少 password@host:port 结构')
  const password = decodeComponent(beforeQuery.slice(0, at))
  const { host, port } = splitHostPort(beforeQuery.slice(at + 1))
  if (!password) throw new Error('Trojan 链接缺少 password')

  return {
    protocol: 'trojan',
    server: host,
    port,
    credential: password,
    params: compactParams({
      network: normalizeNetwork(query['type']),
      path: cleanPath(query['path']),
      host: query['host'],
      serviceName: query['serviceName'],
      transportSecurity: query['security'] ?? (query['sni'] || query['allowInsecure'] ? 'tls' : undefined),
      sni: query['sni'],
      alpn: toStringList(query['alpn']),
      fingerprint: query['fp'],
      allowInsecure: toBool(query['allowInsecure'] ?? query['insecure']),
    }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/* ----------------------------------------------------------- hysteria2 */

function parseHysteria2(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  let userinfo = ''
  let hostport = beforeQuery
  if (at >= 0) {
    userinfo = decodeComponent(beforeQuery.slice(0, at))
    hostport = beforeQuery.slice(at + 1)
  }
  const { host, port } = splitHostPort(hostport)
  const auth = userinfo || (query['auth'] ?? query['password'] ?? '')

  return {
    protocol: 'hysteria2',
    server: host,
    port,
    credential: auth,
    params: compactParams({
      sni: query['sni'] ?? query['peer'],
      alpn: toStringList(query['alpn']),
      allowInsecure: toBool(query['insecure'] ?? query['allowInsecure']),
      obfs: query['obfs'],
      obfsPassword: query['obfs-password'] ?? query['obfs_password'],
      upMbps: toInt(query['upmbps'] ?? query['up']),
      downMbps: toInt(query['downmbps'] ?? query['down']),
      fingerprint: query['pinSHA256'],
    }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/* ---------------------------------------------------------------- tuic */

function parseTuic(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  if (at < 0) throw new Error('TUIC 链接缺少 userinfo@host:port 结构')
  const userinfo = decodeComponent(beforeQuery.slice(0, at))
  const { host, port } = splitHostPort(beforeQuery.slice(at + 1))
  const colon = userinfo.indexOf(':')
  const uuid = colon >= 0 ? userinfo.slice(0, colon) : userinfo
  const password = colon >= 0 ? userinfo.slice(colon + 1) : ''

  return {
    protocol: 'tuic',
    server: host,
    port,
    credential: uuid || password,
    params: compactParams({
      uuid,
      password,
      sni: query['sni'],
      alpn: toStringList(query['alpn']),
      congestionControl: query['congestion_control'] ?? query['congestion-control'],
      udpRelayMode: query['udp_relay_mode'] ?? query['udp-relay-mode'],
      allowInsecure: toBool(query['allow_insecure'] ?? query['insecure']),
      disableSni: toBool(query['disable_sni']),
    }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/* -------------------------------------------------------- socks / http */

function parseSocks(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  let user = ''
  let pass = ''
  let hostport = beforeQuery
  if (at >= 0) {
    const userinfo = decodeComponent(beforeQuery.slice(0, at))
    const colon = userinfo.indexOf(':')
    user = colon >= 0 ? userinfo.slice(0, colon) : userinfo
    pass = colon >= 0 ? userinfo.slice(colon + 1) : ''
    hostport = beforeQuery.slice(at + 1)
  }
  const { host, port } = splitHostPort(hostport)
  const hasAuth = user !== '' || pass !== ''
  return {
    protocol: 'socks',
    server: host,
    port,
    credential: hasAuth ? (pass ? user + ':' + pass : user) : '',
    params: compactParams({ username: user, password: pass, tls: toBool(query['tls']) }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

function parseHttp(raw: string, rest: string, fragmentRaw: string): CandidateNode {
  const qIdx = rest.indexOf('?')
  const query = qIdx >= 0 ? parseQuery(rest.slice(qIdx + 1)) : {}
  const beforeQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const at = beforeQuery.lastIndexOf('@')
  let user = ''
  let pass = ''
  let hostport = beforeQuery
  if (at >= 0) {
    const userinfo = decodeComponent(beforeQuery.slice(0, at))
    const colon = userinfo.indexOf(':')
    user = colon >= 0 ? userinfo.slice(0, colon) : userinfo
    pass = colon >= 0 ? userinfo.slice(colon + 1) : ''
    hostport = beforeQuery.slice(at + 1)
  }
  const { host, port } = splitHostPort(hostport)
  const hasAuth = user !== '' || pass !== ''
  const tls = toBool(query['tls'])
  return {
    protocol: 'http',
    server: host,
    port,
    credential: hasAuth ? (pass ? user + ':' + pass : user) : '',
    params: compactParams({
      username: user,
      password: pass,
      tls,
      sni: query['sni'],
      allowInsecure: toBool(query['allowInsecure'] ?? query['insecure']),
    }),
    name: decodeFragment(fragmentRaw),
    raw,
  }
}

/** host:port 切分，兼容 [v6]:port 与 host（缺 port 时 port 为 undefined） */
export function splitHostPort(input: string): { host: string; port: number | undefined } {
  let s = input.trim()
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(0, slash)
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close > 0) {
      const host = s.slice(1, close)
      const rest = s.slice(close + 1)
      const port = rest.startsWith(':') ? toInt(rest.slice(1)) : undefined
      return { host, port }
    }
  }
  const idx = s.lastIndexOf(':')
  if (idx < 0) return { host: s, port: undefined }
  return { host: s.slice(0, idx), port: toInt(s.slice(idx + 1)) }
}

/** 逐行「能解析多少算多少」：返回成功节点与坏行，调用方决定是否作为兜底格式 */
export function parseLinkFragments(
  body: string,
  ctx: LinkContext,
): { nodes: NodeInput[]; rejected: { lineNo: number; raw: string }[] } {
  const nodes: NodeInput[] = []
  const rejected: { lineNo: number; raw: string }[] = []
  const lines = unfoldText(body).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    if (!isLinkLine(line)) {
      rejected.push({ lineNo: i + 1, raw: line })
      continue
    }
    const one = parseLinkLine(line, ctx)
    if (one.ok) nodes.push(one.node)
    else rejected.push({ lineNo: i + 1, raw: line })
  }
  return { nodes, rejected }
}

/** 供 base64/links 订阅体使用：逐行解析，错误行只计数 */
export function parseLinkLines(
  body: string,
  ctx: LinkContext,
): { nodes: NodeInput[]; errors: { lineNo: number; raw: string; errorKind: string; errorMsg: string }[] } {
  const nodes: NodeInput[] = []
  const errors: { lineNo: number; raw: string; errorKind: string; errorMsg: string }[] = []
  const lines = unfoldText(body).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    if (!isLinkLine(line)) {
      errors.push({ lineNo: i + 1, raw: line, errorKind: 'bad_link', errorMsg: '不是受支持的分享链接' })
      continue
    }
    const one = parseLinkLine(line, ctx)
    if (one.ok) nodes.push(one.node)
    else errors.push({ lineNo: i + 1, raw: line, errorKind: one.errorKind, errorMsg: one.errorMsg })
  }
  return { nodes, errors }
}