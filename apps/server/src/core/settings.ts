import type { Db } from './db'
import { validationFailed } from './errors'

/** PANEL.md §6.7 settings 默认形态（面板可视化编辑，唯一配置入口，D8） */
export interface Settings {
  panel: { baseUrl: string; language: string; sessionTtlHours: number }
  gateway: {
    enabled: boolean
    listen: string
    authMode: 'strict' | 'username-only'
    tls: { enabled: boolean; certFile: string; keyFile: string }
    maxConcurrentPerUser: number
    maxConcurrentPerIp: number
    idleTimeoutSec: number
    dialTimeoutMs: number
    authFailBanCount: number
    authFailBanSec: number
    protocols: { http: boolean; socks5: boolean }
  }
  xray: {
    mode: 'managed' | 'external'
    binary: string
    binarySha256: string
    apiAddress: string
    apiChannel: 'cli' | 'grpc'
    apiTimeoutSec: number
    metricsListen: string
    inboundPortStart: number
    inboundPortEnd: number
    portCooldownSec: number
    retireDelayMs: number
    hotOpsRestartThreshold: number
    maintenanceWindow: string
    logLevel: string
    replayOnStart: boolean
  }
  direct: { enabled: boolean; listen: string; socksListen: string }
  subsync: {
    defaultIntervalSec: number
    timeoutMs: number
    retries: number
    retryBackoffMs: number
    concurrency: number
    autoPublishAfterSync: boolean
    historyKeep: number
    maxBytes: number
    userAgent: string
  }
  detect: {
    enabled: boolean
    intervalSec: number
    concurrency: number
    tcpTimeoutMs: number
    totalTimeoutMs: number
    jitterMs: number
    testUrl: string
    ipEchoUrls: string[]
    probeVia: 'gateway' | 'direct'
    quarantineAfter: number
    recoverAfter: number
    historyKeep: number
    checkOnPublish: boolean
    liteIntervalSec: number
    fullIntervalSec: number
    fullModeEnabled: boolean
  }
  publish: {
    scheduleCron: string
    policy: 'healthy_only' | 'all_enabled'
    maxRemovalRatio: number
    maxUnsupportedRatio: number
    requireMinNodes: number
    keepRevisions: number
    staleRetentionDays: number
    namingTemplate: string
    autoRemoveStale: boolean
  }
  credentials: { mode: 'encrypted' | 'hash-only' }
  metrics: { enabled: boolean }
}

export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> }

export const DEFAULT_SETTINGS: Settings = {
  panel: { baseUrl: '', language: 'zh-CN', sessionTtlHours: 72 },
  gateway: {
    enabled: true,
    listen: '0.0.0.0:7890',
    authMode: 'strict',
    tls: { enabled: false, certFile: '', keyFile: '' },
    maxConcurrentPerUser: 64,
    maxConcurrentPerIp: 256,
    idleTimeoutSec: 300,
    dialTimeoutMs: 3000,
    authFailBanCount: 20,
    authFailBanSec: 300,
    protocols: { http: true, socks5: true },
  },
  xray: {
    mode: 'managed',
    binary: 'xray',
    binarySha256: '',
    apiAddress: '127.0.0.1:8501',
    apiChannel: 'cli',
    apiTimeoutSec: 10,
    metricsListen: '127.0.0.1:8502',
    inboundPortStart: 24000,
    inboundPortEnd: 28999,
    portCooldownSec: 300,
    retireDelayMs: 120000,
    hotOpsRestartThreshold: 500,
    maintenanceWindow: '04:00',
    logLevel: 'warning',
    replayOnStart: true,
  },
  direct: { enabled: false, listen: '0.0.0.0:7891', socksListen: '0.0.0.0:7892' },
  subsync: {
    defaultIntervalSec: 21600,
    timeoutMs: 20000,
    retries: 2,
    retryBackoffMs: 1500,
    concurrency: 3,
    autoPublishAfterSync: false,
    historyKeep: 200,
    maxBytes: 8 * 1024 * 1024,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  },
  detect: {
    enabled: true,
    intervalSec: 900,
    concurrency: 8,
    tcpTimeoutMs: 4000,
    totalTimeoutMs: 12000,
    jitterMs: 800,
    testUrl: 'https://www.gstatic.com/generate_204',
    ipEchoUrls: ['https://api.ip.sb/geoip', 'https://ipinfo.io/json'],
    probeVia: 'gateway',
    quarantineAfter: 3,
    recoverAfter: 2,
    historyKeep: 50,
    checkOnPublish: true,
    liteIntervalSec: 3600,
    fullIntervalSec: 21600,
    fullModeEnabled: true,
  },
  publish: {
    scheduleCron: '',
    policy: 'healthy_only',
    maxRemovalRatio: 0.3,
    maxUnsupportedRatio: 0.5,
    requireMinNodes: 1,
    keepRevisions: 20,
    staleRetentionDays: 7,
    namingTemplate: '{region}{seq}',
    autoRemoveStale: true,
  },
  credentials: { mode: 'encrypted' },
  metrics: { enabled: true },
}

type LeafRule = { type: 'number' | 'string' | 'boolean' | 'enum' | 'stringArray'; min?: number; max?: number; values?: string[] }

/** 面板可视化编辑时的校验表（§11.1 GET/PATCH /api/settings） */
const RULES: Record<string, LeafRule> = {
  'panel.baseUrl': { type: 'string' },
  'panel.language': { type: 'string' },
  'panel.sessionTtlHours': { type: 'number', min: 1, max: 8760 },
  'gateway.enabled': { type: 'boolean' },
  'gateway.listen': { type: 'string' },
  'gateway.authMode': { type: 'enum', values: ['strict', 'username-only'] },
  'gateway.tls.enabled': { type: 'boolean' },
  'gateway.tls.certFile': { type: 'string' },
  'gateway.tls.keyFile': { type: 'string' },
  'gateway.maxConcurrentPerUser': { type: 'number', min: 1, max: 100000 },
  'gateway.maxConcurrentPerIp': { type: 'number', min: 1, max: 100000 },
  'gateway.idleTimeoutSec': { type: 'number', min: 5, max: 86400 },
  'gateway.dialTimeoutMs': { type: 'number', min: 100, max: 120000 },
  'gateway.authFailBanCount': { type: 'number', min: 0, max: 100000 },
  'gateway.authFailBanSec': { type: 'number', min: 0, max: 86400 },
  'gateway.protocols.http': { type: 'boolean' },
  'gateway.protocols.socks5': { type: 'boolean' },
  'xray.mode': { type: 'enum', values: ['managed', 'external'] },
  'xray.binary': { type: 'string' },
  'xray.binarySha256': { type: 'string' },
  'xray.apiAddress': { type: 'string' },
  'xray.apiChannel': { type: 'enum', values: ['cli', 'grpc'] },
  'xray.apiTimeoutSec': { type: 'number', min: 1, max: 300 },
  'xray.metricsListen': { type: 'string' },
  'xray.inboundPortStart': { type: 'number', min: 1024, max: 65535 },
  'xray.inboundPortEnd': { type: 'number', min: 1024, max: 65535 },
  'xray.portCooldownSec': { type: 'number', min: 0, max: 86400 },
  'xray.retireDelayMs': { type: 'number', min: 0, max: 3600000 },
  'xray.hotOpsRestartThreshold': { type: 'number', min: 0, max: 1000000 },
  'xray.maintenanceWindow': { type: 'string' },
  'xray.logLevel': { type: 'enum', values: ['debug', 'info', 'warning', 'error', 'none'] },
  'xray.replayOnStart': { type: 'boolean' },
  'direct.enabled': { type: 'boolean' },
  'direct.listen': { type: 'string' },
  'direct.socksListen': { type: 'string' },
  'subsync.defaultIntervalSec': { type: 'number', min: 30, max: 2592000 },
  'subsync.timeoutMs': { type: 'number', min: 1000, max: 300000 },
  'subsync.retries': { type: 'number', min: 0, max: 10 },
  'subsync.retryBackoffMs': { type: 'number', min: 0, max: 60000 },
  'subsync.concurrency': { type: 'number', min: 1, max: 64 },
  'subsync.autoPublishAfterSync': { type: 'boolean' },
  'subsync.historyKeep': { type: 'number', min: 10, max: 10000 },
  'subsync.maxBytes': { type: 'number', min: 1024, max: 256 * 1024 * 1024 },
  'subsync.userAgent': { type: 'string' },
  'detect.enabled': { type: 'boolean' },
  'detect.intervalSec': { type: 'number', min: 30, max: 2592000 },
  'detect.concurrency': { type: 'number', min: 1, max: 64 },
  'detect.tcpTimeoutMs': { type: 'number', min: 200, max: 60000 },
  'detect.totalTimeoutMs': { type: 'number', min: 500, max: 300000 },
  'detect.jitterMs': { type: 'number', min: 0, max: 600000 },
  'detect.testUrl': { type: 'string' },
  'detect.ipEchoUrls': { type: 'stringArray' },
  'detect.probeVia': { type: 'enum', values: ['gateway', 'direct'] },
  'detect.quarantineAfter': { type: 'number', min: 1, max: 100 },
  'detect.recoverAfter': { type: 'number', min: 1, max: 100 },
  'detect.historyKeep': { type: 'number', min: 5, max: 10000 },
  'detect.checkOnPublish': { type: 'boolean' },
  'detect.liteIntervalSec': { type: 'number', min: 60, max: 2592000 },
  'detect.fullIntervalSec': { type: 'number', min: 60, max: 2592000 },
  'detect.fullModeEnabled': { type: 'boolean' },
  'publish.scheduleCron': { type: 'string' },
  'publish.policy': { type: 'enum', values: ['healthy_only', 'all_enabled'] },
  'publish.maxRemovalRatio': { type: 'number', min: 0, max: 1 },
  'publish.maxUnsupportedRatio': { type: 'number', min: 0, max: 1 },
  'publish.requireMinNodes': { type: 'number', min: 0, max: 100000 },
  'publish.keepRevisions': { type: 'number', min: 1, max: 1000 },
  'publish.staleRetentionDays': { type: 'number', min: 0, max: 3650 },
  'publish.namingTemplate': { type: 'string' },
  'publish.autoRemoveStale': { type: 'boolean' },
  'credentials.mode': { type: 'enum', values: ['encrypted', 'hash-only'] },
  'metrics.enabled': { type: 'boolean' },
}

export class SettingsStore {
  private cache: Settings

  constructor(private db: Db) {
    this.cache = this.load()
  }

  private load(): Settings {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', ['root'])
    let stored: Partial<Settings> = {}
    if (row) {
      try {
        stored = JSON.parse(row.value_json) as Partial<Settings>
      } catch {
        stored = {}
      }
    }
    const merged = this.applyEnvOverlay(mergeSettings(DEFAULT_SETTINGS, stored))
    // Xray 版本由构建期固定并随可执行文件内嵌（scripts/build-exe.ts），面板不再提供
    // versionPin：丢弃老数据库里的残留字段，避免下次 update 时被合并回写。
    delete (merged.xray as unknown as Record<string, unknown>).versionPin
    this.validateFull(merged)
    if (!row) this.persist(mergeSettings(DEFAULT_SETTINGS, stored))
    return merged
  }

  private persist(value: Settings): void {
    this.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      ['root', JSON.stringify(value), Date.now()],
    )
  }

  get(): Settings {
    return this.cache
  }

  /**
   * 引导参数覆盖（D8 的例外，仅用于开发/测试与容器内固定二进制路径）：
   *   XRAY_BINARY 覆盖 settings.xray.binary，不写入数据库。
   */
  private applyEnvOverlay(s: Settings): Settings {
    let out = s
    const bin = process.env.XRAY_BINARY
    if (bin && out.xray.binary === DEFAULT_SETTINGS.xray.binary) {
      out = { ...out, xray: { ...out.xray, binary: bin } }
    }
    // XCP_BOOTSTRAP_SETTINGS：JSON 深合并（不落库）。用于测试夹具与容器引导，见 README。
    const raw = process.env.XCP_BOOTSTRAP_SETTINGS
    if (raw) {
      try {
        out = mergeSettings(out, JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* 无效的引导 JSON 忽略 */
      }
    }
    return out
  }

  /** 部分更新（深合并）；校验失败抛 422 */
  update(patch: SettingsPatch): Settings {
    const flat = flatten(patch)
    for (const [key, value] of Object.entries(flat)) {
      const rule = RULES[key]
      if (!rule) throw validationFailed(`未知设置项: ${key}`)
      checkRule(key, value, rule)
    }
    // 注意：这里**不能**再叠加 XCP_BOOTSTRAP_SETTINGS/XRAY_BINARY——否则面板里改过的值
    // 会在下一次 update 时被引导值覆盖回去（引导只用于首次装载）。
    const next = mergeSettings(this.cache, patch as Partial<Settings>)
    this.validateFull(next)
    this.persist(next)
    this.cache = next
    return next
  }
 
  private validateFull(s: Settings): void {
    const flat = flatten(s)
    for (const [key, value] of Object.entries(flat)) {
      const rule = RULES[key]
      if (rule) checkRule(key, value, rule)
    }
    if (s.xray.inboundPortEnd <= s.xray.inboundPortStart) {
      throw validationFailed('xray.inboundPortEnd 必须大于 xray.inboundPortStart')
    }
    if (/^\d{1,2}:\d{2}$/.test(s.xray.maintenanceWindow) === false && s.xray.maintenanceWindow !== '') {
      throw validationFailed('xray.maintenanceWindow 需形如 04:00')
    }
  }
}

function checkRule(key: string, value: unknown, rule: LeafRule): void {
  switch (rule.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw validationFailed(`${key} 必须是数字`)
      if (rule.min !== undefined && value < rule.min) throw validationFailed(`${key} 不能小于 ${rule.min}`)
      if (rule.max !== undefined && value > rule.max) throw validationFailed(`${key} 不能大于 ${rule.max}`)
      break
    }
    case 'string':
      if (typeof value !== 'string') throw validationFailed(`${key} 必须是字符串`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') throw validationFailed(`${key} 必须是布尔值`)
      break
    case 'enum':
      if (typeof value !== 'string' || !rule.values!.includes(value)) {
        throw validationFailed(`${key} 必须是 ${rule.values!.join('|')}`)
      }
      break
    case 'stringArray':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw validationFailed(`${key} 必须是字符串数组`)
      }
      break
  }
}

export function flatten(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
      else out[key] = v
    }
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function mergeSettings<T>(base: T, patch: Partial<T> | Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = mergeSettings(cur, v)
    else out[k] = v
  }
  return out as T
}
 
