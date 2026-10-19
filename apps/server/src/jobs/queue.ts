import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import { jobId as newJobId } from '../core/ids'
import { logger } from '../core/log'

export type JobKind = 'sync' | 'sync_all' | 'detect' | 'publish' | 'rollback' | 'reconcile' | 'restart'
export type JobStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled'

export interface JobRow {
  id: string
  kind: JobKind
  status: JobStatus
  priority: number
  payload_json: string | null
  progress: number
  total: number
  message: string | null
  started_at: number | null
  finished_at: number | null
  result_json: string | null
  error: string | null
  created_by: string | null
  created_at: number
}

/** 所有数据面写操作共用一个队列（PANEL.md §13：publish/rollback/reconcile/restart 并发 = 1） */
export const APPLY_QUEUE = 'apply'

export class JobQueue {
  private chains = new Map<string, Promise<unknown>>()
  private cancelled = new Set<string>()
  private running = new Set<string>()

  constructor(private db: Db, private events: EventBus) {}

  create(kind: JobKind, payload: unknown, createdBy = 'system', priority = 0): string {
    const id = newJobId(kind)
    this.db.run(
      'INSERT INTO jobs (id, kind, status, priority, payload_json, progress, total, message, created_by, created_at) VALUES (?,?,?,?,?,0,0,NULL,?,?)',
      [id, kind, 'queued', priority, payload === undefined ? null : JSON.stringify(payload), createdBy, Date.now()],
    )
    return id
  }

  get(id: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])
  }

  update(id: string, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'total' | 'message' | 'started_at' | 'finished_at' | 'result_json' | 'error'>>): void {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const sets = keys.map((k) => k + ' = ?').join(', ')
    const values = keys.map((k) => (patch as any)[k])
    this.db.run('UPDATE jobs SET ' + sets + ' WHERE id = ?', [...values, id])
    if (patch.status === 'running' || patch.status === 'ok' || patch.status === 'failed' || patch.progress !== undefined) {
      this.events.emit({
        level: patch.status === 'failed' ? 'error' : 'info',
        kind: 'job.' + (patch.status ?? 'progress'),
        message: '任务 ' + id + (patch.message ? '：' + patch.message : ''),
        detail: { jobId: id, status: patch.status, progress: patch.progress, total: patch.total },
      })
    }
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id)
  }

  cancel(id: string): boolean {
    const job = this.get(id)
    if (!job) return false
    if (job.status === 'queued') {
      this.cancelled.add(id)
      this.update(id, { status: 'cancelled', finished_at: Date.now(), message: '排队中被取消' })
      return true
    }
    if (job.status === 'running') {
      // 发布任务在「第一个数据面写操作成功」之后不可取消（§13）
      this.cancelled.add(id)
      this.update(id, { message: '已请求取消，将在阶段边界生效' })
      return true
    }
    return false
  }

  list(opts: { status?: string; kind?: string; limit?: number; offset?: number } = {}): { items: JobRow[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.status) {
      where.push('status = ?')
      params.push(opts.status)
    }
    if (opts.kind) {
      where.push('kind = ?')
      params.push(opts.kind)
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs' + clause, params)?.n ?? 0
    const items = this.db.all<JobRow>(
      'SELECT * FROM jobs' + clause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [...params, opts.limit ?? 50, opts.offset ?? 0],
    )
    return { items, total }
  }

  /** 进程重启后把 running 的僵尸任务标记为 failed(interrupted)（§13） */
  markZombies(): number {
    const r = this.db.run(
      "UPDATE jobs SET status = 'failed', finished_at = ?, error = 'interrupted' WHERE status IN ('running','queued')",
      [Date.now()],
    )
    if (r.changes > 0) logger.warn('marked ' + r.changes + ' interrupted jobs as failed')
    return r.changes
  }

  /** 串行执行：同一个 group 内的任务排队（group=APPLY_QUEUE 时全局互斥） */
  enqueue<T>(group: string, kind: JobKind, payload: unknown, createdBy: string, task: (jobId: string, ctx: JobContext) => Promise<T>): string {
    const id = this.create(kind, payload, createdBy)
    const prev = this.chains.get(group) ?? Promise.resolve()
    const next = prev.then(async () => {
      const job = this.get(id)!
      if (job.status === 'cancelled') return
      this.running.add(id)
      this.update(id, { status: 'running', started_at: Date.now() })
      const ctx: JobContext = {
        jobId: id,
        setProgress: (progress, total, message) => this.update(id, { progress, total, message }),
        throwIfCancelled: () => {
          if (this.cancelled.has(id)) throw new JobCancelled(id)
        },
        isCancelled: () => this.cancelled.has(id),
      }
      try {
        const result = await task(id, ctx)
        if (this.cancelled.has(id)) {
          this.update(id, { status: 'cancelled', finished_at: Date.now(), result_json: JSON.stringify(result ?? null) })
        } else {
          this.update(id, { status: 'ok', finished_at: Date.now(), result_json: JSON.stringify(result ?? null), progress: 1 })
        }
      } catch (e) {
        if (e instanceof JobCancelled) {
          this.update(id, { status: 'cancelled', finished_at: Date.now(), error: 'cancelled' })
        } else {
          const msg = e instanceof Error ? e.message : String(e)
          this.update(id, { status: 'failed', finished_at: Date.now(), error: msg })
          logger.error('job failed', { id, kind, msg })
        }
      } finally {
        this.running.delete(id)
        this.cancelled.delete(id)
      }
    })
    this.chains.set(
      group,
      next.catch(() => undefined),
    )
    return id
  }
 }

export interface JobContext {
  jobId: string
  setProgress: (progress: number, total: number, message?: string) => void
  throwIfCancelled: () => void
  isCancelled: () => boolean
}

export class JobCancelled extends Error {
  constructor(public jobId: string) {
    super('job cancelled: ' + jobId)
    this.name = 'JobCancelled'
  }
}
