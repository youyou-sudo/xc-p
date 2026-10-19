import type { Tone } from "@/lib/format"

export const FORMAT_OPTIONS = [
  { value: "auto", label: "自动识别（auto）" },
  { value: "links", label: "明文链接（links）" },
  { value: "base64", label: "Base64 订阅（base64）" },
  { value: "clash", label: "Clash YAML（clash）" },
  { value: "xray", label: "Xray JSON（xray）" },
  { value: "singbox", label: "sing-box JSON（singbox）" },
] as const

const FORMAT_LABELS: Record<string, { full: string; short: string }> = {
  auto: { full: "自动识别", short: "auto" },
  links: { full: "明文链接", short: "明文链接" },
  base64: { full: "Base64", short: "Base64" },
  clash: { full: "Clash YAML", short: "Clash" },
  xray: { full: "Xray JSON", short: "Xray" },
  singbox: { full: "sing-box JSON", short: "sing-box" },
  json_array: { full: "JSON 数组", short: "JSON 数组" },
  unknown: { full: "未知格式", short: "未知" },
}

/** 格式标签；short 用于结果卡片等空间有限处（历史上使用简短文案）。 */
export function formatHintLabel(hint?: string | null, options: { short?: boolean } = {}): string {
  const key = (hint ?? "auto").toLowerCase()
  const label = FORMAT_LABELS[key]
  if (!label) return hint ?? "auto"
  return options.short ? label.short : label.full
}

/** URL 脱敏：保留 origin/路径，查询参数值只显示前两位后打码。 */
export function maskUrl(value?: string | null): string {
  if (!value) return "—"
  if (value.startsWith("inline://")) return "内联文本"
  try {
    const url = new URL(value)
    const search = [...url.searchParams.entries()]
      .map(([key, raw]) => key + "=" + maskSecret(raw))
      .join("&")
    const path = url.pathname && url.pathname !== "/" ? url.pathname : ""
    const auth = url.username ? "***@" : ""
    return url.protocol + "//" + auth + url.host + path + (search ? "?" + search : "")
  } catch {
    return value.replace(/([?&][^=&#]+=)([^&#]*)/g, (_match, prefix: string, secret: string) => prefix + maskSecret(secret))
  }
}

function maskSecret(value: string): string {
  if (!value) return "••••"
  if (value.length <= 2) return "••••"
  return value.slice(0, 2) + "••••"
}

export function formatInterval(intervalSec?: number | null, cron?: string | null): string {
  if (cron) return cron
  const sec = Number(intervalSec ?? 0)
  if (!Number.isFinite(sec) || sec <= 0) return "手动"
  if (sec < 60) return Math.round(sec) + " 秒"
  if (sec < 3600) return Math.round(sec / 60) + " 分钟"
  if (sec < 86400) {
    const hours = sec / 3600
    return (Number.isInteger(hours) ? String(hours) : hours.toFixed(1)) + " 小时"
  }
  const days = sec / 86400
  return (Number.isInteger(days) ? String(days) : days.toFixed(1)) + " 天"
}

export function subStatusMeta(status?: string | null, enabled?: boolean): { label: string; tone: Tone } {
  if (enabled === false) return { label: "已暂停", tone: "idle" }
  switch ((status ?? "never").toLowerCase()) {
    case "ok":
      return { label: "正常", tone: "ok" }
    case "failed":
      return { label: "失败", tone: "down" }
    case "running":
      return { label: "同步中", tone: "info" }
    case "never":
      return { label: "未同步", tone: "idle" }
    default:
      return { label: status || "未知", tone: "idle" }
  }
}

export function runStatusMeta(status?: string | null): { label: string; tone: Tone } {
  switch ((status ?? "").toLowerCase()) {
    case "ok":
      return { label: "成功", tone: "ok" }
    case "failed":
      return { label: "失败", tone: "down" }
    case "running":
      return { label: "进行中", tone: "info" }
    case "aborted":
      return { label: "已中止", tone: "degraded" }
    default:
      return { label: status || "未知", tone: "idle" }
  }
}

export function triggerLabel(trigger?: string | null): string {
  switch ((trigger ?? "").toLowerCase()) {
    case "manual":
      return "手动"
    case "cron":
      return "定时"
    case "api":
      return "服务 API"
    case "preview":
      return "预览"
    default:
      return trigger || "未知"
  }
}

