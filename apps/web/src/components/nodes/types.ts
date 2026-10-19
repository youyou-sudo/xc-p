/** 节点页用到的响应形状（与 apps/server/src/modules/nodes 的 listNodes 保持一致）。 */
import type { ConnectionStrings } from "@/lib/domain"

export interface NodeRow {
  id: string
  displayName?: string | null
  countryCode?: string | null
  region?: string | null
  protocol: string
  protocolSupported: boolean
  enabled: boolean
  missingSince?: number | null
  publishError?: string | null
  username?: string
  sourceNames: string[]
  /** 由 normalizeNode 从 status 子对象拍平而来 */
  state: string
  delayMs?: number
  totalMs?: number
  connectMs?: number
  handshakeMs?: number
  exitIp: string
  exitCountry: string
  exitRegion: string
  lastCheckAt: number
  lastOkAt: number
  failStreak: number
  successStreak: number
  checksTotal: number
  checksOk: number
  uptime24h: number
  errorKind: string
  errorMsg: string
}

export interface NodesResponse {
  items: NodeRow[]
  total: number
  nextCursor: number | null
  updatedAt: number
}

export interface NodeCheckRun {
  id: number
  node_id: string
  at: number
  source: string
  ok: number
  stage_reached: string | null
  connect_ms: number | null
  handshake_ms: number | null
  total_ms: number | null
  delay_ms: number | null
  http_status: number | null
  exit_ip: string | null
  exit_country: string | null
  error_kind: string | null
  error_msg: string | null
}

/** 从 http://user:pass@host:port 中取出密码（密码字符集为 base62，仍做一次解码兜底） */
export function passwordFromConnection(conn: ConnectionStrings | null | undefined): string {
  const http = conn?.http ?? ""
  const match = new RegExp("^https?://[^:/@]+:([^@]*)@").exec(http)
  if (!match) return ""
  try {
    return decodeURIComponent(match[1] ?? "")
  } catch {
    return match[1] ?? ""
  }
}

/** 面板支持的协议枚举（用于筛选下拉） */
export const PROTOCOLS = ["ss", "ssr", "vmess", "vless", "trojan", "hysteria2", "tuic", "socks", "http"] as const
