/** 订阅页的数据契约（形状以 apps/server/src/modules/subscriptions 与 apps/server/src/sync/sync.ts 为准）。 */

export interface SubscriptionItem {
  id: string
  name: string
  /** 后端对内联订阅返回 "(内联文本)"；展示前统一走 maskUrl */
  url: string
  inline: boolean
  formatHint: string
  enabled: boolean
  intervalSec: number | null
  cron: string | null
  timeoutMs: number
  retries: number
  userAgent: string | null
  lastSyncAt: number | null
  lastStatus: string
  lastError: string | null
  lastErrorKind: string | null
  consecutiveFailures: number
  nodeCount: number
}

export interface PreviewNode {
  protocol: string
  server: string
  port: number
  credential?: string
  params?: Record<string, unknown>
  name?: string
  raw?: string
  fingerprint?: string
  paramsHash?: string
  protocolSupported: boolean
}

export interface PreviewError {
  lineNo: number
  rawSnippet: string
  errorKind: string
  errorMsg: string
}

export interface PreviewDiff {
  added: number
  unchanged: number
  removed: number
  unsupported: number
}

export interface PreviewResponse {
  format: string
  total: number
  supported: number
  unsupported: number
  nodes: PreviewNode[]
  errors: PreviewError[]
  diff: PreviewDiff
}

export interface SubscriptionRunError {
  line_no: number | null
  raw_snippet: string | null
  error_kind: string | null
  error_msg: string | null
}

export interface SubscriptionRun {
  id: string
  trigger: string
  startedAt: number
  finishedAt: number | null
  status: string
  httpStatus: number | null
  bytes: number | null
  durationMs: number | null
  totalFound: number
  added: number
  changed: number
  removed: number
  restored: number
  unsupported: number
  parseErrors: number
  errorKind: string | null
  errorMsg: string | null
  errors: SubscriptionRunError[]
}
