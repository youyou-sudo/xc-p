import { Elysia } from 'elysia'
import { asc, desc, eq, isNotNull } from 'drizzle-orm'
import { nodeAliases, nodeCheckRuns, nodeCredentials, nodePort, nodeSources, nodeStatus, nodes as nodesT } from '../../core/schema'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { clientIp, parsePaging } from '../../core/http'
import type { createSessionPlugin } from '../../plugins/session'
import { nodeCheckBatchBody, nodeCheckBody, nodePatchBody } from './model'
import { connectionStrings, listNodes, type createNodesService } from './service'
import { enqueueReconcileJob } from '../runtime/service'

type SessionPlugin = ReturnType<typeof createSessionPlugin>
type NodesService = ReturnType<typeof createNodesService>

/** 节点模块（/api/nodes）。 */
export function nodesModule(ctx: AppContext, session: SessionPlugin, service: NodesService) {
  const { db, settings, events, jobs, auth, sync, detector } = ctx
  return new Elysia({ name: 'api/nodes', prefix: '/api' })
    .use(session)
    .get('/nodes', ({ query }) => {
      const q = query as Record<string, string | undefined>
      const p = parsePaging(q)
      return listNodes(ctx, q, p.limit, p.offset)
    }, { requireSession: true })
    .patch(
      '/nodes/:id',
      ({ params, body }) => {
        const row = db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.id, params.id)).get()
        if (!row) throw new AppError('not_found', '节点不存在', 404)
        const patch: Partial<typeof nodesT.$inferInsert> = {}
        if (body.displayName !== undefined) patch.display_name = String(body.displayName)
        if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
        if (body.countryCode !== undefined) patch.country_code = body.countryCode ? String(body.countryCode).toUpperCase() : null
        if (body.region !== undefined) patch.region = body.region ?? null
        if (body.publishPolicyOverride !== undefined) patch.publish_policy_override = body.publishPolicyOverride ?? null
        if (body.checkDepth !== undefined) patch.check_depth = body.checkDepth === 'lite' ? 'lite' : 'full'
        if (body.rename) {
          // 改名 = 旧 ID 进 node_aliases（active=1），新旧用户名都能用（§7.4）
          const newId = String(body.rename)
          if (!/^[A-Za-z0-9_.-]{2,32}$/.test(newId)) throw new AppError('validation_failed', '新节点 ID 只允许字母数字与 _.-', 422)
          if (db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.id, newId)).get()) throw new AppError('conflict', '节点 ID 已存在', 409)
          db.insert(nodeAliases).values({ alias: params.id, node_id: newId, created_at: Date.now(), active: 1 }).run()
          db.update(nodesT).set({ id: newId, display_name: body.displayName ?? newId }).where(eq(nodesT.id, params.id)).run()
          db.update(nodeCredentials).set({ node_id: newId, username: newId }).where(eq(nodeCredentials.node_id, params.id)).run()
          db.update(nodeSources).set({ node_id: newId }).where(eq(nodeSources.node_id, params.id)).run()
          db.update(nodePort).set({ node_id: newId }).where(eq(nodePort.node_id, params.id)).run()
          db.update(nodeStatus).set({ node_id: newId }).where(eq(nodeStatus.node_id, params.id)).run()
          db.update(nodeCheckRuns).set({ node_id: newId }).where(eq(nodeCheckRuns.node_id, params.id)).run()
          auth.audit('panel', 'admin', 'node.rename', params.id, null, { to: newId })
          events.warn('node.renamed', '节点 ' + params.id + ' 改名为 ' + newId + '（别名仍可路由）', { nodeId: newId })
          return { ok: true, id: newId }
        }
        if (Object.keys(patch).length === 0) return { ok: true }
        patch.updated_at = Date.now()
        db.update(nodesT).set(patch).where(eq(nodesT.id, params.id)).run()
        auth.audit('panel', 'admin', 'node.update', params.id, null, body)
        return { ok: true }
      },
      { body: nodePatchBody, requireSession: true },
    )
    /** 删除节点（仅已停用/已消失）：删除期望状态记录，并自动触发一次对账清理数据面。 */
    .delete('/nodes/:id', ({ params, request }) => {
      const result = service.purgeNodeRow(params.id)
      if (!result.found) throw new AppError('not_found', '节点不存在', 404)
      auth.audit('panel', 'admin', 'node.delete', params.id, clientIp(request), { applied: result.applied, closed: result.closed })
      events.warn(
        'node.deleted',
        '节点 ' + params.id + ' 已从期望状态删除；数据面将由对账任务清理' + (result.closed ? '（断开 ' + result.closed + ' 条连接）' : ''),
        { nodeId: params.id },
      )
      const jobId = result.applied ? enqueueReconcileJob(ctx, { reason: 'node_purge', nodeId: params.id }) : null
      return { ok: true, jobId, closed: result.closed }
    }, { requireSession: true })
    .post('/nodes/purge-missing', () => {
      // 「已消失」= 当前所有订阅都不再提供该节点（同步时写入 missing_since）。
      const rows = db
        .select({ id: nodesT.id })
        .from(nodesT)
        .where(isNotNull(nodesT.missing_since))
        .orderBy(asc(nodesT.id))
        .all()
      let removed = 0
      let needApply = false
      let closed = 0
      for (const row of rows) {
        const result = service.purgeNodeRow(row.id)
        if (!result.found) continue
        removed++
        closed += result.closed
        needApply = needApply || result.applied
      }
      if (removed > 0) {
        auth.audit('panel', 'admin', 'node.purge_missing', null, null, { removed, applied: needApply })
        events.warn('node.purged', '已清理 ' + removed + ' 个已消失节点' + (needApply ? '，正在对账清理数据面…' : ''))
      }
      const jobId = needApply ? enqueueReconcileJob(ctx, { reason: 'purge_missing', count: removed }) : null
      return { ok: true, removed, jobId, closed }
    }, { requireSession: true })
    .post('/nodes/:id/rotate', ({ params }) => {
      const cred = sync.rotate(params.id)
      auth.audit('panel', 'admin', 'node.rotate', params.id, null, null)
      return { ok: true, username: cred.username, password: cred.password, effectiveImmediately: true }
    }, { requireSession: true })
    .post('/nodes/:id/disconnect', ({ params }) => {
      const n = ctx.kick({ nodeId: params.id })
      auth.audit('panel', 'admin', 'node.disconnect', params.id, null, { closed: n })
      return { ok: true, closed: n }
    }, { requireSession: true })
    .get('/nodes/:id/checks', ({ params, query }) => {
      const p = parsePaging(query)
      return {
        items: db
          .select()
          .from(nodeCheckRuns)
          .where(eq(nodeCheckRuns.node_id, params.id))
          .orderBy(desc(nodeCheckRuns.at))
          .limit(p.limit)
          .offset(p.offset)
          .all(),
      }
    }, { requireSession: true })
    .get('/nodes/:id/connection', ({ params }) => {
      const cred = sync.credentialOf(params.id)
      if (!cred) throw new AppError('not_found', '节点凭据不存在', 404)
      const gw = ctx.gatewayInfo()
      const baseUrl = settings.get().panel.baseUrl || 'xc-p'
      return { nodeId: params.id, ...connectionStrings(cred.username, cred.password, baseUrl, gw.port) }
    }, { requireSession: true })
    .post(
      '/nodes/:id/check',
      ({ params, body }) => {
        const depth = body.depth === 'lite' ? 'lite' : 'full'
        const jobId = jobs.enqueue('detect', 'detect', { nodeIds: [params.id] }, 'panel', async (_id, jctx) => {
          const targets = detector.loadTargets([params.id], true)
          jctx.setProgress(0, targets.length, '检测 ' + params.id)
          const results = await detector.run(targets, { source: 'manual', depth, onProgress: (d, tot) => jctx.setProgress(d, tot) })
          return { results }
        })
        return { jobId }
      },
      { body: nodeCheckBody, requireSession: true },
    )
    .post(
      '/nodes/check-batch',
      ({ body }) => {
        const nodeIds: string[] | undefined = Array.isArray(body.nodeIds) && body.nodeIds.length ? body.nodeIds : undefined
        const depth = body.depth === 'lite' ? 'lite' : 'full'
        const jobId = jobs.enqueue('detect', 'detect', { nodeIds: nodeIds ?? 'all', depth }, 'panel', async (_id, jctx) => {
          const targets = detector.loadTargets(nodeIds, true)
          detector.semaphore.resetPeak()
          jctx.setProgress(0, targets.length, '批量检测 ' + targets.length + ' 个节点')
          const results = await detector.run(targets, { source: 'manual', depth, onProgress: (d, tot) => jctx.setProgress(d, tot) })
          return { count: results.length, ok: results.filter((r) => r.ok).length, peakConcurrency: detector.peakConcurrency(), limit: detector.semaphore.capacity }
        })
        return { jobId }
      },
      { body: nodeCheckBatchBody, requireSession: true },
    )
}
