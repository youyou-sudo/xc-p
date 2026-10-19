/** 客户端接入页用到的数据结构（GET /api/nodes、/api/nodes/:id/connection、/api/settings）。 */

export interface ClientNode {
  id: string
  displayName?: string | null
  countryCode?: string | null
  region?: string | null
  protocol?: string | null
  protocolSupported?: boolean
  enabled?: boolean
  username?: string
  missingSince?: number | null
  status?: {
    state?: string | null
    delayMs?: number | null
    exitIp?: string | null
    exitCountry?: string | null
    lastCheckAt?: number | null
  } | null
}

export interface GatewayConfig {
  enabled: boolean
  listen: string
  authMode: string
  tls: { enabled: boolean; certFile: string; keyFile: string }
  protocols: { http: boolean; socks5: boolean }
  maxConcurrentPerUser?: number
  maxConcurrentPerIp?: number
}

export interface DirectConfig {
  enabled: boolean
  listen: string
  socksListen: string
}

export interface PanelConfig {
  baseUrl?: string
  language?: string
  sessionTtlHours?: number
}

export interface ClientSettings {
  panel?: PanelConfig
  gateway?: GatewayConfig
  direct?: DirectConfig
}

export function nodeState(node: ClientNode): string {
  return node.status?.state ?? "unknown"
}

/** 连接串里的主机名由 panel.baseUrl 决定（留空时服务端用 xc-p）。 */
export function clientHost(settings: ClientSettings | undefined): string {
  const base = settings?.panel?.baseUrl?.trim()
  return base ? base : "xc-p"
}

/** listen 形如 0.0.0.0:7890 / [::]:7890，取端口。 */
export function listenPort(listen: string | undefined, fallback = "7890"): string {
  if (!listen) return fallback
  const index = listen.lastIndexOf(":")
  return index >= 0 ? listen.slice(index + 1) : fallback
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]"
}
