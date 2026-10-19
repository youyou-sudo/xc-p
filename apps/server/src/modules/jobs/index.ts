import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { parsePaging } from '../../core/http'
import type { createSessionPlugin } from '../../plugins/session'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 任务模块（/api/jobs）。 */
export function jobsModule(ctx: AppContext, session: SessionPlugin) {
  const { jobs } = ctx
  return new Elysia({ name: 'api/jobs', prefix: '/api' })
    .use(session)
    .get('/jobs', ({ query }) => {
      const q = query
      const p = parsePaging(q)
      const list = jobs.list({ status: q.status, kind: q.kind, limit: p.limit, offset: p.offset })
      return { ...list, items: list.items.map((j) => ({ ...j, result: j.result_json ? JSON.parse(j.result_json) : null })) }
    }, { requireSession: true })
    .get('/jobs/:id', ({ params }) => {
      const job = jobs.get(params.id)
      if (!job) throw new AppError('not_found', '任务不存在', 404)
      return { ...job, result: job.result_json ? JSON.parse(job.result_json) : null }
    }, { requireSession: true })
    .post('/jobs/:id/cancel', ({ params }) => ({ ok: jobs.cancel(params.id) }), { requireSession: true })
}
