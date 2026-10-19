import { Elysia } from 'elysia'
import { and, count, eq } from 'drizzle-orm'
import type { AppContext } from '../../context'
import { nodes as nodesT } from '../../core/schema'
import { hasScope } from '../auth/service'
import { decryptSecret } from '../../core/crypto'
import { AppError } from '../../core/errors'
import { parsePaging } from '../../core/http'
import { APPLY_QUEUE } from '../../jobs/queue'
import { buildDesiredNodes } from '../../publish/desired'
import { connectionStrings, listNodes } from '../nodes/service'
import type { SubscriptionsService } from '../subscriptions/service'
import { v1DetectBody, v1SyncBody } from './model'
import { createV1Auth, forbiddenResponse } from './service'

/** 服务 API（/v1，API Key + scope，无 Cookie 会话）。 */
export function v1Module(ctx: AppContext, subscriptions: SubscriptionsService) {
  const { db, settings, jobs, sync, auth, detector, publisher, reconciler, ports } = ctx
  const v1Auth = createV1Auth(ctx)
  return new Elysia({ name: 'api/v1', prefix: '/v1' })
    .get('/health', ({ request }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      return { status: 'ok', at: Date.now() }
    })
    .get('/gateway', ({ request }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'read')) return forbiddenResponse('read')
      const gw = ctx.gatewayInfo()
      const nodeCount =
        db
          .select({ n: count() })
          .from(nodesT)
          .where(and(eq(nodesT.enabled, 1), eq(nodesT.protocol_supported, 1)))
          .get()?.n ?? 0
      return {
        host: settings.get().panel.baseUrl || 'xc-p',
        port: gw.port,
        listen: settings.get().gateway.listen,
        authMode: settings.get().gateway.authMode,
        enabled: gw.enabled,
        availableNodes: nodeCount,
        directMode: settings.get().direct,
      }
    })
    .get('/nodes', ({ request, query }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'read')) return forbiddenResponse('read')
      const q = query as Record<string, string | undefined>
      const p = parsePaging(q)
      return listNodes(ctx, q, p.limit, p.offset, false)
    })
    .get('/nodes/:id/endpoint', ({ request, params }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'read') || !hasScope(a.principal!, 'credentials')) return forbiddenResponse('read+credentials')
      const cred = sync.credentialOf(params.id)
      if (!cred) throw new AppError('not_found', '节点不存在或没有凭据', 404)
      const gw = ctx.gatewayInfo()
      const host = settings.get().panel.baseUrl || 'xc-p'
      return { nodeId: params.id, username: cred.username, password: cred.password, ...connectionStrings(cred.username, cred.password, host, gw.port) }
    })
    .get('/endpoints', ({ request, query }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'read') || !hasScope(a.principal!, 'credentials')) return forbiddenResponse('read+credentials')
      const q = query as Record<string, string | undefined>
      const gw = ctx.gatewayInfo()
      const host = settings.get().panel.baseUrl || 'xc-p'
      let rows = db.all<any>(
        'SELECT n.id, n.display_name, n.country_code, c.username, c.password_enc FROM nodes n JOIN node_credentials c ON c.node_id = n.id WHERE n.enabled = 1 ORDER BY n.id',
      )
      if (q.country) rows = rows.filter((r) => (r.country_code ?? '').toUpperCase() === q.country!.toUpperCase())
      if (q.group) rows = rows.filter((r) => (r.display_name ?? '').includes(q.group!))
      const limit = Math.min(Number.parseInt(q.limit ?? '100', 10) || 100, 1000)
      rows = rows.slice(0, limit)
      const items = rows.map((r) => {
        const password = decryptSecret(r.password_enc)
        const cs = connectionStrings(r.username, password, host, gw.port)
        if (q.format === 'env') return { nodeId: r.id, env: cs.env }
        if (q.format === 'curl') return { nodeId: r.id, curl: cs.curl }
        return { nodeId: r.id, name: r.display_name, country: r.country_code, username: r.username, password, http: cs.http, socks5: cs.socks5 }
      })
      if (q.format === 'env') {
        return { items, text: items.map((i: any) => i.env).join('\n') }
      }
      return { items }
    })
    .post(
      '/subscriptions/sync',
      ({ request, body }) => {
        const a = v1Auth(request)
        if (a.error) return a.error
        if (!hasScope(a.principal!, 'sync:run')) return forbiddenResponse('sync:run')
        if (body.subscriptionId) {
          const jobId = subscriptions.enqueueSync(body.subscriptionId, 'api')
          auth.audit('apikey', a.principal!.name, 'v1.sync', body.subscriptionId, null, null)
          return { jobId }
        }
        const subs = sync.listSubscriptions(true)
        const jobId = jobs.enqueue('sync_all', 'sync_all', {}, 'apikey:' + a.principal!.name, async (_id, jctx) => {
          const results = []
          let i = 0
          for (const s of subs) {
            jctx.throwIfCancelled()
            results.push(await subscriptions.semaphore.run(() => sync.runSync(s.id, 'api')))
            i++
            jctx.setProgress(i, subs.length)
          }
          return { results }
        })
        auth.audit('apikey', a.principal!.name, 'v1.sync_all', null, null, { count: subs.length })
        return { jobId }
      },
      { body: v1SyncBody },
    )
    .post(
      '/detect/run',
      ({ request, body }) => {
        const a = v1Auth(request)
        if (a.error) return a.error
        if (!hasScope(a.principal!, 'detect:run')) return forbiddenResponse('detect:run')
        const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds : undefined
        const jobId = jobs.enqueue('detect', 'detect', { nodeIds: nodeIds ?? 'all' }, 'apikey:' + a.principal!.name, async (_id, jctx) => {
          const targets = detector.loadTargets(nodeIds, true)
          jctx.setProgress(0, targets.length)
          const results = await detector.run(targets, { source: 'apikey', depth: body.depth === 'lite' ? 'lite' : 'full', onProgress: (d, t) => jctx.setProgress(d, t) })
          return { count: results.length, ok: results.filter((r) => r.ok).length }
        })
        auth.audit('apikey', a.principal!.name, 'v1.detect', null, null, { nodeIds: nodeIds ?? 'all' })
        return { jobId }
      },
      { body: v1DetectBody },
    )
    .post('/runtime/publish', ({ request }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'publish:run')) return forbiddenResponse('publish:run')
      const jobId = jobs.enqueue(APPLY_QUEUE, 'publish', {}, 'apikey:' + a.principal!.name, async () => {
        const r = await publisher.publish({ reason: 'api' })
        auth.audit('apikey', a.principal!.name, 'v1.publish', r.revisionId, null, r.summary)
        return { ok: r.ok, revisionId: r.revisionId, summary: r.summary, error: r.error }
      })
      return { jobId }
    })
    .post('/runtime/reconcile', ({ request }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'publish:run')) return forbiddenResponse('publish:run')
      const jobId = jobs.enqueue(APPLY_QUEUE, 'reconcile', {}, 'apikey:' + a.principal!.name, async () => {
        const snap = buildDesiredNodes(db, settings, ports)
        const r = await reconciler.reconcile(snap.desired, publisher.appliedNodes(), { apply: true })
        return { consistent: r.consistent, drift: r.drift }
      })
      return { jobId }
    })
    .get('/jobs/:id', ({ request, params }) => {
      const a = v1Auth(request)
      if (a.error) return a.error
      if (!hasScope(a.principal!, 'read')) return forbiddenResponse('read')
      const job = jobs.get(params.id)
      if (!job) throw new AppError('not_found', '任务不存在', 404)
      return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: job.progress,
        total: job.total,
        message: job.message,
        error: job.error,
        result: job.result_json ? JSON.parse(job.result_json) : null,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
      }
    })
}