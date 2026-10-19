import type { DetectJob } from "./types"

export function jobDepth(job: DetectJob): "lite" | "full" | null {
  if (!job.payload_json) return null
  try {
    const payload = JSON.parse(job.payload_json) as { depth?: string }
    if (payload.depth === "lite") return "lite"
    if (payload.depth === "full") return "full"
    return null
  } catch {
    return null
  }
}

/** 任务结果摘要：check-batch 返回 {count, ok, peakConcurrency}，单节点检测返回 {results[]}。 */
export function jobResultSummary(job: DetectJob): string {
  const result = job.result
  if (!result) return job.message || "无结果"
  if (typeof result.count === "number") {
    const parts = ["检测 " + result.count + " 个", "成功 " + (typeof result.ok === "number" ? result.ok : "—")]
    if (typeof result.peakConcurrency === "number") parts.push("峰值并发 " + result.peakConcurrency)
    return parts.join(" · ")
  }
  if (Array.isArray(result.results)) {
    const ok = result.results.filter((item: any) => item?.ok).length
    return "检测 " + result.results.length + " 个 · 成功 " + ok
  }
  return job.message || "—"
}

export function aggregateJobResults(jobs: DetectJob[]): { checked: number; ok: number; failed: number } {
  let checked = 0
  let ok = 0
  for (const job of jobs) {
    const result = job.result
    if (!result) continue
    if (typeof result.count === "number") {
      checked += result.count
      ok += typeof result.ok === "number" ? result.ok : 0
      continue
    }
    if (Array.isArray(result.results)) {
      checked += result.results.length
      ok += result.results.filter((item: any) => item?.ok).length
    }
  }
  return { checked, ok, failed: Math.max(0, checked - ok) }
}
