import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import type { SettingsPatch } from '../../core/settings'
import type { createSessionPlugin } from '../../plugins/session'
import type { SubscriptionsService } from '../subscriptions/service'
import { settingsTestBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 系统设置模块（/api/settings）。PATCH 接受任意部分更新，由 SettingsStore 做深合并与校验。 */
export function settingsModule(ctx: AppContext, session: SessionPlugin, subscriptions: SubscriptionsService) {
  const { settings, events, auth, detector } = ctx
  return new Elysia({ name: 'api/settings', prefix: '/api' })
    .use(session)
    .get('/settings', () => ({ settings: settings.get() }), { requireSession: true })
    .patch('/settings', ({ body }) => {
      const next = settings.update(body as SettingsPatch)
      auth.audit('panel', 'admin', 'settings.update', null, null, body)
      events.info('settings.updated', '系统设置已更新（立即生效）')
      if (ctx.gateway) {
        try {
          ctx.gateway.reconfigure(next.gateway)
          ctx.setGatewayError(null)
          events.info('gateway.reconfigured', '网关已按新配置重建 listener（' + next.gateway.listen + '）')
        } catch (e) {
          const msg = (e as Error).message
          ctx.setGatewayError(msg)
          events.error('gateway.reconfigure_failed', '网关重配置失败：' + msg)
        }
      }
      detector.semaphore.setLimit(next.detect.concurrency)
      subscriptions.setConcurrency(next.subsync.concurrency)
      return { settings: next }
    }, { requireSession: true })
    .post('/settings/test', async ({ body }) => {
      const what = body?.what
      const binary = body?.binary
      const results: any[] = []
      if (!what || what === 'xray') {
        const probe = await ctx.process.probe(binary)
        const lso = await ctx.cli.lso()
        results.push({ id: 'xray.version', label: 'xray 二进制与版本', ok: probe.ok, detail: probe.raw || probe.error || '' })
        results.push({ id: 'xray.api', label: 'Xray API 可达性（lso）', ok: lso.result.ok, detail: lso.result.ok ? '返回 ' + lso.outbounds.length + ' 个 outbound' : lso.result.stderr.slice(0, 200) })
      }
      if (!what || what === 'ports') {
        const bindable = await ctx.ports.probeBindable(8)
        results.push({ id: 'ports.bind', label: '端口池前 8 个端口可 bind', ok: bindable.every((x) => x.ok), detail: bindable.map((x) => x.port + ':' + (x.ok ? 'ok' : 'fail')).join(' ') })
      }
      if (!what || what === 'ipecho') {
        for (const url of settings.get().detect.ipEchoUrls) {
          try {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 6000)
            const res = await fetch(url, { signal: ctrl.signal })
            clearTimeout(timer)
            results.push({ id: 'ipecho.' + url, label: 'IP 查询源 ' + url, ok: res.ok, detail: 'HTTP ' + res.status })
          } catch (e) {
            results.push({ id: 'ipecho.' + url, label: 'IP 查询源 ' + url, ok: false, detail: (e as Error).message })
          }
        }
      }
      return { results }
    }, { body: settingsTestBody, requireSession: true })
}
