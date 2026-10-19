import type { AppContext } from '../../context'

/** Prometheus 文本格式指标（/api/metrics）。 */
export function prometheus(ctx: AppContext): string {
  const { db } = ctx
  const lines: string[] = []
  const states = db.all<{ state: string; n: number }>("SELECT COALESCE(st.state,'unknown') AS state, COUNT(*) AS n FROM nodes n LEFT JOIN node_status st ON st.node_id = n.id GROUP BY state")
  lines.push('# HELP xcp_nodes_total 节点按状态计数')
  lines.push('# TYPE xcp_nodes_total gauge')
  for (const s of states) lines.push('xcp_nodes_total{state="' + s.state + '"} ' + s.n)
  const lat = db.all<{ node_id: string; delay_ms: number }>('SELECT node_id, delay_ms FROM node_status WHERE delay_ms IS NOT NULL')
  lines.push('# HELP xcp_node_latency_ms 节点延迟')
  lines.push('# TYPE xcp_node_latency_ms gauge')
  for (const l of lat) lines.push('xcp_node_latency_ms{node="' + l.node_id + '"} ' + l.delay_ms)
  const syncDur = db.get<{ d: number }>('SELECT AVG(duration_ms) AS d FROM subscription_runs WHERE duration_ms IS NOT NULL')
  lines.push('# HELP xcp_sync_duration_seconds 同步平均耗时')
  lines.push('# TYPE xcp_sync_duration_seconds gauge')
  lines.push('xcp_sync_duration_seconds ' + ((syncDur?.d ?? 0) / 1000).toFixed(3))
  const pubs = db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM runtime_revisions GROUP BY status')
  lines.push('# HELP xcp_publish_total 发布结果计数')
  lines.push('# TYPE xcp_publish_total counter')
  for (const p of pubs) lines.push('xcp_publish_total{result="' + p.status + '"} ' + p.n)
  const hot = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM xray_apply_ops WHERE op IN ('ado','rmo') AND ok=1")
  lines.push('# HELP xcp_xray_hot_ops_total 热操作累计次数')
  lines.push('# TYPE xcp_xray_hot_ops_total counter')
  lines.push('xcp_xray_hot_ops_total ' + (hot?.n ?? 0))
  const apiErr = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xray_apply_ops WHERE ok = 0')
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
