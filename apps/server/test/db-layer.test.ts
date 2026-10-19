import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, isNull, sql } from 'drizzle-orm'
import { openDb, type Db } from '../src/core/db'
import { runMigrations, schemaVersion } from '../src/core/migrations'
import { events, nodeStatus, schemaMigrations, sessions, settings, subscriptions } from '../src/core/schema'

const dirs: string[] = []
const opened: Db[] = []
const open = (): Db => {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-db-'))
  dirs.push(dir)
  const db = openDb(join(dir, 't.db'))
  opened.push(db)
  return db
}
const tableNames = (db: Db): string[] =>
  db.all<{ name: string }>(sql.raw(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )).map((r) => r.name)

afterEach(() => {
  // 断言失败时测试体里的 db.close() 不会执行，这里兜底，否则 Windows 上 WAL 文件锁着删不掉
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('迁移', () => {
  test('全新库建出 v1-v3 的全部表，重复执行不再改动', () => {
    // 启动路径每跑一次都要幂等：面板重启、崩溃重启、容器重建都会再跑一遍迁移。
    const db = open()
    expect(runMigrations(db)).toBe(3)
    expect(schemaVersion(db)).toBe(3)
    expect(tableNames(db)).toHaveLength(26)

    expect(runMigrations(db)).toBe(0)
    expect(schemaVersion(db)).toBe(3)
    expect(tableNames(db)).toHaveLength(26)
    db.close()
  })

  test('既有库（v1-v3 已应用）上迁移是空操作，不会重跑 ALTER TABLE', () => {
    // v3 是 ALTER TABLE ADD COLUMN，重跑必然报「duplicate column」。已部署的库靠
    // schema_migrations 记账跳过它——这是存量实例升级不炸的前提。
    const db = open()
    runMigrations(db)
    const before = tableNames(db)
    const colsBefore = db.all(sql.raw("PRAGMA table_info(subscriptions)")).length

    expect(runMigrations(db)).toBe(0)

    expect(tableNames(db)).toEqual(before)
    expect(db.all(sql.raw("PRAGMA table_info(subscriptions)")).length).toBe(colsBefore)
    // v3 的产物必须在
    expect(db.all(sql.raw("PRAGMA table_info(subscriptions)")).map((c: any) => c.name)).toContain('content_text')
    db.close()
  })

  test('schema_migrations 记录 v1-v3 的版本与名字', () => {
    const db = open()
    runMigrations(db)
    const rows = db.select().from(schemaMigrations).all()
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.name)).toEqual(['core-schema', 'applied-nodes', 'subscription-inline-text'])
    db.close()
  })

  test('drizzle 基线 SQL 描述的表与迁移后的库一致（schema 不漂移）', () => {
    // drizzle/0000_*.sql 是 v1-v3 建表结果的基准。它永远不会被执行，只用来算
    // 下一次改表的 diff——一旦 schema.ts 和真实库脱节，后续迁移就会漏列。
    const dir = resolve(import.meta.dir, '..', 'drizzle')
    const baseline = readdirSync(dir).find((f) => f.startsWith('0000') && f.endsWith('.sql'))
    expect(baseline).toBeDefined()
    const declared = new Set(
      [...readFileSync(join(dir, baseline!), 'utf8').matchAll(/CREATE TABLE `([A-Za-z_][A-Za-z_0-9]*)`/g)].map((m) => m[1])
    )
    const db = open()
    runMigrations(db)
    for (const t of tableNames(db)) expect(declared.has(t)).toBe(true)
    expect(declared.size).toBe(tableNames(db).length)
    db.close()
  })
})

describe('查询层', () => {
  test('写操作返回受影响的行数，调用方靠它分支', () => {
    // 同步器/发布器用 changes 判断「这次真的动了吗」，所以必须精确。
    const db = open()
    runMigrations(db)
    db.insert(settings).values({ key: 'a', value_json: '{}', updated_at: 1 }).run()

    expect(db.update(settings).set({ value_json: '{"v":1}' }).where(eq(settings.key, 'a')).run().changes).toBe(1)
    expect(db.update(settings).set({ value_json: '{}' }).where(eq(settings.key, 'nope')).run().changes).toBe(0)
    expect(db.delete(settings).where(eq(settings.key, 'a')).run().changes).toBe(1)
    db.close()
  })

  test('选出来的行保留数据库列名（snake_case），下游映射不用改', () => {
    // 控制器把行映射成 camelCase 的 API 模型；行本身必须还是 snake_case，
    // 否则整个 HTTP 契约会跟着漂移，前端直接坏掉。
    const db = open()
    runMigrations(db)
    db.insert(settings).values({ key: 'k', value_json: '{}', updated_at: 7 }).run()
    const row = db.select().from(settings).where(eq(settings.key, 'k')).get()
    expect(row).toEqual({ key: 'k', value_json: '{}', updated_at: 7 })
    expect(Object.keys(row!).sort()).toEqual(['key', 'updated_at', 'value_json'])
    db.close()
  })

  test('写事务抛错时整体回滚', () => {
    // 一次同步要同时写 run / nodes / 凭据；半截落地会让节点池状态自相矛盾。
    const db = open()
    runMigrations(db)
    expect(() =>
      db.transaction(
        (tx) => {
          tx.insert(events).values({ at: 1, level: 'info', kind: 'test', message: 'before-throw' }).run()
          tx.insert(events).values({ at: 2, level: 'info', kind: 'test', message: 'after-throw' }).run()
          throw new Error('boom')
        },
        { behavior: 'immediate' }
      )
    ).toThrow('boom')
    expect(db.select().from(events).all()).toHaveLength(0)
    db.close()
  })

  test('IMMEDIATE 事务把值原样返回（调用方要拿 run 的结果）', () => {
    const db = open()
    runMigrations(db)
    const out = db.transaction(
      (tx) => {
        const r = tx
          .insert(subscriptions)
          .values({ id: 's1', name: 'S', url: 'u', created_at: 1, updated_at: 1 })
          .run()
        return { changes: r.changes }
      },
      { behavior: 'immediate' }
    )
    expect(out.changes).toBe(1)
    db.close()
  })

  test('isNull 能定位未关闭的会话', () => {
    // 鉴权每次请求都要查「未吊销且未过期」，条件写错等于全站登出。
    const db = open()
    runMigrations(db)
    db.insert(sessions).values({ id: 'a', token_hash: 'h1', created_at: 1, expires_at: 9 }).run()
    db.insert(sessions).values({ id: 'b', token_hash: 'h2', created_at: 1, expires_at: 9, revoked_at: 5 }).run()
    expect(db.select().from(sessions).where(isNull(sessions.revoked_at)).all()).toHaveLength(1)
    db.close()
  })

  test('node_status 的 uptime_24h 有 DEFAULT 0，缺省写入不会得到 null', () => {
    // introspect 曾经漏掉这个默认值；漏了就变成 NOT NULL 违约或静默 null。
    const db = open()
    runMigrations(db)
    db.insert(nodeStatus).values({ node_id: 'n1', updated_at: 1 }).run()
    const row = db.select().from(nodeStatus).where(eq(nodeStatus.node_id, 'n1')).get()
    expect(row!.uptime_24h).toBe(0)
    db.close()
  })
})
