import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { parseBool } from '../../core/http'

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
  const where: string[] = []
  const params: any[] = []
  if (q.state) {
    where.push("COALESCE(st.state,'unknown') = ?")
    params.push(q.state)
  }
  if (q.protocol) {
    where.push('n.protocol = ?')
    params.push(q.protocol)
  }
  if (q.country) {
    where.push("UPPER(COALESCE(n.country_code, '')) = ?")
    params.push(q.country.toUpperCase())
  }
  if (q.enabled !== undefined) {
    where.push('n.enabled = ?')
    params.push(parseBool(q.enabled) ? 1 : 0)
  }
  if (q.supported !== undefined) {
    where.push('n.protocol_supported = ?')
    params.push(parseBool(q.supported) ? 1 : 0)
  }
  if (q.missing === 'true') where.push('n.missing_since IS NOT NULL')
  if (q.q) {
    where.push('(n.id LIKE ? OR n.display_name LIKE ? OR n.protocol LIKE ?)')
    params.push('%' + q.q + '%', '%' + q.q + '%', '%' + q.q + '%')
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM nodes n LEFT JOIN node_status st ON st.node_id = n.id' + clause, params)?.n ?? 0
  const order = q.sort === 'latency' ? 'st.delay_ms ASC' : q.sort === 'state' ? 'st.state ASC' : 'n.id ASC'
  const rows = db.all<any>(
    'SELECT n.id, n.display_name, n.country_code, n.region, n.protocol, n.protocol_supported, n.enabled, n.publish_error, n.params_hash, ' +
      'n.first_seen_at, n.last_seen_at, n.missing_since, n.stale_until, n.check_depth, ' +
      'st.state, st.last_check_at, st.connect_ms, st.total_ms, st.delay_ms, st.exit_ip, st.exit_country, st.exit_region, st.exit_asn, ' +
      'st.error_kind, st.error_msg, st.fail_streak, st.success_streak, st.recovered_at, st.next_check_at, st.checks_total, st.checks_ok, st.uptime_24h ' +
      'FROM nodes n LEFT JOIN node_status st ON st.node_id = n.id' +
      clause +
      ' ORDER BY ' +
      order +
      ' LIMIT ? OFFSET ?',
    [...params, limit, offset],
  )
  const items = rows.map((r) => {
    const sources = db.all<{ subscription_id: string; name_in_sub: string }>('SELECT subscription_id, name_in_sub FROM node_sources WHERE node_id = ?', [r.id])
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
      const cred = db.get<{ username: string }>('SELECT username FROM node_credentials WHERE node_id = ?', [r.id])
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
    const existing = ctx.db.get<{ id: string; enabled: number; missing_since: number | null }>('SELECT id, enabled, missing_since FROM nodes WHERE id = ?', [nodeId])
    if (!existing) return { found: false, applied: false, closed: 0 }
    if (existing.enabled && existing.missing_since === null) {
      throw new AppError('conflict', '节点仍在启用中：请先停用（并发布）后再删除，避免误删正在使用的入站', 409)
    }
    const hasApplied = !!ctx.db.get<{ node_id: string }>('SELECT node_id FROM applied_nodes WHERE node_id = ?', [nodeId])
    const closed = ctx.kick({ nodeId })
    ctx.routing.delete(nodeId)
    ctx.routing.persist()
    ctx.ports.release(nodeId)
    ctx.db.run('DELETE FROM nodes WHERE id = ?', [nodeId])
    ctx.db.run('DELETE FROM node_credentials WHERE node_id = ?', [nodeId])
    ctx.db.run('DELETE FROM node_sources WHERE node_id = ?', [nodeId])
    ctx.db.run('DELETE FROM node_status WHERE node_id = ?', [nodeId])
    ctx.db.run('DELETE FROM node_check_runs WHERE node_id = ?', [nodeId])
    ctx.db.run('DELETE FROM node_aliases WHERE node_id = ? OR alias = ?', [nodeId, nodeId])
    return { found: true, applied: hasApplied, closed }
  }
  return { purgeNodeRow }
}
