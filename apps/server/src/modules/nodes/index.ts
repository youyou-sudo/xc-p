import { Elysia } from 'elysia'
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
        const row = db.get('SELECT id FROM nodes WHERE id = ?', [params.id])
        if (!row) throw new AppError('not_found', '节点不存在', 404)
        const sets: string[] = []
        const values: any[] = []
        if (body.displayName !== undefined) {
          sets.push('display_name = ?')
          values.push(String(body.displayName))
        }
        if (body.enabled !== undefined) {
          sets.push('enabled = ?')
          values.push(body.enabled ? 1 : 0)
        }
        if (body.countryCode !== undefined) {
          sets.push('country_code = ?')
          values.push(body.countryCode ? String(body.countryCode).toUpperCase() : null)
        }
        if (body.region !== undefined) {
          sets.push('region = ?')
          values.push(body.region ?? null)
        }
        if (body.publishPolicyOverride !== undefined) {
          sets.push('publish_policy_override = ?')
          values.push(body.publishPolicyOverride ?? null)
        }
        if (body.checkDepth !== undefined) {
          sets.push('check_depth = ?')
          values.push(body.checkDepth === 'lite' ? 'lite' : 'full')
        }
        if (body.rename) {
          // 改名 = 旧 ID 进 node_aliases（active=1），新旧用户名都能用（§7.4）
          const newId = String(body.rename)
          if (!/^[A-Za-z0-9_.-]{2,32}$/.test(newId)) throw new AppError('validation_failed', '新节点 ID 只允许字母数字与 _.-', 422)
          if (db.get('SELECT id FROM nodes WHERE id = ?', [newId])) throw new AppError('conflict', '节点 ID 已存在', 409)
          db.run('INSERT INTO node_aliases (alias, node_id, created_at, active) VALUES (?,?,?,1)', [params.id, newId, Date.now()])
          db.run('UPDATE nodes SET id = ?, display_name = ? WHERE id = ?', [newId, body.displayName ?? newId, params.id])
          db.run('UPDATE node_credentials SET node_id = ?, username = ? WHERE node_id = ?', [newId, newId, params.id])
          db.run('UPDATE node_sources SET node_id = ? WHERE node_id = ?', [newId, params.id])
          db.run('UPDATE node_port SET node_id = ? WHERE node_id = ?', [newId, params.id])
          db.run('UPDATE node_status SET node_id = ? WHERE node_id = ?', [newId, params.id])
          db.run('UPDATE node_check_runs SET node_id = ? WHERE node_id = ?', [newId, params.id])
          auth.audit('panel', 'admin', 'node.rename', params.id, null, { to: newId })
          events.warn('node.renamed', '节点 ' + params.id + ' 改名为 ' + newId + '（别名仍可路由）', { nodeId: newId })
          return { ok: true, id: newId }
        }
        if (sets.length === 0) return { ok: true }
        sets.push('updated_at = ?')
        values.push(Date.now(), params.id)
        db.run('UPDATE nodes SET ' + sets.join(', ') + ' WHERE id = ?', values)
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
      const rows = db.all<{ id: string }>('SELECT id FROM nodes WHERE missing_since IS NOT NULL ORDER BY id ASC')
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
        items: db.all<any>('SELECT * FROM node_check_runs WHERE node_id = ? ORDER BY at DESC LIMIT ? OFFSET ?', [params.id, p.limit, p.offset]),
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
