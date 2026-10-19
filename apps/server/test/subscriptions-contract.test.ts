import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { subscriptionCreateBody, subscriptionUpdateBody } from '../src/modules/subscriptions/model'
import { normalizeFormatHint, resolveIntervalSec } from '../src/modules/subscriptions/service'

const app = new Elysia()
  .post('/create', ({ body }) => body, { body: subscriptionCreateBody })
  .post('/update', ({ body }) => body, { body: subscriptionUpdateBody })

function post(path: '/create' | '/update', payload: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

describe('subscription intervalSec wire contract', () => {
  /**
   * 面板用 null 表示「手动同步」；它必须被接受且原样保留，
   * 否则「留空间隔」会被 422，或者被 ?? 默认值悄悄改成定时同步。
   */
  test('create accepts null and keeps it as null', async () => {
    const res = await post('/create', { name: 'manual', intervalSec: null })
    expect(res.status).toBe(200)
    expect((await res.json()) as { name: string; intervalSec: number | null }).toEqual({ name: 'manual', intervalSec: null })
  })

  test('patch accepts null and keeps it as null', async () => {
    const res = await post('/update', { intervalSec: null })
    expect(res.status).toBe(200)
    expect((await res.json()) as { intervalSec: number | null }).toEqual({ intervalSec: null })
  })

  test('omitted interval stays omitted so the caller can apply the system default', async () => {
    const res = await post('/create', { name: 'default' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'default' })
  })

  test('numeric interval is preserved', async () => {
    const res = await post('/create', { name: 'scheduled', intervalSec: 3600 })
    expect(res.status).toBe(200)
    expect((await res.json()) as { name: string; intervalSec: number }).toEqual({ name: 'scheduled', intervalSec: 3600 })
  })

  test('non-numeric non-null interval is still rejected', async () => {
    const res = await post('/create', { name: 'bad', intervalSec: '3600' })
    expect(res.status).toBe(422)
  })
})

describe('subscription payload normalization', () => {
  test('null means manual sync, undefined means system default', () => {
    expect(resolveIntervalSec(null, 21600)).toBeNull()
    expect(resolveIntervalSec(undefined, 21600)).toBe(21600)
    expect(resolveIntervalSec(60, 21600)).toBe(60)
  })

  test('unknown format hint falls back to auto instead of reaching the parser', () => {
    expect(normalizeFormatHint(undefined)).toBe('auto')
    expect(normalizeFormatHint('clash')).toBe('clash')
    expect(normalizeFormatHint('json_array')).toBe('auto')
  })
})
