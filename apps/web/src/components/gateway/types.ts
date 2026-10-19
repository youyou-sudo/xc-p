/** 网关页用到的响应形状（与 apps/server/src/modules/gateway 和 apps/server/src/gateway/types.ts 保持一致）。 */

export interface ActiveConnection {
  id: number
  nodeId: string
  username: string
  clientIp: string
  target: string
  protocol: string
  startedAt: number
  upBytes: number
  downBytes: number
}

export interface RecentConnection {
  id: number
  node_id: string | null
  username: string | null
  client_ip: string | null
  target: string | null
  started_at: number
  closed_at: number | null
  up_bytes: number
  down_bytes: number
  close_reason: string | null
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

export interface GatewayConnectionsResponse {
  active: ActiveConnection[]
  byNode: Record<string, number>
  byIp: Record<string, number>
  stats: GatewayStats | null
  recent: RecentConnection[]
}

/** settings.gateway 的形状 */
export interface GatewayConfig {
  enabled: boolean
  listen: string
  authMode: "strict" | "username-only"
  tls: { enabled: boolean; certFile: string; keyFile: string }
  maxConcurrentPerUser: number
  maxConcurrentPerIp: number
  idleTimeoutSec: number
  dialTimeoutMs: number
  authFailBanCount: number
  authFailBanSec: number
  protocols: { http: boolean; socks5: boolean }
}

export interface SettingsResponse {
  settings: { gateway: GatewayConfig }
}

export interface KickPayload {
  nodeId?: string
  username?: string
  ip?: string
  connId?: number
}

export interface AggregateRow {
  key: string
  count: number
}

/** 按用户名聚合活跃连接（网关 stats 只提供 byNode / byIp） */
export function countByUser(active: ActiveConnection[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const conn of active) {
    const key = conn.username || conn.nodeId || "—"
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

export function toAggregateRows(counts: Record<string, number>): AggregateRow[] {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

export function closeReasonLabel(reason: string | null): { label: string; tone: "ok" | "degraded" | "down" | "idle" | "info" } {
  switch (reason) {
    case null:
      return { label: "活跃", tone: "ok" }
    case "client":
      return { label: "客户端关闭", tone: "idle" }
    case "remote":
      return { label: "对端关闭", tone: "idle" }
    case "kicked":
      return { label: "被踢线", tone: "degraded" }
    case "shutdown":
      return { label: "进程重启", tone: "degraded" }
    case "error":
      return { label: "异常断开", tone: "down" }
    default:
      return { label: reason, tone: "idle" }
  }
}
