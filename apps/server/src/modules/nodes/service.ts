import { and, asc, count, eq, isNotNull, like, or, sql } from 'drizzle-orm'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { parseBool } from '../../core/http'
import {
  appliedNodes,
  nodeAliases,
  nodeCheckRuns,
  nodeCredentials,
  nodeSources,
  nodeStatus,
  nodes as nodesT,
} from '../../core/schema'

/** 生成客户端连接串（PANEL.md §10.2 / §11.1 /api/nodes/:id/connection）。 */
export function connectionStrings(username: string, password: string, host: string, port: number) {
  const http = 'http://' + username + ':' + password + '@' + host + ':' + port
  const socks = 'socks5h://' + username + ':' + password + '@' + host + ':' + port
  return {
    http,
    socks5: socks,
    curl: 'curl -x ' + http + ' https://api.ip.sb/geoip',
    docker: ['HTTP_PROXY=' + http, 'HTTPS_PROXY=' + http, 'NO_PROXY=localhost,127.0.0.1,::1'],
    env: 'export HTTP_PROXY=' + http + '\nexport HTTPS_PROXY=' + http + '\nexport NO_PROXY=localhost,127.0.0.1,::1',
    clash: [
      'proxies:',
      '  - name: ' + username,
      '    type: http',
      '    server: ' + host,
      '    port: ' + port,
      '    username: ' + username,
      '    password: ' + password,
    ].join('\n'),
  }
}

/** 节点列表查询（/api/nodes 与 /v1/nodes 共用）。 */
export function listNodes(ctx: AppContext, q: Record<string, string | undefined>, limit: number, offset: number, withCredentials = true) {
  const { db } = ctx
  const conds = []
  if (q.state) conds.push(sql`COALESCE(${nodeStatus.state}, 'unknown') = ${q.state}`)
  if (q.protocol) conds.push(eq(nodesT.protocol, q.protocol))
  if (q.country) conds.push(sql`UPPER(COALESCE(${nodesT.country_code}, '')) = ${q.country.toUpperCase()}`)
  if (q.enabled !== undefined) conds.push(eq(nodesT.enabled, parseBool(q.enabled) ? 1 : 0))
  if (q.supported !== undefined) conds.push(eq(nodesT.protocol_supported, parseBool(q.supported) ? 1 : 0))
  if (q.missing === 'true') conds.push(isNotNull(nodesT.missing_since))
  if (q.q) {
    const needle = '%' + q.q + '%'
    conds.push(
      or(like(nodesT.id, needle), like(nodesT.display_name, needle), like(nodesT.protocol, needle))!
    )
  }
  const where = conds.length ? and(...conds) : undefined
  const total =
    db
      .select({ n: count() })
      .from(nodesT)
      .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
      .where(where)
      .get()?.n ?? 0
  const orderBy = q.sort === 'latency' ? asc(nodeStatus.delay_ms) : q.sort === 'state' ? asc(nodeStatus.state) : asc(nodesT.id)
  const rows = db
    .select({
      id: nodesT.id,
      display_name: nodesT.display_name,
      country_code: nodesT.country_code,
      region: nodesT.region,
      protocol: nodesT.protocol,
      protocol_supported: nodesT.protocol_supported,
      enabled: nodesT.enabled,
      publish_error: nodesT.publish_error,
      first_seen_at: nodesT.first_seen_at,
      last_seen_at: nodesT.last_seen_at,
      missing_since: nodesT.missing_since,
      stale_until: nodesT.stale_until,
      check_depth: nodesT.check_depth,
      state: nodeStatus.state,
      last_check_at: nodeStatus.last_check_at,
      connect_ms: nodeStatus.connect_ms,
      total_ms: nodeStatus.total_ms,
      delay_ms: nodeStatus.delay_ms,
      exit_ip: nodeStatus.exit_ip,
      exit_country: nodeStatus.exit_country,
      exit_region: nodeStatus.exit_region,
      exit_asn: nodeStatus.exit_asn,
      error_kind: nodeStatus.error_kind,
      error_msg: nodeStatus.error_msg,
      fail_streak: nodeStatus.fail_streak,
      success_streak: nodeStatus.success_streak,
      recovered_at: nodeStatus.recovered_at,
      next_check_at: nodeStatus.next_check_at,
      checks_total: nodeStatus.checks_total,
      checks_ok: nodeStatus.checks_ok,
      uptime_24h: nodeStatus.uptime_24h,
    })
    .from(nodesT)
    .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset)
    .all()
  const items = rows.map((r) => {
    const sources = db
      .select({ subscription_id: nodeSources.subscription_id, name_in_sub: nodeSources.name_in_sub })
      .from(nodeSources)
      .where(eq(nodeSources.node_id, r.id))
      .all()
    const base: any = {
      id: r.id,
      displayName: r.display_name,
      countryCode: r.country_code,
      region: r.region,
      protocol: r.protocol,
      protocolSupported: !!r.protocol_supported,
      publishError: r.publish_error,
      enabled: !!r.enabled,
      missingSince: r.missing_since,
      staleUntil: r.stale_until,
      checkDepth: r.check_depth,
      sources: sources.map((s) => s.subscription_id),
      sourceNames: sources.map((s) => s.name_in_sub),
      status: {
        state: r.state ?? 'unknown',
        lastCheckAt: r.last_check_at,
        connectMs: r.connect_ms,
        totalMs: r.total_ms,
        delayMs: r.delay_ms,
        exitIp: r.exit_ip,
        exitCountry: r.exit_country,
        exitRegion: r.exit_region,
        exitAsn: r.exit_asn,
        errorKind: r.error_kind,
        errorMsg: r.error_msg,
        failStreak: r.fail_streak ?? 0,
        successStreak: r.success_streak ?? 0,
        recoveredAt: r.recovered_at,
        nextCheckAt: r.next_check_at,
        checksTotal: r.checks_total ?? 0,
        checksOk: r.checks_ok ?? 0,
        uptime24h: r.uptime_24h ?? 0,
      },
    }
    if (withCredentials) {
      const cred = db
        .select({ username: nodeCredentials.username })
        .from(nodeCredentials)
        .where(eq(nodeCredentials.node_id, r.id))
        .get()
      base.username = cred?.username ?? r.id
    }
    return base
  })
  return { items, total, nextCursor: offset + limit < total ? offset + limit : null, updatedAt: Date.now() }
}

/**
 * 删除节点（仅限已停用/已消失）。
 * applied_nodes 故意保留：对账时它会让数据面按 plan.remove 走 rmi/rmrules + 延迟 rmo，
 * 如果连这条「信念」一起删掉，旧 tag 就再也无法被识别和清理。
 */
export function createNodesService(ctx: AppContext) {
  const purgeNodeRow = (nodeId: string): { found: boolean; applied: boolean; closed: number } => {
    const existing = ctx.db
      .select({ id: nodesT.id, enabled: nodesT.enabled, missing_since: nodesT.missing_since })
      .from(nodesT)
      .where(eq(nodesT.id, nodeId))
      .get()
    if (!existing) return { found: false, applied: false, closed: 0 }
    if (existing.enabled && existing.missing_since === null) {
      throw new AppError('conflict', '节点仍在启用中：请先停用（并发布）后再删除，避免误删正在使用的入站', 409)
    }
    const hasApplied = !!ctx.db.select({ node_id: appliedNodes.node_id }).from(appliedNodes).where(eq(appliedNodes.node_id, nodeId)).get()
    const closed = ctx.kick({ nodeId })
    ctx.routing.delete(nodeId)
    ctx.routing.persist()
    ctx.ports.release(nodeId)
    ctx.db.delete(nodesT).where(eq(nodesT.id, nodeId)).run()
    ctx.db.delete(nodeCredentials).where(eq(nodeCredentials.node_id, nodeId)).run()
    ctx.db.delete(nodeSources).where(eq(nodeSources.node_id, nodeId)).run()
    ctx.db.delete(nodeStatus).where(eq(nodeStatus.node_id, nodeId)).run()
    ctx.db.delete(nodeCheckRuns).where(eq(nodeCheckRuns.node_id, nodeId)).run()
    ctx.db.delete(nodeAliases).where(or(eq(nodeAliases.node_id, nodeId), eq(nodeAliases.alias, nodeId))).run()
    return { found: true, applied: hasApplied, closed }
  }
  return { purgeNodeRow }
}
