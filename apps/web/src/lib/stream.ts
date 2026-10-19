/** GET /api/stream（SSE）实时事件通道：断线指数退避重连，页面隐藏时暂停重连。 */
import { createStore, useStore } from "./store"

export interface StreamMessage {
  type: string
  jobId: string | null
  status: string | null
  progress: number | undefined
  total: number | undefined
  message: string
  op: string | null
  stage: string | null
  level: string | null
  kind: string | null
  nodeId: string | null
  revisionId: string | null
  at: number
  error: any
  result: any
  raw: any
}

type StreamListener = (message: StreamMessage) => void
const listeners = new Set<StreamListener>()

export function subscribeStream(listener: StreamListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emitMessage(message: StreamMessage) {
  for (const listener of [...listeners]) {
    try {
      listener(message)
    } catch (error) {
      console.error("[stream]", error)
    }
  }
}

export interface StreamState {
  connected: boolean
  lastEventAt: number
}

const streamStore = createStore<StreamState>({ connected: false, lastEventAt: 0 })

export function useStreamState(): StreamState {
  return useStore(streamStore)
}

let source: EventSource | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let started = false

function emptyMessage(data: unknown): StreamMessage {
  return {
    type: "log",
    jobId: null,
    status: null,
    progress: undefined,
    total: undefined,
    message: String(data),
    op: null,
    stage: null,
    level: null,
    kind: null,
    nodeId: null,
    revisionId: null,
    at: Date.now(),
    error: null,
    result: null,
    raw: data,
  }
}

function parseMessage(event: MessageEvent): StreamMessage | null {
  if (!event?.data) return null
  let data: any
  try {
    data = JSON.parse(event.data)
  } catch {
    return emptyMessage(event.data)
  }
  const job = data.job ?? {}
  return {
    type: data.type ?? data.event ?? (data.job ? "job" : "event"),
    jobId: data.jobId ?? data.job_id ?? job.id ?? null,
    status: data.status ?? job.status ?? null,
    progress: data.progress !== undefined ? data.progress : job.progress,
    total: data.total !== undefined ? data.total : job.total,
    message: data.message ?? job.message ?? "",
    op: data.op ?? null,
    stage: data.stage ?? data.step ?? null,
    level: data.level ?? null,
    kind: data.kind ?? job.kind ?? null,
    nodeId: data.nodeId ?? data.node_id ?? null,
    revisionId: data.revisionId ?? data.revision_id ?? null,
    at: data.at ?? Date.now(),
    error: data.error ?? job.error ?? null,
    result: data.result ?? job.result ?? null,
    raw: data,
  }
}

function dispatch(event: MessageEvent) {
  const message = parseMessage(event)
  if (!message) return
  streamStore.set((prev) => ({ ...prev, lastEventAt: message.at || Date.now() }))
  emitMessage(message)
}

function open() {
  if (source || typeof window === "undefined") return
  try {
    source = new EventSource("/api/stream")
  } catch {
    scheduleRetry()
    return
  }
  source.onopen = () => {
    retry = 0
    streamStore.set((prev) => ({ ...prev, connected: true }))
  }
  source.onerror = () => {
    streamStore.set((prev) => ({ ...prev, connected: false }))
    cleanup()
    scheduleRetry()
  }
  source.onmessage = dispatch
  for (const type of ["job", "progress", "event", "node", "publish", "gateway", "reconcile"]) {
    source.addEventListener(type, dispatch)
  }
}

function cleanup() {
  if (source) {
    try {
      source.close()
    } catch {
      /* ignore */
    }
    source = null
  }
}

function scheduleRetry() {
  if (retryTimer) return
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retry, 5))
  retry++
  retryTimer = setTimeout(() => {
    retryTimer = null
    open()
  }, delay)
}

function disconnect() {
  cleanup()
  started = false
  streamStore.set((prev) => ({ ...prev, connected: false }))
}

/** 进入鉴权区域时连接；返回的清理函数会断开并停止重连（如退出登录）。 */
export function connectStream(): () => void {
  if (typeof window === "undefined") return () => {}
  const onVisible = () => {
    if (document.visibilityState === "visible") open()
  }
  const onOnline = () => {
    retry = 0
    open()
  }
  if (!started) {
    started = true
    open()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", onOnline)
  }
  return () => {
    // 离开鉴权区域（如退出登录）时断开，避免 401 的 EventSource 无限重连。
    document.removeEventListener("visibilitychange", onVisible)
    window.removeEventListener("online", onOnline)
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    disconnect()
  }
}
