import type { AppConfig } from './config'
import type { Db } from './core/db'
import type { EventBus } from './core/events'
import type { SettingsStore } from './core/settings'
import type { RoutingTable } from './core/routing'
import type { ConnectionTracker } from './core/connlog'
import type { AuthService } from './modules/auth/service'
import type { JobQueue } from './jobs/queue'
import type { Scheduler } from './jobs/scheduler'
import type { SyncService } from './sync/sync'
import type { Detector } from './detect/detect'
import type { Publisher } from './publish/publish'
import type { Reconciler } from './xray/reconcile'
import type { XrayCli } from './xray/cli'
import type { PortPool } from './xray/ports'
import type { XrayProcess } from './xray/process'
import type { RetireQueue } from './xray/retire'
import type { ApplyEngine } from './xray/apply'
import type { Gateway } from './gateway/server'

export interface HealthReport {
  panel: 'ok'
  sqlite: 'ok' | 'error'
  schemaVersion: number
  xray: {
    mode: string
    pid: number | null
    status: string
    version: string
    api: string
    apiLatencyMs: number
    tagCount: number
    ruleCount: number
    rulesSupported: boolean
    hotOpsTotal: number
    pendingRetire: number
    runtimeSec: number
    restarts: number
  }
  gateway: { listen: string; enabled: boolean; activeConns: number; authFailures5m: number; banned: number }
  ports: { pool: number; used: number; cooling: number; bindable: { port: number; ok: boolean }[] }
  checks: { id: string; label: string; ok: boolean; detail: string; level: 'ok' | 'degraded' | 'error' }[]
  overall: 'ok' | 'degraded'
}

export interface AppContext {
  config: AppConfig
  db: Db
  settings: SettingsStore
  events: EventBus
  jobs: JobQueue
  auth: AuthService
  sync: SyncService
  detector: Detector
  publisher: Publisher
  reconciler: Reconciler
  engine: ApplyEngine
  cli: XrayCli
  ports: PortPool
  process: XrayProcess
  routing: RoutingTable
  retire: RetireQueue
  conns: ConnectionTracker
  scheduler: Scheduler
  gateway: Gateway | null
  startedAt: number
  gatewayInfo: () => { host: string; port: number; enabled: boolean }
  /** 网关 listener 的当前错误（null = 正常）；面板改配置后会重试并更新 */
  gatewayError: () => string | null
  setGatewayError: (msg: string | null) => void
  health: () => Promise<HealthReport>
  /** 断开指定节点/用户/IP/连接的全部连接（网关能力，§10.1） */
  kick: (pred: { nodeId?: string; username?: string; ip?: string; connId?: number }) => number
  /** 立即重启数据面 + 重放（§9.4 / §11.1 /api/runtime/restart） */
  restartDataplane: () => Promise<{ ok: boolean; replayed: number; error?: string }>
}