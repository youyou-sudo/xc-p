import { Elysia } from 'elysia'
import { asc, count, desc, eq } from 'drizzle-orm'
import { subscriptionRunErrors, subscriptionRuns, subscriptions, nodeSources } from '../../core/schema'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { parsePaging } from '../../core/http'
import { randomId } from '../../core/ids'
import type { createSessionPlugin } from '../../plugins/session'
import { subscriptionCreateBody, subscriptionPreviewBody, subscriptionUpdateBody } from './model'
import { normalizeFormatHint, resolveIntervalSec, type SubscriptionsService } from './service'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 订阅模块（/api/subscriptions）：控制器只做 HTTP 参数与响应，同步任务交给 service。 */
export function subscriptionsModule(ctx: AppContext, session: SessionPlugin, service: SubscriptionsService) {
  const { db, settings, events, sync, auth } = ctx
  const preview = (text: string, formatHint: string, source: string) => {
    const p = sync.preview(text, normalizeFormatHint(formatHint), source)
    return { ...p, nodes: p.nodes.slice(0, 100), diff: service.previewDiff(p.nodes) }
  }
  return new Elysia({ name: 'api/subscriptions', prefix: '/api' })
    .use(session)
    .get('/subscriptions', () => {
      const rows = db.select().from(subscriptions).orderBy(asc(subscriptions.created_at)).all()
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.url.startsWith('inline://') ? '(内联文本)' : r.url,
          inline: r.url.startsWith('inline://'),
          formatHint: r.format_hint,
          enabled: !!r.enabled,
          intervalSec: r.interval_sec,
          cron: r.cron,
          timeoutMs: r.timeout_ms,
          retries: r.retries,
          userAgent: r.user_agent,
          lastSyncAt: r.last_sync_at,
          lastStatus: r.last_status,
          lastError: r.last_error,
          lastErrorKind: r.last_error_kind,
          consecutiveFailures: r.consecutive_failures,
          nodeCount: db.select({ n: count() }).from(nodeSources).where(eq(nodeSources.subscription_id, r.id)).get()?.n ?? 0,
        })),
      }
    })
    .post(
      '/subscriptions',
      ({ body }) => {
        if (!body.url && !body.text) throw new AppError('validation_failed', 'url 或 text 至少填一个', 422)
        const id = randomId('sub_')
        const now = Date.now()
        const isInline = !body.url
        const url = isInline ? 'inline://' + id : String(body.url)
        const dup = db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.url, url)).get()
        if (dup) throw new AppError('conflict', '该订阅 URL 已存在', 409)
        const s = settings.get().subsync
        db.insert(subscriptions)
          .values({
            id,
            name: body.name,
            url,
            format_hint: normalizeFormatHint(body.formatHint),
            enabled: body.enabled === false ? 0 : 1,
            interval_sec: resolveIntervalSec(body.intervalSec, s.defaultIntervalSec),
            cron: body.cron ?? null,
            timeout_ms: body.timeoutMs ?? s.timeoutMs,
            retries: body.retries ?? s.retries,
            retry_backoff_ms: body.retryBackoffMs ?? s.retryBackoffMs,
            headers_json: body.headers ? JSON.stringify(body.headers) : null,
            user_agent: body.userAgent ?? null,
            content_text: isInline ? String(body.text) : null,
            created_at: now,
            updated_at: now,
          })
          .run()
        auth.audit('panel', 'admin', 'subscription.create', id, null, { name: body.name })
        events.info('subscription.created', '新建订阅「' + body.name + '」', { subscriptionId: id })
        return { id }
      },
      { body: subscriptionCreateBody, requireSession: true },
    )
    .patch(
      '/subscriptions/:id',
      ({ params, body }) => {
        const row = db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.id, params.id)).get()
        if (!row) throw new AppError('not_found', '订阅不存在', 404)
        const patch: Partial<typeof subscriptions.$inferInsert> = {}
        if (body.name !== undefined) patch.name = body.name
        if (body.formatHint !== undefined) patch.format_hint = normalizeFormatHint(String(body.formatHint))
        if (body.intervalSec !== undefined) patch.interval_sec = body.intervalSec
        if (body.cron !== undefined) patch.cron = body.cron
        if (body.timeoutMs !== undefined) patch.timeout_ms = body.timeoutMs
        if (body.retries !== undefined) patch.retries = body.retries
        if (body.userAgent !== undefined) patch.user_agent = body.userAgent
        if (body.url !== undefined) patch.url = body.url
        if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
        if (body.text !== undefined) patch.content_text = String(body.text)
        if (Object.keys(patch).length === 0) return { ok: true }
        patch.updated_at = Date.now()
        db.update(subscriptions).set(patch).where(eq(subscriptions.id, params.id)).run()
        auth.audit('panel', 'admin', 'subscription.update', params.id, null, body)
        return { ok: true }
      },
      { body: subscriptionUpdateBody, requireSession: true },
    )
    .delete('/subscriptions/:id', ({ params }) => {
      db.delete(subscriptions).where(eq(subscriptions.id, params.id)).run()
      db.delete(nodeSources).where(eq(nodeSources.subscription_id, params.id)).run()
      auth.audit('panel', 'admin', 'subscription.delete', params.id, null, null)
      events.warn('subscription.deleted', '已删除订阅 ' + params.id, { subscriptionId: params.id })
      return { ok: true }
    }, { requireSession: true })
    .get('/subscriptions/:id/runs', ({ params, query }) => {
      const p = parsePaging(query)
      const runs = db
        .select()
        .from(subscriptionRuns)
        .where(eq(subscriptionRuns.subscription_id, params.id))
        .orderBy(desc(subscriptionRuns.started_at))
        .limit(p.limit)
        .offset(p.offset)
        .all()
      return {
        items: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          status: r.status,
          httpStatus: r.http_status,
          bytes: r.bytes,
          durationMs: r.duration_ms,
          totalFound: r.total_found,
          added: r.added,
          changed: r.changed,
          removed: r.removed,
          restored: r.restored,
          unsupported: r.unsupported,
          parseErrors: r.parse_errors,
          errorKind: r.error_kind,
          errorMsg: r.error_msg,
          errors: db
            .select({
              line_no: subscriptionRunErrors.line_no,
              raw_snippet: subscriptionRunErrors.raw_snippet,
              error_kind: subscriptionRunErrors.error_kind,
              error_msg: subscriptionRunErrors.error_msg,
            })
            .from(subscriptionRunErrors)
            .where(eq(subscriptionRunErrors.run_id, r.id))
            .limit(20)
            .all(),
        })),
      }
    }, { requireSession: true })
    .post(
      '/subscriptions/preview',
      ({ body }) => preview(body.text, body.formatHint ?? 'auto', 'preview'),
      { body: subscriptionPreviewBody, requireSession: true },
    )
    .post(
      '/subscriptions/:id/test',
      ({ params, body }) => preview(body.text, body.formatHint ?? 'auto', params.id),
      { body: subscriptionPreviewBody, requireSession: true },
    )
    .post('/subscriptions/:id/sync', ({ params }) => {
      return { jobId: service.enqueueSync(params.id, 'manual') }
    }, { requireSession: true })
    .post('/subscriptions/sync-all', () => {
      const subs = sync.listSubscriptions(true)
      const jobId = ctx.jobs.enqueue('sync_all', 'sync_all', { count: subs.length }, 'panel', async (_id, jctx) => {
        jctx.setProgress(0, subs.length, '开始同步全部订阅')
        const results = []
        let i = 0
        for (const s of subs) {
          jctx.throwIfCancelled()
          results.push(await service.semaphore.run(() => sync.runSync(s.id, 'manual')))
          i++
          jctx.setProgress(i, subs.length, '已完成 ' + i + '/' + subs.length)
        }
        if (settings.get().subsync.autoPublishAfterSync) {
          await ctx.publisher.publish({ reason: 'post_sync' })
        }
        return { results }
      })
      return { jobId }
    }, { requireSession: true })
}

// I have nothing but my burger and I want nothing more
