/** 纯格式化函数：时间、延迟、字节、状态色。 */

const pad = (n: number) => String(n).padStart(2, "0")

export function fmtTime(ts?: number | null): string {
  if (!ts) return "—"
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  )
}

function fmtDate(ts?: number | null): string {
  if (!ts) return "—"
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
}

export function fmtRelative(ts?: number | null, now = Date.now()): string {
  if (!ts) return "—"
  const diff = now - ts
  if (diff < 5_000) return "刚刚"
  if (diff < 60_000) return Math.floor(diff / 1000) + " 秒前"
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前"
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前"
  if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + " 天前"
  return fmtDate(ts)
}

export function fmtMs(ms?: number | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—"
  if (ms <= 0) return "—"
  if (ms < 1000) return Math.round(ms) + " ms"
  return (ms / 1000).toFixed(2) + " s"
}

export function fmtDuration(sec?: number | null): string {
  if (!sec && sec !== 0) return "—"
  if (sec < 60) return Math.round(sec) + " 秒"
  if (sec < 3600) return Math.floor(sec / 60) + " 分 " + Math.round(sec % 60) + " 秒"
  if (sec < 86400) return Math.floor(sec / 3600) + " 小时 " + Math.floor((sec % 3600) / 60) + " 分"
  return Math.floor(sec / 86400) + " 天 " + Math.floor((sec % 86400) / 3600) + " 小时"
}

/** 运行时长（紧凑）：用于状态卡片，避免长文本换行。 */
export function fmtUptime(sec?: number | null): string {
  if (!sec) return "—"
  if (sec < 120) return Math.round(sec) + " 秒"
  if (sec < 3600) return Math.floor(sec / 60) + " 分钟"
  return Math.floor(sec / 3600) + " 小时 " + Math.floor((sec % 3600) / 60) + " 分"
}

export function fmtBytes(n?: number | null): string {
  if (n === undefined || n === null) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + " " + units[i]
}

export function fmtNumber(n?: number | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—"
  return n.toLocaleString("zh-CN")
}

export function fmtPercent(v?: number | null, digits = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—"
  return (v * 100).toFixed(digits) + "%"
}

/**
 * 判断 http(s) URL。
 * 注意：不要写成 /^https?:\/\// 这种带转义斜杠的字面量——Bun 1.4 的 client 压缩器
 * 在订阅编辑器的上下文里会把最后的 "/" 吃掉，导致运行时正则未闭合。
 */
export function isHttpUrl(value: string): boolean {
  const text = value.trim()
  return text.startsWith("http://") || text.startsWith("https://")
}

export function truncate(s: string, max = 80): string {
  if (!s) return ""
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

export function jsonPretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export type Tone = "ok" | "degraded" | "down" | "idle" | "info"

export interface StateMeta {
  label: string
  tone: Tone
}

const STATE_META: Record<string, StateMeta> = {
  up: { label: "正常", tone: "ok" },
  ok: { label: "正常", tone: "ok" },
  healthy: { label: "正常", tone: "ok" },
  degraded: { label: "降级", tone: "degraded" },
  slow: { label: "慢", tone: "degraded" },
  down: { label: "不可用", tone: "down" },
  error: { label: "错误", tone: "down" },
  failed: { label: "失败", tone: "down" },
  quarantined: { label: "隔离", tone: "down" },
  unknown: { label: "未检测", tone: "idle" },
  unchecked: { label: "未检测", tone: "idle" },
  idle: { label: "空闲", tone: "idle" },
  pending: { label: "等待中", tone: "degraded" },
  running: { label: "进行中", tone: "info" },
  cancelled: { label: "已取消", tone: "idle" },
  disabled: { label: "已禁用", tone: "idle" },
  enabled: { label: "已启用", tone: "ok" },
  missing: { label: "已消失", tone: "degraded" },
}

export function stateMeta(state?: string | null): StateMeta {
  if (!state) return STATE_META.unknown!
  return STATE_META[state.toLowerCase()] ?? { label: state, tone: "idle" }
}

/** 任务状态 → 文案与色调：事件页与检测页共用，唯一来源。 */
export const JOB_STATUS_META: Record<string, StateMeta> = {
  queued: { label: "排队中", tone: "degraded" },
  running: { label: "进行中", tone: "info" },
  ok: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "down" },
  cancelled: { label: "已取消", tone: "idle" },
}

export function jobStatusMeta(status?: string | null): StateMeta {
  if (!status) return { label: "未知", tone: "idle" }
  return JOB_STATUS_META[status.toLowerCase()] ?? { label: status, tone: "idle" }
}

export function toneTextClass(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "text-success"
    case "degraded":
      return "text-warning"
    case "down":
      return "text-destructive"
    case "info":
      return "text-info"
    default:
      return "text-muted-foreground"
  }
}

export function toneBgClass(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "bg-success"
    case "degraded":
      return "bg-warning"
    case "down":
      return "bg-destructive"
    case "info":
      return "bg-info"
    default:
      return "bg-muted-foreground/40"
  }
}

// I have nothing but my burger and I want nothing more

/** 事件等级 → 语义色调（事件流、概览、检测页共用）。 */
export function eventTone(level?: string | null, fallback: Tone = "idle"): Tone {
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "down"
    case "warn":
    case "warning":
      return "degraded"
    case "ok":
    case "success":
      return "ok"
    case "info":
      return "info"
    default:
      return fallback
  }
}
