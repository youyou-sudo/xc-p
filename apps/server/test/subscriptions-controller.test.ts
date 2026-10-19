import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/core/db'
import { EventBus } from '../src/core/events'
import { runMigrations } from '../src/core/migrations'
import { SettingsStore } from '../src/core/settings'
import type { AppContext } from '../src/context'
import type { AuthService } from '../src/modules/auth/service'
import { subscriptionsModule } from '../src/modules/subscriptions'
import type { SubscriptionsService } from '../src/modules/subscriptions/service'
import { createSessionPlugin } from '../src/plugins/session'

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
      /* Windows 上 WAL 句柄可能晚一拍释放 */
    }
  }
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-sub-controller-'))
  const db = new Db(join(dir, 'sb.db'))
  resources.push({ dir, db })
  runMigrations(db)
  const settings = new SettingsStore(db)
  const events = new EventBus(db)
  const audits: unknown[] = []
  const auth = {
    session: () => ({ username: 'admin' }),
    audit: (...args: unknown[]) => audits.push(args),
  }
  const ctx = { db, settings, events, auth, sync: {} } as unknown as AppContext
  const app = subscriptionsModule(ctx, createSessionPlugin(auth as unknown as AuthService), {} as SubscriptionsService)
  return { app, db, settings, audits }
}

function post(app: ReturnType<typeof setup>['app'], path: string, payload: unknown) {
  return app.handle(
    new Request('http://localhost/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'xcp_session=test' },
      body: JSON.stringify(payload),
    }),
  )
}

function patch(app: ReturnType<typeof setup>['app'], path: string, payload: unknown) {
  return app.handle(
    new Request('http://localhost/api' + path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'xcp_session=test' },
      body: JSON.stringify(payload),
    }),
  )
}

function intervalOf(db: Db): number | null | undefined {
  return db.get<{ interval_sec: number | null }>('SELECT interval_sec FROM subscriptions ORDER BY created_at DESC LIMIT 1')?.interval_sec
}

describe('POST /api/subscriptions intervalSec wiring', () => {
  /**
   * 面板留空间隔时发送 null；controller 必须把它写成 NULL（手动同步），
   * 而不是用 ?? 换成 defaultIntervalSec。
   */
  test('null is persisted as NULL (manual sync), not the system default', async () => {
    const { app, db, settings } = setup()
    const res = await post(app, '/subscriptions', { name: 'manual', url: 'https://example.com/sub', intervalSec: null })
    expect(res.status).toBe(200)
    expect(intervalOf(db)).toBeNull()
    expect(settings.get().subsync.defaultIntervalSec).toBe(21600)
  })

  test('omitted interval falls back to the system default', async () => {
    const { app, db, settings } = setup()
    const res = await post(app, '/subscriptions', { name: 'default', url: 'https://example.com/sub' })
    expect(res.status).toBe(200)
    expect(intervalOf(db)).toBe(settings.get().subsync.defaultIntervalSec)
  })

  test('numeric interval is persisted as given', async () => {
    const { app, db } = setup()
    const res = await post(app, '/subscriptions', { name: 'hourly', url: 'https://example.com/sub', intervalSec: 3600 })
    expect(res.status).toBe(200)
    expect(intervalOf(db)).toBe(3600)
  })

  test('PATCH null switches an existing subscription back to manual sync', async () => {
    const { app, db } = setup()
    const created = await post(app, '/subscriptions', { name: 'hourly', url: 'https://example.com/sub', intervalSec: 3600 })
    const { id } = (await created.json()) as { id: string }
    expect(intervalOf(db)).toBe(3600)

    const updated = await patch(app, '/subscriptions/' + id, { intervalSec: null })
    expect(updated.status).toBe(200)
    expect(intervalOf(db)).toBeNull()
  })
})
