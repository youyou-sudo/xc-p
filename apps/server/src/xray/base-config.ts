import type { Settings } from '../core/settings'

export interface BaseConfigCredential { username: string; password: string }

/**
 * DATA_DIR/runtime/base/xray.json —— 只包含不可变骨架（PANEL.md §9.4 / 附录 A）。
 * **节点全部不在这个文件里**，由控制面运行期通过 API 追加。
 */
export function renderBaseConfig(settings: Settings, directCredentials: BaseConfigCredential[] = []): Record<string, unknown> {
  const apiPort = portOf(settings.xray.apiAddress)

  const inbounds: Record<string, unknown>[] = [
    {
      tag: 'api-in',
      listen: '127.0.0.1',
      port: apiPort,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    },
  ]

  const outbounds: Record<string, unknown>[] = [{ tag: 'out-direct', protocol: 'freedom' }]
  const rules: Record<string, unknown>[] = [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }]

  if (settings.direct.enabled) {
    // 附录 A 注：HTTP / SOCKS 的 accounts 都是**数组**
    inbounds.push({
      tag: 'in-direct',
      listen: hostOf(settings.direct.listen),
      port: portOf(settings.direct.listen),
      protocol: 'http',
      settings: { accounts: directCredentials.map((c) => ({ user: c.username, pass: c.password })) },
    })
    inbounds.push({
      tag: 'in-direct-socks',
      listen: hostOf(settings.direct.socksListen),
      port: portOf(settings.direct.socksListen),
      protocol: 'socks',
      settings: {
        auth: 'password',
        accounts: directCredentials.map((c) => ({ user: c.username, pass: c.password })),
        udp: false,
      },
    })
  }

  return {
    log: { loglevel: settings.xray.logLevel },
    api: { tag: 'api', services: ['HandlerService', 'RoutingService', 'StatsService'] },
    metrics: { tag: 'metrics', listen: settings.xray.metricsListen },
    stats: {},
    policy: {
      levels: { '0': { handshake: 4, connIdle: settings.gateway.idleTimeoutSec } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds,
    outbounds,
    routing: { rules },
  }
}

export function hostOf(addr: string): string {
  const idx = addr.lastIndexOf(':')
  return idx < 0 ? '0.0.0.0' : addr.slice(0, idx)
}

export function portOf(addr: string): number {
  const idx = addr.lastIndexOf(':')
  const p = Number.parseInt(idx < 0 ? addr : addr.slice(idx + 1), 10)
  return Number.isFinite(p) ? p : 0
}
