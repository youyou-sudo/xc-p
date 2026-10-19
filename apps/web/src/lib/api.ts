/**
 * /api/* 客户端（PANEL.md §11.1）——基于 Elysia Eden Treaty 的端到端类型安全调用。
 *
 * 后端 Elysia 路由类型经 @xc-p/api-client 共享：
 *   const data = await unwrap(eden.api.nodes.get({ query: { limit: 50 } }))
 *
 * 面板内部统一用 `unwrap(...)` 把 Eden 结果转成「成功返回 data / 失败抛 ApiError」，
 * 这样 useResource / useAction / useConfirm 的既有错误处理保持不变。
 * 401 由 Eden 的 onResponse 统一触发登出（见 setUnauthorizedHandler）。
 */
import { ApiError, createEdenClient, unwrap, type EdenResult } from "@xc-p/api-client"

export { ApiError, unwrap }

let onUnauthorized: ((error: ApiError) => void) | null = null

export function setUnauthorizedHandler(fn: ((error: ApiError) => void) | null) {
  onUnauthorized = fn
}

/** 同源部署：keepDomain + 空 baseUrl → 浏览器请求 /api/... 相对路径。 */
export const eden = createEdenClient({
  headers: { "x-requested-with": "xc-p-panel" },
  onUnauthorized: () => onUnauthorized?.(new ApiError(401, "unauthorized", "未登录或会话已过期")),
})

/** 长任务统一入口：接受 Eden 调用，返回 jobId（§5：任务类接口立即返回 { jobId }）。 */
export async function startJob<R extends EdenResult>(result: R | Promise<R>) {
  const value = (await unwrap(result)) as unknown as { jobId?: string | null; job_id?: string | null; job?: { id?: string } }
  const jobId = value?.jobId ?? value?.job_id ?? value?.job?.id ?? null
  return { jobId: jobId as string | null }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "network_error") return error.message
    return error.message || "请求失败（" + error.status + "）"
  }
  if (error instanceof Error) return error.message
  return String(error ?? "未知错误")
}

/** /api/nodes 返回的节点把检测结果放在 status 子对象里；页面统一用扁平字段 */
export function normalizeNode<T extends Record<string, any>>(n: T) {
  if (!n) return n
  const st = n.status ?? {}
  const sources = n.sourceNames ?? n.sources ?? n.subscriptions ?? []
  return {
    ...n,
    state: n.state ?? st.state ?? "unknown",
    delayMs: n.delayMs !== undefined ? n.delayMs : st.delayMs,
    totalMs: n.totalMs !== undefined ? n.totalMs : st.totalMs,
    connectMs: n.connectMs !== undefined ? n.connectMs : st.connectMs,
    handshakeMs: n.handshakeMs !== undefined ? n.handshakeMs : st.handshakeMs,
    exitIp: n.exitIp || st.exitIp || "",
    exitCountry: n.exitCountry || st.exitCountry || "",
    exitRegion: n.exitRegion || st.exitRegion || "",
    exitAsn: n.exitAsn || st.exitAsn || "",
    exitIsp: n.exitIsp || st.exitIsp || "",
    lastCheckAt: n.lastCheckAt || st.lastCheckAt || 0,
    lastOkAt: n.lastOkAt || st.lastOkAt || 0,
    failStreak: n.failStreak !== undefined ? n.failStreak : st.failStreak,
    successStreak: n.successStreak !== undefined ? n.successStreak : st.successStreak,
    uptime24h: n.uptime24h !== undefined ? n.uptime24h : st.uptime24h,
    checksTotal: n.checksTotal !== undefined ? n.checksTotal : st.checksTotal,
    checksOk: n.checksOk !== undefined ? n.checksOk : st.checksOk,
    errorKind: n.errorKind || st.errorKind || "",
    errorMsg: n.errorMsg || st.errorMsg || "",
    sourceNames: Array.isArray(sources) ? sources : [],
  }
}