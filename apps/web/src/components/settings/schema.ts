import {
  Activity,
  Cable,
  Radar,
  Radio,
  Rss,
  Server,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react"

/** 系统设置表单：分组与字段定义（字段与默认值对齐 src/core/settings.ts）。 */

export type SettingsGroupKey = "panel" | "gateway" | "xray" | "direct" | "subsync" | "detect" | "metrics"

export type FieldType = "text" | "number" | "enum" | "boolean" | "lines" | "textarea"

export interface SettingsOption {
  value: string
  label: string
}

export interface SettingsField {
  /** 组内路径，支持 a.b */
  path: string
  label: string
  type: FieldType
  hint?: string
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: SettingsOption[]
  required?: boolean
  pattern?: { re: RegExp; message: string }
  itemPattern?: { re: RegExp; message: string }
  wide?: boolean
}

export interface SettingsGroup {
  key: SettingsGroupKey
  title: string
  description: string
  icon: LucideIcon
  fields: SettingsField[]
}

/** 表单值统一表示：数字也存字符串，便于用户边输入边校验。 */
export type FormValue = string | boolean
export type FormState = Record<string, FormValue>

const HOST_PORT = /^\S+:\d{2,5}$/

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    key: "panel",
    title: "面板",
    description: "面板自身的基础配置：外部地址会出现在客户端连接串里。",
    icon: SlidersHorizontal,
    fields: [
      {
        path: "baseUrl",
        label: "面板外部地址（baseUrl）",
        type: "text",
        placeholder: "proxy.example.com",
        hint: "客户端连接串里的主机名；留空则用 xc-p。只填主机名，不要带协议或端口。",
        pattern: { re: /^[A-Za-z0-9.-]*$/, message: "只填主机名（不含协议与端口），例如 proxy.example.com" },
        wide: true,
      },
      {
        path: "language",
        label: "界面语言",
        type: "enum",
        options: [
          { value: "zh-CN", label: "简体中文" },
          { value: "en-US", label: "English" },
        ],
      },
      {
        path: "sessionTtlHours",
        label: "会话有效期（小时）",
        type: "number",
        min: 1,
        max: 8760,
        hint: "Session Cookie 的 TTL，默认 72。改小后下次登录生效。",
      },
    ],
  },
  {
    key: "gateway",
    title: "网关（L4）",
    description: "客户端 → :7890，HTTP CONNECT / SOCKS5 按首字节分流；保存会重建 listener。",
    icon: Radio,
    fields: [
      { path: "enabled", label: "启用网关", type: "boolean", hint: "关闭后客户端连接串全部不可用（数据面仍可运行）。" },
      {
        path: "listen",
        label: "监听地址",
        type: "text",
        required: true,
        placeholder: "0.0.0.0:7890",
        pattern: { re: HOST_PORT, message: "格式应为 host:port，例如 0.0.0.0:7890" },
        hint: "默认 0.0.0.0:7890；改这里会重建 listener。",
      },
      {
        path: "authMode",
        label: "认证模式",
        type: "enum",
        options: [
          { value: "strict", label: "strict（用户名 + 密码）" },
          { value: "username-only", label: "username-only（仅用户名，不推荐）" },
        ],
        hint: "strict 校验节点凭据；username-only 只校验用户名，切勿用于公网。",
      },
      { path: "maxConcurrentPerUser", label: "每用户并发上限", type: "number", min: 1, max: 100000, hint: "默认 64。" },
      { path: "maxConcurrentPerIp", label: "每 IP 并发上限", type: "number", min: 1, max: 100000, hint: "默认 256，应不小于每用户上限。" },
      { path: "idleTimeoutSec", label: "空闲超时（秒）", type: "number", min: 5, max: 86400, hint: "默认 300。" },
      { path: "dialTimeoutMs", label: "拨号超时（毫秒）", type: "number", min: 100, max: 120000, hint: "默认 3000。" },
      { path: "authFailBanCount", label: "认证失败封禁阈值（次）", type: "number", min: 0, max: 100000, hint: "同一 IP 连续失败次数达到阈值即封禁；0 表示不封禁。" },
      { path: "authFailBanSec", label: "封禁时长（秒）", type: "number", min: 0, max: 86400, hint: "默认 300。" },
      {
        path: "tls.enabled",
        label: "启用网关 TLS",
        type: "boolean",
        hint: "开启后客户端用 https://user:pass@host:7890；证书路径必须同时填写。",
      },
      { path: "tls.certFile", label: "TLS 证书路径", type: "text", placeholder: "DATA_DIR/certs/gateway.crt", hint: "留空则 TLS 无法启动。" },
      { path: "tls.keyFile", label: "TLS 私钥路径", type: "text", placeholder: "DATA_DIR/certs/gateway.key" },
      { path: "protocols.http", label: "开放 HTTP 代理", type: "boolean", hint: "HTTP 与 SOCKS5 至少保留一种。" },
      { path: "protocols.socks5", label: "开放 SOCKS5", type: "boolean" },
    ],
  },
  {
    key: "xray",
    title: "Xray 数据面",
    description: "二进制、管理口、环回端口池、热操作阈值与维护窗口。",
    icon: Server,
    fields: [
      {
        path: "mode",
        label: "运行模式",
        type: "enum",
        options: [
          { value: "managed", label: "managed（面板托管进程）" },
          { value: "external", label: "external（外部 Xray）" },
        ],
      },
      {
        path: "binary",
        label: "Xray 二进制路径",
        type: "text",
        required: true,
        placeholder: "xray",
        hint: "打包版已内嵌对应平台的 Xray（版本随构建固定，启动时解出到 DATA_DIR/bin 并校验 SHA256），默认即可；填绝对路径可覆盖（开发/外置模式）。",
      },
      {
        path: "binarySha256",
        label: "二进制 SHA256",
        type: "text",
        placeholder: "留空表示不校验",
        hint: "64 位十六进制；非空时升级会校验哈希。",
        pattern: { re: /^([0-9a-fA-F]{64})?$/, message: "留空或填 64 位十六进制" },
        wide: true,
      },
      {
        path: "apiAddress",
        label: "API 管理口",
        type: "text",
        required: true,
        placeholder: "127.0.0.1:8501",
        pattern: { re: HOST_PORT, message: "格式应为 host:port" },
        hint: "必须只绑环回地址（127.0.0.1），公网可达等于把数据面控制权交出去。",
      },
      {
        path: "apiChannel",
        label: "API 通道",
        type: "enum",
        options: [
          { value: "cli", label: "cli（Bun.spawn xray api）" },
          { value: "grpc", label: "grpc" },
        ],
      },
      { path: "apiTimeoutSec", label: "API 超时（秒）", type: "number", min: 1, max: 300, hint: "默认 10。" },
      {
        path: "metricsListen",
        label: "metrics 监听",
        type: "text",
        required: true,
        placeholder: "127.0.0.1:8502",
        pattern: { re: HOST_PORT, message: "格式应为 host:port" },
        hint: "同样只绑环回；面板经由 /api/metrics 转发。",
      },
      { path: "inboundPortStart", label: "环回端口池起始", type: "number", min: 1024, max: 65535, hint: "默认 24000，需避开系统 ip_local_port_range。" },
      { path: "inboundPortEnd", label: "环回端口池结束", type: "number", min: 1024, max: 65535, hint: "默认 28999；必须大于起始值。" },
      { path: "portCooldownSec", label: "端口冷却（秒）", type: "number", min: 0, max: 86400, hint: "默认 300，规避 TIME_WAIT。" },
      { path: "retireDelayMs", label: "旧 tag 延迟删除（毫秒）", type: "number", min: 0, max: 3600000, hint: "默认 120000；0 表示立即删除。" },
      { path: "hotOpsRestartThreshold", label: "热操作重启阈值", type: "number", min: 0, max: 1000000, hint: "默认 500（ado + rmo 累计），超过后发布改走重启。" },
      {
        path: "maintenanceWindow",
        label: "维护窗口（HH:MM）",
        type: "text",
        placeholder: "04:00",
        pattern: { re: /^([01]\d|2[0-3]):[0-5]\d$|^$/, message: "格式 HH:MM，例如 04:00；留空表示不限制" },
        hint: "仅展示与运维约定用；留空表示不限制。",
      },
      {
        path: "logLevel",
        label: "Xray 日志级别",
        type: "enum",
        options: [
          { value: "debug", label: "debug" },
          { value: "info", label: "info" },
          { value: "warning", label: "warning" },
          { value: "error", label: "error" },
          { value: "none", label: "none" },
        ],
      },
      { path: "replayOnStart", label: "启动时重放期望状态", type: "boolean", hint: "控制面重启后做一次全量对账/重放。" },
    ],
  },
  {
    key: "direct",
    title: "直连模式（可选）",
    description: "额外暴露 Xray 的 http + socks 入站，仅作网关故障时的旁路，能力有降级。",
    icon: Cable,
    fields: [
      { path: "enabled", label: "启用直连模式", type: "boolean", hint: "默认关闭。开启后凭据轮换需要重载数据面。" },
      {
        path: "listen",
        label: "HTTP 监听地址",
        type: "text",
        placeholder: "0.0.0.0:7891",
        pattern: { re: HOST_PORT, message: "格式应为 host:port" },
        hint: "默认 0.0.0.0:7891。",
      },
      {
        path: "socksListen",
        label: "SOCKS 监听地址",
        type: "text",
        placeholder: "0.0.0.0:7892",
        pattern: { re: HOST_PORT, message: "格式应为 host:port" },
        hint: "默认 0.0.0.0:7892；与 HTTP 监听不能相同。",
      },
    ],
  },
  {
    key: "subsync",
    title: "订阅同步",
    description: "取回、超时重试、并发与历史保留。",
    icon: Rss,
    fields: [
      { path: "defaultIntervalSec", label: "默认同步间隔（秒）", type: "number", min: 30, max: 2592000, hint: "默认 21600（6 小时）。" },
      { path: "timeoutMs", label: "单次请求超时（毫秒）", type: "number", min: 1000, max: 300000, hint: "默认 20000。" },
      { path: "retries", label: "重试次数", type: "number", min: 0, max: 10, hint: "仅对网络错误与 5xx 重试。" },
      { path: "retryBackoffMs", label: "重试退避（毫秒）", type: "number", min: 0, max: 60000, hint: "默认 1500。" },
      { path: "concurrency", label: "订阅并发", type: "number", min: 1, max: 64, hint: "同一订阅永远串行；默认 3。" },
      {
        path: "autoPublishAfterSync",
        label: "同步后自动发布",
        type: "boolean",
        hint: "默认关闭；开启后同步完成即入队发布，会改数据面。",
      },
      { path: "historyKeep", label: "每订阅保留运行记录", type: "number", min: 10, max: 10000, hint: "默认 200。" },
      { path: "maxBytes", label: "订阅内容上限（字节）", type: "number", min: 1024, max: 268435456, hint: "默认 8388608（8 MiB）。" },
      {
        path: "userAgent",
        label: "User-Agent",
        type: "textarea",
        wide: true,
        hint: "部分机场按 UA 返回不同格式，遇到解析异常时优先检查这里。",
      },
    ],
  },
  {
    key: "detect",
    title: "节点检测",
    description: "三阶段检测、并发限流、隔离与恢复阈值。",
    icon: Radar,
    fields: [
      { path: "enabled", label: "启用定时检测", type: "boolean", hint: "关闭后只能手动触发检测。" },
      { path: "intervalSec", label: "检测间隔（秒）", type: "number", min: 30, max: 2592000, hint: "默认 900。" },
      { path: "concurrency", label: "检测并发", type: "number", min: 1, max: 64, hint: "必须显著低于网关并发上限；默认 8。" },
      { path: "tcpTimeoutMs", label: "S1 握手超时（毫秒）", type: "number", min: 200, max: 60000, hint: "默认 4000。" },
      { path: "totalTimeoutMs", label: "单节点总超时（毫秒）", type: "number", min: 500, max: 300000, hint: "默认 12000；必须 ≥ S1 握手超时。" },
      { path: "jitterMs", label: "抖动（毫秒）", type: "number", min: 0, max: 600000, hint: "默认 800，避免所有节点同时检测。" },
      {
        path: "testUrl",
        label: "S2 探测地址",
        type: "text",
        required: true,
        placeholder: "https://www.gstatic.com/generate_204",
        pattern: { re: new RegExp("^https?://"), message: "必须是 http(s) URL" },
        hint: "返回 204/200 即视为通。",
        wide: true,
      },
      {
        path: "ipEchoUrls",
        label: "S3 IP 查询源",
        type: "lines",
        required: true,
        wide: true,
        itemPattern: { re: new RegExp("^https?://"), message: "每一行都必须是 http(s) URL" },
        hint: "每行一个 URL；按顺序尝试，用于确认出口 IP 与地区。",
      },
      {
        path: "probeVia",
        label: "探测路径",
        type: "enum",
        options: [
          { value: "gateway", label: "经网关（端到端）" },
          { value: "direct", label: "仅数据面直连" },
        ],
        hint: "经网关更接近真实客户端链路，但会占用网关并发。",
      },
      { path: "quarantineAfter", label: "隔离阈值（连续失败）", type: "number", min: 1, max: 100, hint: "默认 3。" },
      { path: "recoverAfter", label: "恢复阈值（连续成功）", type: "number", min: 1, max: 100, hint: "默认 2。" },
      { path: "historyKeep", label: "每节点历史保留条数", type: "number", min: 5, max: 10000, hint: "默认 50。" },
      { path: "checkOnPublish", label: "发布前门禁检测", type: "boolean", hint: "发布前强制检测一次，默认开启。" },
      { path: "liteIntervalSec", label: "轻量检测间隔（秒）", type: "number", min: 60, max: 2592000, hint: "默认 3600。" },
      { path: "fullIntervalSec", label: "完整检测间隔（秒）", type: "number", min: 60, max: 2592000, hint: "默认 21600。" },
      { path: "fullModeEnabled", label: "启用完整检测", type: "boolean", hint: "关闭后只跑轻量检测（耗时更短，但拿不到出口 IP）。" },
    ],
  },
  {
    key: "metrics",
    title: "Metrics",
    description: "Prometheus 指标导出（GET /api/metrics）。",
    icon: Activity,
    fields: [
      { path: "enabled", label: "启用 /api/metrics", type: "boolean", hint: "关闭后 /api/metrics 返回 404，已接入的采集器会报错。" },
    ],
  },
]

export function formKey(group: SettingsGroupKey, path: string): string {
  return group + "." + path
}

export function fieldId(group: SettingsGroupKey, path: string): string {
  return "settings-" + group + "-" + path.split(".").join("-")
}

function readPath(source: Record<string, unknown> | undefined, path: string): unknown {
  let current: unknown = source
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function toFormValue(field: SettingsField, value: unknown): FormValue {
  if (field.type === "boolean") return value === true
  if (field.type === "lines") return Array.isArray(value) ? value.join("\n") : ""
  if (value === undefined || value === null) return ""
  return String(value)
}

/** 服务端 settings → 扁平表单状态（数字也转成字符串）。 */
export function settingsToForm(settings: Record<string, unknown> | undefined): FormState {
  const form: FormState = {}
  for (const group of SETTINGS_GROUPS) {
    const raw = settings?.[group.key]
    const values = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    for (const field of group.fields) {
      form[formKey(group.key, field.path)] = toFormValue(field, readPath(values, field.path))
    }
  }
  return form
}

export function groupFormFromSettings(settings: Record<string, unknown> | undefined, group: SettingsGroup): FormState {
  const raw = settings?.[group.key]
  const values = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const form: FormState = {}
  for (const field of group.fields) {
    form[formKey(group.key, field.path)] = toFormValue(field, readPath(values, field.path))
  }
  return form
}

export function pickGroupForm(group: SettingsGroup, form: FormState): FormState {
  const out: FormState = {}
  for (const field of group.fields) {
    const key = formKey(group.key, field.path)
    const value = form[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

export function isGroupDirty(group: SettingsGroup, form: FormState, baseline: FormState): boolean {
  return group.fields.some((field) => {
    const key = formKey(group.key, field.path)
    return (form[key] ?? "") !== (baseline[key] ?? "")
  })
}

function linesOf(value: FormValue): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function serializeValue(field: SettingsField, value: FormValue): unknown {
  switch (field.type) {
    case "boolean":
      return value === true
    case "number":
      return Number(value)
    case "lines":
      return linesOf(value)
    default:
      return String(value ?? "")
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".")
  let current = target
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (!next || typeof next !== "object") current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1] ?? path] = value
}

export interface GroupSerialization {
  values: Record<string, unknown>
  errors: Record<string, string>
}

function validateField(field: SettingsField, value: FormValue): string | undefined {
  if (field.type === "boolean") return undefined
  const text = String(value ?? "")
  if (field.type === "lines") {
    const lines = linesOf(value)
    if (field.required && lines.length === 0) return "至少填一行"
    if (field.itemPattern) {
      const bad = lines.find((line) => !field.itemPattern!.re.test(line))
      if (bad) return field.itemPattern.message + "：" + bad
    }
    return undefined
  }
  const trimmed = text.trim()
  if (field.required && trimmed === "") return "必填"
  if (field.type === "number") {
    if (trimmed === "") return field.required ? "必填" : undefined
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return "必须是数字"
    if (field.min !== undefined && numeric < field.min) return "不能小于 " + field.min
    if (field.max !== undefined && numeric > field.max) return "不能大于 " + field.max
    return undefined
  }
  if (field.pattern && trimmed !== "" && !field.pattern.re.test(trimmed)) return field.pattern.message
  if (field.pattern && trimmed === "" && field.required) return "必填"
  return undefined
}

function numberValue(form: FormState, group: SettingsGroupKey, path: string): number {
  return Number(form[formKey(group, path)] ?? "")
}

function boolValue(form: FormState, group: SettingsGroupKey, path: string): boolean {
  return form[formKey(group, path)] === true
}

/** 跨字段校验：把互相约束的字段放在一组里检查。 */
function crossValidate(group: SettingsGroup, form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  const setError = (path: string, message: string) => {
    errors[formKey(group.key, path)] = message
  }

  if (group.key === "gateway") {
    if (!boolValue(form, "gateway", "protocols.http") && !boolValue(form, "gateway", "protocols.socks5")) {
      setError("protocols.http", "HTTP 与 SOCKS5 至少保留一种，否则客户端无协议可用")
    }
    if (boolValue(form, "gateway", "tls.enabled")) {
      if (String(form[formKey("gateway", "tls.certFile")] ?? "").trim() === "") setError("tls.certFile", "启用 TLS 时必须填写证书路径")
      if (String(form[formKey("gateway", "tls.keyFile")] ?? "").trim() === "") setError("tls.keyFile", "启用 TLS 时必须填写私钥路径")
    }
    const perUser = numberValue(form, "gateway", "maxConcurrentPerUser")
    const perIp = numberValue(form, "gateway", "maxConcurrentPerIp")
    if (Number.isFinite(perUser) && Number.isFinite(perIp) && perUser > perIp) {
      setError("maxConcurrentPerUser", "每用户并发不应大于每 IP 并发（否则每 IP 上限先触发）")
    }
  }

  if (group.key === "xray") {
    const start = numberValue(form, "xray", "inboundPortStart")
    const end = numberValue(form, "xray", "inboundPortEnd")
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      setError("inboundPortEnd", "端口池结束必须大于起始（服务端同样会拒绝）")
    }
    const api = String(form[formKey("xray", "apiAddress")] ?? "").trim()
    const metrics = String(form[formKey("xray", "metricsListen")] ?? "").trim()
    if (api && api === metrics) setError("metricsListen", "API 管理口与 metrics 监听不能相同")
  }

  if (group.key === "direct") {
    if (boolValue(form, "direct", "enabled")) {
      if (String(form[formKey("direct", "listen")] ?? "").trim() === "") setError("listen", "启用直连模式时必须填写 HTTP 监听地址")
      if (String(form[formKey("direct", "socksListen")] ?? "").trim() === "") {
        setError("socksListen", "启用直连模式时必须填写 SOCKS 监听地址")
      }
    }
    const http = String(form[formKey("direct", "listen")] ?? "").trim()
    const socks = String(form[formKey("direct", "socksListen")] ?? "").trim()
    if (http && http === socks) setError("socksListen", "HTTP 与 SOCKS 监听不能是同一个地址")
  }

  if (group.key === "detect") {
    const tcp = numberValue(form, "detect", "tcpTimeoutMs")
    const total = numberValue(form, "detect", "totalTimeoutMs")
    if (Number.isFinite(tcp) && Number.isFinite(total) && total < tcp) {
      setError("totalTimeoutMs", "单节点总超时必须 ≥ S1 握手超时")
    }
  }

  return errors
}

/** 校验并序列化某一组：只生成该组的嵌套对象，用于 PATCH /api/settings。 */
export function serializeGroup(group: SettingsGroup, form: FormState): GroupSerialization {
  const errors: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  for (const field of group.fields) {
    const key = formKey(group.key, field.path)
    const value = form[key] ?? (field.type === "boolean" ? false : "")
    const message = validateField(field, value)
    if (message) errors[key] = message
    setPath(values, field.path, serializeValue(field, value))
  }
  Object.assign(errors, crossValidate(group, form))
  return { values, errors }
}

/** 字段是否匹配搜索词（label / path / hint）。 */
export function fieldMatches(field: SettingsField, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (field.label + " " + field.path + " " + (field.hint ?? "")).toLowerCase().includes(needle)
}
