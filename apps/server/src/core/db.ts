import { Database } from 'bun:sqlite'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { schema } from './schema'

/**
 * bun:sqlite 的 write 语句运行时返回 { changes, lastInsertRowid }，但 drizzle 把
 * BunSQLiteDatabase 的 TRunResult 类型参数写成了 void，导致 .run() 在类型上「没有返回值」。
 * 这里按运行时的真实形状补回，openDb 里只有一处类型收口。
 */
export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/**
 * 打开 SQLite 连接。查询层全部走 drizzle 查询构造器（同步驱动，直接返回值，不用 await）；
 * 少数 DDL 场景用 exec()，逃生口用 db.run(sql.raw(...))（注意：只能单条语句）。
 *
 * 事务用 drizzle 自带的 db.transaction(fn, { behavior: 'immediate' })——
 * bun-sqlite 驱动是同步的，IMMEDIATE 语义与原先手写的 BEGIN IMMEDIATE 一致。
 */
export type Db = BaseSQLiteDatabase<'sync', RunResult, typeof schema> & {
  /** 底层连接：用于 PRAGMA、BEGIN/COMMIT 等 drizzle 没覆盖的场景 */
  raw: Database
  /** 执行 DDL / PRAGMA（可多语句，drizzle 的 run() 只执行第一条） */
  exec(sql: string): void
  close(): void
}

export function openDb(file: string, opts: { readonly?: boolean } = {}): Db {
  const raw = new Database(file, { create: !opts.readonly, readonly: !!opts.readonly })
  raw.exec('PRAGMA journal_mode = WAL;')
  raw.exec('PRAGMA synchronous = NORMAL;')
  raw.exec('PRAGMA busy_timeout = 5000;')
  raw.exec('PRAGMA foreign_keys = ON;')

  const db = drizzle({ client: raw, schema }) as unknown as Db
  db.raw = raw
  db.exec = (ddl: string) => {
    raw.exec(ddl)
  }
  db.close = () => {
    try {
      raw.close()
    } catch {
      /* ignore */
    }
  }
  return db
}
