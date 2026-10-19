/** 检测页的数据契约（GET /api/settings · /api/nodes · /api/jobs · /api/events）。 */

export interface DetectSettings {
  enabled: boolean
  intervalSec: number
  concurrency: number
  tcpTimeoutMs: number
  totalTimeoutMs: number
  jitterMs: number
  testUrl: string
  ipEchoUrls: string[]
  probeVia: "gateway" | "direct"
  quarantineAfter: number
  recoverAfter: number
  historyKeep: number
  checkOnPublish: boolean
  liteIntervalSec: number
  fullIntervalSec: number
  fullModeEnabled: boolean
}

export interface DetectNode {
  id: string
  displayName?: string
  protocol: string
  protocolSupported: boolean
  enabled: boolean
  state: string
  lastCheckAt?: number | null
  delayMs?: number | null
  totalMs?: number | null
  errorKind?: string | null
  errorMsg?: string | null
  failStreak?: number
  checksTotal?: number
  checksOk?: number
}

export interface DetectJob {
  id: string
  kind: string
  status: string
  priority?: number
  payload_json?: string | null
  progress: number
  total: number
  message: string | null
  started_at: number | null
  finished_at: number | null
  result: any
  error: string | null
  created_by: string | null
  created_at: number
}

export interface DetectEvent {
  id: number
  at: number
  level: string
  kind: string
  node_id: string | null
  message: string
  detail?: unknown
}

export const DETECT_DEPTHS = [
  { value: "full", label: "全量 full（S1 + S2 + S3）" },
  { value: "lite", label: "轻量 lite（S1 + S2）" },
] as const

export const DETECT_SCOPES = [
  { value: "all", label: "全部可检测节点" },
  { value: "unknown", label: "仅未检测节点" },
  { value: "abnormal", label: "仅异常节点" },
] as const
