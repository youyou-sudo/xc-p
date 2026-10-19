import { AppError, validationFailed } from '../core/errors'

 export function outboundTag(nodeId: string): string {
  return `out-${sanitizeTag(nodeId)}`
}
export function inboundTag(nodeId: string): string {
  return `in-${sanitizeTag(nodeId)}`
}
export function ruleTag(nodeId: string): string {
  return `node-${sanitizeTag(nodeId)}`
}

/** tag 只允许 [A-Za-z0-9_.-]，其余字符替换为 - */
export function sanitizeTag(id: string): string {
  const s = id.trim().replace(/[^A-Za-z0-9_.-]/g, '-')
  return s.length ? s : 'node'
}

/**
 * 参数变化的节点使用「内容派生后缀」得到新 tag（PANEL.md D2「修改 → 新 tag」）：
 *   out-hk01.7f3a2b / in-hk01.7f3a2b / node-hk01.7f3a2b
 * 后缀由 outbound 内容哈希派生，因此「参数没变 → tag 不变」（keep 完全不碰），
 * 「参数变了 → tag 变」（走新 tag 上线 + 旧 tag 退休，已有连接不受影响）。
 * 节点 ID 本身不含 '.'，所以反解是安全的。
 */
export const VARIANT_SEP = '.'

 /**
 * 节点环回入站：http 协议、只绑 127.0.0.1（PANEL.md D1 / §5.1）。
 * tagOverride 用于「参数变化 = 新 tag」路径（与出站的 `.` 后缀保持一致）。
 */
export function renderInbound(nodeId: string, port: number, tagOverride?: string): Record<string, unknown> {
  return {
    tag: tagOverride ?? inboundTag(nodeId),
    listen: '127.0.0.1',
    port,
    protocol: 'http',
    settings: {},
  }
}

/** inboundTag → outboundTag 的路由规则 */
export function renderRule(nodeId: string, tags?: { ruleTag?: string; inboundTag?: string; outboundTag?: string }): Record<string, unknown> {
  return {
    type: 'field',
    ruleTag: tags?.ruleTag ?? ruleTag(nodeId),
    inboundTag: [tags?.inboundTag ?? inboundTag(nodeId)],
    outboundTag: tags?.outboundTag ?? outboundTag(nodeId),
  }
}

const REQUIRED_SETTINGS: Record<string, (s: any) => string | null> = {
  vless: (s) => checkVnext(s),
  vmess: (s) => checkVnext(s),
  trojan: (s) => (Array.isArray(s?.servers) && s.servers[0]?.address && s.servers[0]?.port && s.servers[0]?.password ? null : 'trojan 需要 settings.servers[0].{address,port,password}'),
  shadowsocks: (s) => (Array.isArray(s?.servers) && s.servers[0]?.address && s.servers[0]?.port && s.servers[0]?.password && s.servers[0]?.method ? null : 'shadowsocks 需要 settings.servers[0].{address,port,password,method}'),
  socks: (s) => (Array.isArray(s?.servers) && s.servers[0]?.address && s.servers[0]?.port ? null : 'socks 需要 settings.servers[0].{address,port}'),
  http: (s) => (Array.isArray(s?.servers) && s.servers[0]?.address && s.servers[0]?.port ? null : 'http 需要 settings.servers[0].{address,port}'),
}

function checkVnext(s: any): string | null {
  const v = Array.isArray(s?.vnext) ? s.vnext[0] : undefined
  if (!v?.address || !v?.port) return 'settings.vnext[0] 需要 address/port'
  if (!Array.isArray(v.users) || !v.users[0]?.id) return 'settings.vnext[0].users[0].id 缺失'
  return null
}

const KNOWN_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'freedom', 'blackhole', 'dns'])

/**
 * 调用前的 JSON schema 校验（PANEL.md §9.2 纪律 5：防 issue #5156 那类「缺字段导致进程崩」）。
 * 只做「必需字段存在性 + 类型」检查，字段语义交给 xray run -test 兜底。
 */
export function validateOutbound(op: Record<string, unknown>): void {
  const tag = op.tag
  if (typeof tag !== 'string' || !tag) throw validationFailed('outbound 缺少 tag')
  const protocol = op.protocol
  if (typeof protocol !== 'string' || !protocol) throw validationFailed(`outbound ${tag} 缺少 protocol`)
  if (!KNOWN_PROTOCOLS.has(protocol)) {
    throw new AppError('unsupported_protocol', `outbound ${tag} 的 protocol=${protocol} 不被本方案支持`, 422)
  }
  const settings = op.settings
  if (protocol === 'freedom' || protocol === 'blackhole') return
  if (settings === undefined || settings === null || typeof settings !== 'object') {
    throw validationFailed(`outbound ${tag} 缺少 settings 对象`)
  }
  const checker = REQUIRED_SETTINGS[protocol]
  if (checker) {
    const problem = checker(settings)
    if (problem) throw validationFailed(`outbound ${tag}: ${problem}`)
  }
  const stream = op.streamSettings
  if (stream !== undefined && (typeof stream !== 'object' || stream === null)) {
    throw validationFailed(`outbound ${tag} 的 streamSettings 必须是对象`)
  }
}

export function validateInbound(ib: Record<string, unknown>): void {
  if (typeof ib.tag !== 'string' || !ib.tag) throw validationFailed('inbound 缺少 tag')
  if (typeof ib.protocol !== 'string' || !ib.protocol) throw validationFailed(`inbound ${ib.tag} 缺少 protocol`)
  if (ib.port !== undefined) {
    const port = Number(ib.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw validationFailed(`inbound ${ib.tag} 端口非法: ${String(ib.port)}`)
  }
}

export function validateRule(rule: Record<string, unknown>): void {
  if (rule.type !== 'field') throw validationFailed('路由规则必须 type=field')
  if (typeof rule.ruleTag !== 'string' || !rule.ruleTag) throw validationFailed('路由规则缺少 ruleTag')
  if (typeof rule.outboundTag !== 'string' || !rule.outboundTag) throw validationFailed('路由规则缺少 outboundTag')
}
 
