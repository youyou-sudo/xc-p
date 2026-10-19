/** 长任务订阅：SSE 实时进度 + GET /api/jobs/:id 轮询兜底（§12.3）。 */
import { toast } from "sonner"
import { eden, unwrap } from "./api"
import { subscribeStream, type StreamMessage } from "./stream"

export interface JobOutcome {
  status: "ok" | "failed" | "cancelled"
  message?: string
  result?: any
  error?: any
}

interface JobHandler {
  label: string
  silent: boolean
  onProgress?: (message: StreamMessage) => void
  onDone?: (message: StreamMessage) => void
  onFail?: (message: StreamMessage) => void
  resolve: (outcome: JobOutcome) => void
  timer: ReturnType<typeof setInterval> | null
  settled: boolean
}

const jobHandlers = new Map<string, JobHandler>()

function finishJob(jobId: string, ok: boolean, message?: StreamMessage) {
  const handler = jobHandlers.get(jobId)
  if (!handler || handler.settled) return
  handler.settled = true
  if (handler.timer) clearInterval(handler.timer)
  jobHandlers.delete(jobId)
  const outcome: JobOutcome = {
    status: ok ? "ok" : message?.status === "cancelled" ? "cancelled" : "failed",
    message: message?.message,
    result: message?.result,
    error: message?.error,
  }
  if (ok) {
    handler.onDone?.(message ?? emptyMessage(jobId))
    if (!handler.silent) toast.success(handler.label + "已完成")
  } else {
    handler.onFail?.(message ?? emptyMessage(jobId))
    if (!handler.silent) toast.error(handler.label + "失败", { description: message?.message || message?.error?.message || undefined })
  }
  handler.resolve(outcome)
}

function emptyMessage(jobId: string): StreamMessage {
  return {
    type: "job",
    jobId,
    status: null,
    progress: undefined,
    total: undefined,
    message: "",
    op: null,
    stage: null,
    level: null,
    kind: null,
    nodeId: null,
    revisionId: null,
    at: Date.now(),
    error: null,
    result: null,
    raw: null,
  }
}

async function pollJob(jobId: string) {
  const handler = jobHandlers.get(jobId)
  if (!handler || handler.settled) return
  try {
    // /api/jobs/:id 直接展开任务行（snake_case），SSE 归一化逻辑本就按宽松字段读取。
    const job = (await unwrap(eden.api.jobs({ id: jobId }).get())) as unknown as Record<string, any>
    const message: StreamMessage = {
      type: "job",
      jobId,
      status: job.status ?? null,
      progress: job.progress,
      total: job.total,
      message: job.message ?? job.progress_message ?? "",
      op: null,
      stage: job.stage ?? null,
      level: null,
      kind: job.kind ?? null,
      nodeId: job.node_id ?? null,
      revisionId: null,
      at: Date.now(),
      error: job.error_json ? safeJson(job.error_json) : job.error ?? null,
      result: job.result ?? null,
      raw: job,
    }
    handler.onProgress?.(message)
    if (message.status === "ok" || message.status === "failed" || message.status === "cancelled") {
      finishJob(jobId, message.status === "ok", message)
    }
  } catch {
    /* 轮询失败保持现状，SSE 恢复后会补上 */
  }
}

function safeJson(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// SSE 消息按 jobId 路由到 watchJob 注册的处理器；模块加载即生效。
subscribeStream((message) => {
  if (!message.jobId) return
  const handler = jobHandlers.get(message.jobId)
  if (!handler) return
  handler.onProgress?.(message)
  const terminal = message.status === "ok" || message.status === "failed" || message.status === "cancelled"
  if (terminal) finishJob(message.jobId, message.status === "ok", message)
})

/** 订阅一个任务：SSE 实时进度 + /api/jobs/:id 轮询兜底。 */
export function watchJob(
  jobId: string | null | undefined,
  options: {
    label?: string
    silent?: boolean
    onProgress?: (message: StreamMessage) => void
    onDone?: (message: StreamMessage) => void
    onFail?: (message: StreamMessage) => void
  } = {},
): { done: Promise<JobOutcome>; cancel: () => Promise<void> } {
  const label = options.label ?? "任务"
  if (!jobId) {
    if (!options.silent) toast.error(label + "：服务端未返回任务号（jobId）")
    return {
      done: Promise.resolve({ status: "failed", error: { message: "缺少 jobId" } }),
      cancel: async () => {},
    }
  }
  const existing = jobHandlers.get(jobId)
  if (existing) {
    return {
      done: new Promise<JobOutcome>((resolve) => {
        const prevResolve = existing.resolve
        existing.resolve = (outcome) => {
          prevResolve(outcome)
          resolve(outcome)
        }
      }),
      cancel: () => cancelJob(jobId),
    }
  }
  let resolveFn: (outcome: JobOutcome) => void = () => {}
  const done = new Promise<JobOutcome>((resolve) => {
    resolveFn = resolve
  })
  const handler: JobHandler = {
    label,
    silent: !!options.silent,
    onProgress: options.onProgress,
    onDone: options.onDone,
    onFail: options.onFail,
    resolve: resolveFn,
    timer: null,
    settled: false,
  }
  jobHandlers.set(jobId, handler)
  handler.timer = setInterval(() => {
    void pollJob(jobId)
  }, 2_500)
  void pollJob(jobId)
  return { done, cancel: () => cancelJob(jobId) }
}

export async function cancelJob(jobId: string): Promise<void> {
  try {
    await unwrap(eden.api.jobs({ id: jobId }).cancel.post())
    toast.message("已请求取消任务")
  } catch (error) {
    toast.error("取消失败：", { description: String(error) })
  }
}
