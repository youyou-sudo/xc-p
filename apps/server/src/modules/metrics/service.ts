import { and, avg, count, eq, isNotNull, sql } from 'drizzle-orm'
import type { AppContext } from '../../context'
import { nodeStatus, nodes as nodesT, runtimeRevisions, subscriptionRuns, xrayApplyOps } from '../../core/schema'

/** Prometheus 文本格式指标（/api/metrics）。 */
export function prometheus(ctx: AppContext): string {
  const { db } = ctx
  const lines: string[] = []
  const states = db
    .select({ state: sql<string>`COALESCE(${nodeStatus.state}, 'unknown')`, n: count() })
    .from(nodesT)
    .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
    .groupBy(sql`COALESCE(${nodeStatus.state}, 'unknown')`)
    .all()
  lines.push('# HELP xcp_nodes_total 节点按状态计数')
  lines.push('# TYPE xcp_nodes_total gauge')
  for (const s of states) lines.push('xcp_nodes_total{state="' + s.state + '"} ' + s.n)
  const lat = db
    .select({ node_id: nodeStatus.node_id, delay_ms: nodeStatus.delay_ms })
    .from(nodeStatus)
    .where(isNotNull(nodeStatus.delay_ms))
    .all()
  lines.push('# HELP xcp_node_latency_ms 节点延迟')
  lines.push('# TYPE xcp_node_latency_ms gauge')
  for (const l of lat) lines.push('xcp_node_latency_ms{node="' + l.node_id + '"} ' + l.delay_ms)
  const syncDur = db
    .select({ d: avg(subscriptionRuns.duration_ms) })
    .from(subscriptionRuns)
    .where(isNotNull(subscriptionRuns.duration_ms))
    .get()
  lines.push('# HELP xcp_sync_duration_seconds 同步平均耗时')
  lines.push('# TYPE xcp_sync_duration_seconds gauge')
  // AVG() 在 sqlite 驱动里以数值/字符串形式返回，显式转成数字再换算秒
  lines.push('xcp_sync_duration_seconds ' + (Number(syncDur?.d ?? 0) / 1000).toFixed(3))
  const pubs = db
    .select({ status: runtimeRevisions.status, n: count() })
    .from(runtimeRevisions)
    .groupBy(runtimeRevisions.status)
    .all()
  lines.push('# HELP xcp_publish_total 发布结果计数')
  lines.push('# TYPE xcp_publish_total counter')
  for (const p of pubs) lines.push('xcp_publish_total{result="' + p.status + '"} ' + p.n)
  const hot = db
    .select({ n: count() })
    .from(xrayApplyOps)
    .where(and(sql`${xrayApplyOps.op} IN ('ado','rmo')`, eq(xrayApplyOps.ok, 1)))
    .get()
  lines.push('# HELP xcp_xray_hot_ops_total 热操作累计次数')
  lines.push('# TYPE xcp_xray_hot_ops_total counter')
  lines.push('xcp_xray_hot_ops_total ' + (hot?.n ?? 0))
  const apiErr = db.select({ n: count() }).from(xrayApplyOps).where(eq(xrayApplyOps.ok, 0)).get()
  lines.push('# HELP xcp_xray_api_errors_total 数据面 API 失败次数')
  lines.push('# TYPE xcp_xray_api_errors_total counter')
  lines.push('xcp_xray_api_errors_total ' + (apiErr?.n ?? 0))
  lines.push('# HELP xcp_gateway_conns 网关活跃连接数')
  lines.push('# TYPE xcp_gateway_conns gauge')
  const byNode = ctx.conns.byNode()
  for (const [node, n] of Object.entries(byNode)) lines.push('xcp_gateway_conns{node="' + node + '"} ' + n)
  if (Object.keys(byNode).length === 0) lines.push('xcp_gateway_conns{node=""} 0')
  const authFail = ctx.gateway ? ctx.gateway.stats().authFailures5m : 0
  lines.push('# HELP xcp_gateway_auth_failures_total 认证失败次数')
  lines.push('# TYPE xcp_gateway_auth_failures_total counter')
  lines.push('xcp_gateway_auth_failures_total ' + authFail)
  const portStats = ctx.ports.stats()
  lines.push('# HELP xcp_ports_used 已用环回端口数')
  lines.push('# TYPE xcp_ports_used gauge')
  lines.push('xcp_ports_used ' + portStats.used)
  lines.push('# HELP xcp_pending_retire 待退休 tag 数')
  lines.push('# TYPE xcp_pending_retire gauge')
  lines.push('xcp_pending_retire ' + ctx.retire.count())
  return lines.join('\n') + '\n'
}
