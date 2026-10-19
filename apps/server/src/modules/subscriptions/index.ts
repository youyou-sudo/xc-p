import { Elysia } from 'elysia'
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
      const rows = db.all<any>('SELECT * FROM subscriptions ORDER BY created_at ASC')
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
          nodeCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM node_sources WHERE subscription_id = ?', [r.id])?.n ?? 0,
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
        const dup = db.get('SELECT id FROM subscriptions WHERE url = ?', [url])
        if (dup) throw new AppError('conflict', '该订阅 URL 已存在', 409)
        const s = settings.get().subsync
        db.run(
          'INSERT INTO subscriptions (id, name, url, format_hint, enabled, interval_sec, cron, timeout_ms, retries, retry_backoff_ms, headers_json, user_agent, content_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            id,
            body.name,
            url,
            normalizeFormatHint(body.formatHint),
            body.enabled === false ? 0 : 1,
            resolveIntervalSec(body.intervalSec, s.defaultIntervalSec),
            body.cron ?? null,
            body.timeoutMs ?? s.timeoutMs,
            body.retries ?? s.retries,
            body.retryBackoffMs ?? s.retryBackoffMs,
            body.headers ? JSON.stringify(body.headers) : null,
            body.userAgent ?? null,
            isInline ? String(body.text) : null,
            now,
            now,
          ],
        )
        auth.audit('panel', 'admin', 'subscription.create', id, null, { name: body.name })
        events.info('subscription.created', '新建订阅「' + body.name + '」', { subscriptionId: id })
        return { id }
      },
      { body: subscriptionCreateBody, requireSession: true },
    )
    .patch(
      '/subscriptions/:id',
      ({ params, body }) => {
        const row = db.get<any>('SELECT * FROM subscriptions WHERE id = ?', [params.id])
        if (!row) throw new AppError('not_found', '订阅不存在', 404)
        const map: Record<string, string> = {
          name: 'name',
          formatHint: 'format_hint',
          intervalSec: 'interval_sec',
          cron: 'cron',
          timeoutMs: 'timeout_ms',
          retries: 'retries',
          userAgent: 'user_agent',
          url: 'url',
        }
        // 动态列映射需要按字符串索引；模型仍负责校验，运行时行为不变。
        const patch: Record<string, unknown> = { ...body }
        const sets: string[] = []
        const values: any[] = []
        for (const [k, col] of Object.entries(map)) {
          if (patch[k] !== undefined) {
            sets.push(col + ' = ?')
            values.push(k === 'formatHint' ? normalizeFormatHint(String(patch[k])) : patch[k])
          }
        }
        if (body.enabled !== undefined) {
          sets.push('enabled = ?')
          values.push(body.enabled ? 1 : 0)
        }
        if (body.text !== undefined) {
          sets.push('content_text = ?')
          values.push(String(body.text))
        }
        if (sets.length === 0) return { ok: true }
        sets.push('updated_at = ?')
        values.push(Date.now(), params.id)
        db.run('UPDATE subscriptions SET ' + sets.join(', ') + ' WHERE id = ?', values)
        auth.audit('panel', 'admin', 'subscription.update', params.id, null, body)
        return { ok: true }
      },
      { body: subscriptionUpdateBody, requireSession: true },
    )
    .delete('/subscriptions/:id', ({ params }) => {
      db.run('DELETE FROM subscriptions WHERE id = ?', [params.id])
      db.run('DELETE FROM node_sources WHERE subscription_id = ?', [params.id])
      auth.audit('panel', 'admin', 'subscription.delete', params.id, null, null)
      events.warn('subscription.deleted', '已删除订阅 ' + params.id, { subscriptionId: params.id })
      return { ok: true }
    }, { requireSession: true })
    .get('/subscriptions/:id/runs', ({ params, query }) => {
      const p = parsePaging(query)
      const runs = db.all<any>(
        'SELECT * FROM subscription_runs WHERE subscription_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
        [params.id, p.limit, p.offset],
      )
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
          errors: db.all('SELECT line_no, raw_snippet, error_kind, error_msg FROM subscription_run_errors WHERE run_id = ? LIMIT 20', [r.id]),
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
