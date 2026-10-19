import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { parsePaging, requestId } from '../../core/http'
import { sessionOf, type createSessionPlugin } from '../../plugins/session'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 事件 / 审计 / 应用操作模块（/api/events、/api/audit、/api/apply-ops、/api/stream）。 */
export function eventsModule(ctx: AppContext, session: SessionPlugin) {
  const { db, events, conns, auth } = ctx
  const listApplyOps = (limit: number, offset: number) => ({
    items: db.all<any>('SELECT * FROM xray_apply_ops ORDER BY at DESC LIMIT ? OFFSET ?', [limit, offset]),
  })
  return new Elysia({ name: 'api/events', prefix: '/api' })
    .use(session)
    .get('/events', ({ query }) => {
      const q = query
      const p = parsePaging(q)
      const where: string[] = []
      const params: any[] = []
      if (q.level) {
        where.push('level = ?')
        params.push(q.level)
      }
      if (q.kind) {
        where.push('kind LIKE ?')
        params.push(q.kind + '%')
      }
      if (q.nodeId) {
        where.push('node_id = ?')
        params.push(q.nodeId)
      }
      const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
      const items = db.all<any>('SELECT * FROM events' + clause + ' ORDER BY at DESC LIMIT ? OFFSET ?', [...params, p.limit, p.offset])
      return { items: items.map((e) => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null })) }
    }, { requireSession: true })
    /** 审计明细（/events 页的「xray_apply_ops 审计」标签页）；kind=xray_apply_ops 时等价于 /api/apply-ops */
    .get('/audit', ({ query }) => {
      const q = query
      const p = parsePaging(q)
      if (q.kind === 'xray_apply_ops') return listApplyOps(p.limit, p.offset)
      const items = db.all<any>('SELECT * FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?', [p.limit, p.offset])
      return { items: items.map((a) => ({ ...a, detail: a.detail_json ? JSON.parse(a.detail_json) : null })) }
    }, { requireSession: true })
    .get('/apply-ops', ({ query }) => {
      const p = parsePaging(query)
      return listApplyOps(p.limit, p.offset)
    }, { requireSession: true })
    // SSE：未登录时返回 401 JSON（不能用 macro，因为这里要返回自定义 Response）
    .get('/stream', ({ cookie, request }) => {
      if (!sessionOf(auth, cookie as Record<string, { value?: unknown } | undefined>)) {
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: '未登录' } }), { status: 401 })
      }
      const encoder = new TextEncoder()
      let unsubscribe: (() => void) | null = null
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'))
            } catch {
              /* 客户端已断开 */
            }
          }
          send('hello', { at: Date.now(), gateway: conns.count() })
          unsubscribe = events.subscribe((e) => send('event', e))
          const timer = setInterval(() => send('gateway', { activeConns: conns.count(), byNode: conns.byNode() }), 5000)
          request.signal.addEventListener('abort', () => {
            clearInterval(timer)
            unsubscribe?.()
            try {
              controller.close()
            } catch {
              /* ignore */
            }
          })
        },
        cancel() {
          unsubscribe?.()
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': requestId() },
      })
    })
}
