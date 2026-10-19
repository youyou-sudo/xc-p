import { Database, type Statement } from 'bun:sqlite'
import { logger } from './log'

export type SqlValue = string | number | bigint | boolean | null | Uint8Array
export type Row = Record<string, any>

/**
 * bun:sqlite 是同步 API。Bun 单线程 + 同步事务已经天然串行，
 * 但控制面里有 await（网络、子进程），所以用一条 Promise 链把「写事务」串起来，
 * 保证 WAL 下不会出现交叉写（PANEL.md R13 / §6 开头）。
 */
export class Db {
  readonly raw: Database
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(file: string, opts: { readonly?: boolean } = {}) {
    this.raw = new Database(file, { create: !opts.readonly, readonly: !!opts.readonly })
    this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA synchronous = NORMAL;')
    this.raw.exec('PRAGMA busy_timeout = 5000;')
    this.raw.exec('PRAGMA foreign_keys = ON;')
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  get<T = Row>(sql: string, params: SqlValue[] | Record<string, SqlValue> = []): T | undefined {
    const stmt = this.prepare(sql)
    return (stmt.get(params as any) as T | undefined) ?? undefined
  }

  all<T = Row>(sql: string, params: SqlValue[] | Record<string, SqlValue> = []): T[] {
    const stmt = this.prepare(sql)
    return stmt.all(params as any) as T[]
  }

  run(sql: string, params: SqlValue[] | Record<string, SqlValue> = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.prepare(sql)
    const r = stmt.run(params as any)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  private prepare(sql: string): Statement {
    return this.raw.query(sql)
  }

  /** 同步事务（IMMEDIATE），异常自动回滚 */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK')
      } catch (re) {
        logger.error('rollback failed', String(re))
      }
      throw e
    }
  }

  /** 异步写事务：进入单写队列（跨 await 也串行） */
  async write<T>(fn: () => T | Promise<T>): Promise<T> {
    const task = this.writeChain.then(async () => {
      this.raw.exec('BEGIN IMMEDIATE')
      try {
        const out = await fn()
        this.raw.exec('COMMIT')
        return out
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK')
        } catch (re) {
          logger.error('rollback failed', String(re))
        }
        throw e
      }
    })
    this.writeChain = task.catch(() => undefined)
    return task
  }

  close(): void {
    try {
      this.raw.close()
    } catch {
      /* ignore */
    }
  }
}
