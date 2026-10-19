import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb, type Db } from '../src/core/db'
import { pendingRetire } from '../src/core/schema'
import { EventBus } from '../src/core/events'
import { runMigrations } from '../src/core/migrations'
import { SettingsStore } from '../src/core/settings'
import { RetireQueue } from '../src/xray/retire'

const resources: { dir: string; db: Db }[] = []
afterEach(() => {
  for (const item of resources.splice(0)) {
    try {
      item.db.raw.close()
    } catch {
      /* already closed */
    }
    try {
      rmSync(item.dir, { recursive: true, force: true })
    } catch {
      /* Windows 上 WAL 句柄可能晚一拍释放；临时目录留给系统清理即可 */
    }
  }
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-retire-'))
  const db = openDb(join(dir, 'sb.db'))
  resources.push({ dir, db })
  runMigrations(db)
  const settings = new SettingsStore(db)
  settings.update({ xray: { retireDelayMs: 0 } })
  const events = new EventBus(db)
  return { db, settings, events }
}

function fakeCli(state: { ok: boolean; stderr?: string }) {
  const calls: string[] = []
  const result = () => ({
    ok: state.ok,
    code: state.ok ? 0 : 1,
    stdout: '',
    stderr: state.stderr ?? '',
    durationMs: 1,
  })
  return {
    calls,
    rmo: async (tags: string[]) => {
      calls.push('rmo:' + tags.join(','))
      return result()
    },
    rmi: async (tags: string[]) => {
      calls.push('rmi:' + tags.join(','))
      return result()
    },
    rmrules: async (tags: string[]) => {
      calls.push('rmrules:' + tags.join(','))
      return result()
    },
  }
}

describe('RetireQueue 延迟退休', () => {
  test('失败不标完成，60 秒后重试，成功后清理', async () => {
    const { db, settings, events } = setup()
    const state = { ok: false, stderr: 'connection refused' }
    const cli = fakeCli(state)
    const retire = new RetireQueue(db, cli as any, settings, events)

    retire.enqueue([{ kind: 'outbound', tag: 'out-a', nodeId: 'n1', revisionId: null }])
    // 重复入队应该被去重
    retire.enqueue([{ kind: 'outbound', tag: 'out-a', nodeId: 'n1', revisionId: null }])
    expect(db.select().from(pendingRetire).all().length).toBe(1)
    expect(retire.pendingTags().has('out-a')).toBe(true)

    const now = Date.now()
    const done1 = await retire.processDue(now + 1_000)
    expect(done1).toBe(0)
    const row1 = db
      .select({ done_at: pendingRetire.done_at, error: pendingRetire.error, retire_after: pendingRetire.retire_after })
      .from(pendingRetire)
      .where(eq(pendingRetire.tag, 'out-a'))
      .get()!
    expect(row1.done_at).toBeNull()
    expect(String(row1.error)).toContain('connection refused')
    expect(row1.retire_after).toBeGreaterThan(now)
    expect(retire.pendingTags().has('out-a')).toBe(true)

    state.ok = true
    state.stderr = ''
    const done2 = await retire.processDue(now + 120_000)
    expect(done2).toBe(1)
    const row2 = db.select({ done_at: pendingRetire.done_at }).from(pendingRetire).where(eq(pendingRetire.tag, 'out-a')).get()!
    expect(row2.done_at).not.toBeNull()
    expect(retire.pendingTags().size).toBe(0)
  })

  test('tag 已不存在（not found）按幂等成功处理', async () => {
    const { db, settings, events } = setup()
    const cli = fakeCli({ ok: false, stderr: 'outbound out-gone not found' })
    const retire = new RetireQueue(db, cli as any, settings, events)
    retire.enqueue([{ kind: 'outbound', tag: 'out-gone' }])
    const done = await retire.processDue(Date.now() + 1_000)
    expect(done).toBe(1)
    expect(retire.pendingTags().size).toBe(0)
  })
})
