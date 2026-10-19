/** 面板跨页面共享的领域常量与响应形状（单一来源，避免各页面各存一份）。 */

/** PANEL.md §8.3 检测错误分类：节点抽屉与检测页共用。 */
export const ERROR_KINDS = [
  "tcp_timeout",
  "tcp_refused",
  "tcp_unreachable",
  "dns_failed",
  "tls_error",
  "total_timeout",
  "gateway_unreachable",
  "proxy_auth",
  "proxy_handshake",
  "http_status",
  "empty_reply",
  "no_proxy_effect",
  "xray_api_unreachable",
  "xray_tag_conflict",
  "xray_build_failed",
  "xray_port_conflict",
  "xray_down",
  "ip_echo_failed",
  "unsupported_protocol",
  "internal",
] as const

/** GET /api/nodes/:id/connection 的响应；密码与用户名只在这一响应里出现。 */
export interface ConnectionStrings {
  nodeId: string
  http: string
  socks5: string
  curl: string
  docker: string[]
  env: string
  clash: string
}

/** POST /api/settings/test 的单条结果。 */
export interface SettingsTestResult {
  id: string
  label: string
  ok: boolean
  detail: string
}
