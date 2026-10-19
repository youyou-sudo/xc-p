/** API Key 页的数据形状（GET/POST/DELETE /api/keys）。 */

export interface ApiKeyItem {
  id: string
  name: string
  prefix: string
  scopes: string[]
  ipAllowlist: string[]
  rateLimitPerMin: number
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

export interface KeysResponse {
  items: ApiKeyItem[]
  scopes: string[]
}

export interface CreateKeyResponse {
  id: string
  prefix: string
  plaintext: string
  notice?: string
}

export interface ScopeInfo {
  scope: string
  title: string
  description: string
  group: string
  danger?: boolean
}

const KNOWN_SCOPES: Record<string, { title: string; description: string }> = {
  read: { title: "读取", description: "读取节点列表、状态、revision、任务（不含密码）。" },
  credentials: { title: "读取凭据", description: "读取节点用户名与密码，生成客户端配置需要。" },
  "sync:run": { title: "触发同步", description: "触发订阅同步（POST /v1/subscriptions/sync）。" },
  "detect:run": { title: "触发检测", description: "触发节点检测（POST /v1/detect/run）。" },
  "publish:run": { title: "触发发布", description: "触发发布 / 回滚 / 对账。" },
  admin: { title: "管理员", description: "以上全部 + 管理 API Key 与系统设置，等价于运维权限。" },
}

/**
 * scope 分组（读写分组展示）：
 * 只读类（read / credentials）、写操作类（*:run）、管理类（admin）。
 */
function scopeInfo(scope: string): ScopeInfo {
  const known = KNOWN_SCOPES[scope]
  const group = scope === "admin" ? "管理（高风险）" : scope === "read" || scope === "credentials" ? "读取" : "写操作"
  return {
    scope,
    title: known?.title ?? scope,
    description: known?.description ?? "由服务端声明的 scope，具体能力见服务端文档。",
    group,
    danger: scope === "admin",
  }
}

export function groupScopes(scopes: string[]): { group: string; items: ScopeInfo[] }[] {
  const order = ["读取", "写操作", "管理（高风险）"]
  const infos = scopes.map((scope) => scopeInfo(scope))
  return order
    .map((group) => ({ group, items: infos.filter((info) => info.group === group) }))
    .filter((entry) => entry.items.length > 0)
}

/** 每行一个 IP，也兼容逗号分隔；服务端按精确 IP 匹配（不支持 CIDR）。 */
export function parseAllowlist(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function isKeyActive(key: ApiKeyItem, now = Date.now()): boolean {
  if (key.revokedAt) return false
  if (key.expiresAt && key.expiresAt < now) return false
  return true
}
