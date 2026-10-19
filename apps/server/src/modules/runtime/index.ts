import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { parseBool, parsePaging } from '../../core/http'
import { APPLY_QUEUE } from '../../jobs/queue'
import { buildDesiredNodes, contentVariant } from '../../publish/desired'
import { buildDesiredNode, computePlan, type DesiredNode } from '../../xray/plan'
import type { createSessionPlugin } from '../../plugins/session'
import { runtimePublishBody, runtimeReconcileBody, runtimeRollbackBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 运行配置模块（/api/runtime）：发布、回滚、对账、重启与单节点重建。 */
export function runtimeModule(ctx: AppContext, session: SessionPlugin) {
  const { db, settings, jobs, auth, publisher, reconciler, retire, ports, conns, scheduler } = ctx
  return new Elysia({ name: 'api/runtime', prefix: '/api' })
    .use(session)
    .get('/runtime/status', async () => {
      const status = publisher.currentStatus()
      const snapshot = await reconciler.readDataplane('health')
      const planInfo = await publisher.plan()
      const latest = db.get<any>('SELECT * FROM runtime_revisions ORDER BY created_at DESC LIMIT 1')
      return {
        revision: status.revision,
        dataplane: {
          outbounds: snapshot.outbounds,
          inbounds: snapshot.inbounds,
          ruleCount: snapshot.rules.length,
          rulesSupported: snapshot.rulesSupported,
          digest: snapshot.digest,
          at: snapshot.at,
        },
        desired: { count: planInfo.desired.desired.length },
        diff: {
          add: planInfo.plan.add.map((n) => n.nodeId),
          change: planInfo.plan.change.map((c) => c.next.nodeId),
          remove: planInfo.plan.remove.map((r) => r.outboundTag),
          keep: planInfo.plan.keep.map((n) => n.nodeId),
          drift: planInfo.plan.drift,
        },
        pendingRetire: retire.list().map((r) => ({ tag: r.tag, kind: r.kind, retireAfter: r.retire_after, remainMs: Math.max(0, r.retire_after - Date.now()) })),
        hotOpsTotal: retire.hotOpsTotal(),
        hotOpsThreshold: settings.get().xray.hotOpsRestartThreshold,
        ports: ports.stats(),
        lastRevision: latest ? { id: latest.id, status: latest.status, error: latest.error } : null,
        scheduler: scheduler.list(),
      }
    }, { requireSession: true })
    .get('/runtime/revisions', ({ query }) => {
      const p = parsePaging(query)
      const rows = db.all<any>('SELECT * FROM runtime_revisions ORDER BY created_at DESC LIMIT ? OFFSET ?', [p.limit, p.offset])
      return {
        items: rows.map((r) => ({
          id: r.id,
          status: r.status,
          reason: r.reason,
          createdAt: r.created_at,
          appliedAt: r.applied_at,
          nodeCount: r.node_count,
          added: r.added_count,
          removed: r.removed_count,
          changed: r.changed_count,
          skipped: r.skipped_count,
          plan: r.plan_json ? JSON.parse(r.plan_json) : null,
          validation: r.validation_json ? JSON.parse(r.validation_json) : null,
          error: r.error,
          nodes: db.all('SELECT node_id, username, outbound_tag, inbound_tag, inbound_port FROM revision_nodes WHERE revision_id = ? LIMIT 500', [r.id]),
        })),
      }
    }, { requireSession: true })
    .post(
      '/runtime/publish',
      ({ body }) => {
        const dryRun = parseBool(body?.dryRun, false)
        const jobId = jobs.enqueue(APPLY_QUEUE, 'publish', { dryRun }, 'panel', async (_id, jctx) => {
          if (dryRun) {
            const r = await publisher.publish({ reason: 'manual', dryRun: true })
            return { dryRun: true, ok: r.ok, summary: r.summary, error: r.error, validation: r.validation }
          }
          jctx.setProgress(0, 1, '取快照并校验')
          const r = await publisher.publish({ reason: 'manual' })
          auth.audit('panel', 'admin', 'runtime.publish', r.revisionId, null, r.summary)
          return { revisionId: r.revisionId, ok: r.ok, summary: r.summary, error: r.error, validation: r.validation }
        })
        return { jobId }
      },
      { body: runtimePublishBody, requireSession: true },
    )
    .post(
      '/runtime/rollback',
      ({ body }) => {
        const revisionId = String(body?.revisionId ?? '')
        if (!revisionId) throw new AppError('validation_failed', 'revisionId 必填', 422)
        const jobId = jobs.enqueue(APPLY_QUEUE, 'rollback', { revisionId }, 'panel', async () => {
          const r = await publisher.rollback(revisionId)
          auth.audit('panel', 'admin', 'runtime.rollback', revisionId, null, { ok: r.ok })
          return { ok: r.ok, revisionId: r.revisionId, error: r.error, summary: r.summary }
        })
        return { jobId }
      },
      { body: runtimeRollbackBody, requireSession: true },
    )
    .post(
      '/runtime/reconcile',
      ({ body }) => {
        const dryRun = parseBool(body?.dryRun, false)
        const jobId = jobs.enqueue(APPLY_QUEUE, 'reconcile', { dryRun }, 'panel', async () => {
          const snap = buildDesiredNodes(db, settings, ports)
          const applied = publisher.appliedNodes()
          const r = await reconciler.reconcile(snap.desired, applied, { apply: !dryRun })
          return {
            consistent: r.consistent,
            drift: r.drift,
            applied: r.applied,
            add: r.plan.add.length,
            remove: r.plan.remove.length,
            cleanup: r.plan.cleanup.length,
            change: r.plan.change.length,
          }
        })
        return { jobId }
      },
      { body: runtimeReconcileBody, requireSession: true },
    )
    .post('/runtime/restart', () => {
      const activeConns = conns.count()
      const jobId = jobs.enqueue(APPLY_QUEUE, 'restart', { activeConns }, 'panel', async () => {
        auth.audit('panel', 'admin', 'runtime.restart', null, null, { activeConns })
        const r = await ctx.restartDataplane()
        return { ...r, disconnected: activeConns }
      })
      return { jobId, activeConns }
    }, { requireSession: true })
    .post('/runtime/node/:id/rebuild', ({ params }) => {
      const node = db.get<any>('SELECT n.*, c.username FROM nodes n JOIN node_credentials c ON c.node_id = n.id WHERE n.id = ?', [params.id])
      if (!node) throw new AppError('not_found', '节点不存在', 404)
      const jobId = jobs.enqueue(APPLY_QUEUE, 'publish', { nodeId: params.id }, 'panel', async () => {
        const template = JSON.parse(node.outbound_json) as Record<string, unknown>
        const port = ports.ensure(node.id)
        const applied = publisher.appliedNodes().filter((a) => a.nodeId === node.id)
        const snapshot = await reconciler.readDataplane('reconcile')
        const desired: DesiredNode = buildDesiredNode({ nodeId: node.id, username: node.username, port, outbound: template, variant: contentVariant(template) })
        const plan = computePlan([desired], applied, snapshot)
        // 这是「单节点重建」，不是全量对账：不要把其它节点的漂移清理混进本次操作。
        plan.cleanup = []
        const res = await ctx.engine.applyPlan(plan, null)
        return { ok: res.ok, error: res.error?.message, ops: res.ops.length }
      })
      return { jobId }
    }, { requireSession: true })
}
