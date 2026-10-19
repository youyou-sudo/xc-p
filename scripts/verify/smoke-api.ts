/** 面板 API 冒烟：逐个打 §11.1 / §11.2 的端点，报告状态码。 */
import { makeApi, startPanel, waitJob } from './harness'

const panel = await startPanel()
const api = makeApi(panel)
const rows: string[] = []
async function hit(method: string, path: string, body?: unknown) {
  const r = await api.raw(method, path, body)
  const flag = r.status >= 500 ? ' ERR ' : r.status >= 400 ? ' warn' : '  ok '
  rows.push(flag + ' ' + method.padEnd(6) + path.padEnd(46) + ' → ' + r.status + (r.status >= 500 ? ' ' + JSON.stringify(r.body).slice(0, 160) : ''))
}

try {
  await hit('GET', '/api/auth/me')
  await hit('GET', '/api/subscriptions')
  await hit('POST', '/api/subscriptions', { name: 'smoke', text: 'http://u:p@127.0.0.1:1#HK-01' })
  const subs = await api.get('/api/subscriptions')
  const sid = subs.items[0]?.id
  await hit('GET', '/api/subscriptions/' + sid + '/runs')
  await hit('POST', '/api/subscriptions/preview', { text: 'http://u:p@127.0.0.1:1#HK-01' })
  await hit('PATCH', '/api/subscriptions/' + sid, { enabled: true })
  const syncRes = await api.post('/api/subscriptions/' + sid + '/sync')
  if (syncRes.jobId) await waitJob(api, syncRes.jobId, 30000)
  await hit('GET', '/api/nodes')
  const nodes = await api.get('/api/nodes')
  const nid = nodes.items[0]?.id ?? 'nope'
  await hit('GET', '/api/nodes/' + nid + '/checks')
  await hit('GET', '/api/nodes/' + nid + '/connection')
  await hit('PATCH', '/api/nodes/' + nid, { displayName: 'smoke' })
  await hit('GET', '/api/settings')
  await hit('PATCH', '/api/settings', { detect: { concurrency: 4 } })
  await hit('POST', '/api/settings/test', { what: 'ports' })
  await hit('GET', '/api/runtime/status')
  await hit('GET', '/api/runtime/revisions')
  const dry = await api.post('/api/runtime/publish', { dryRun: true })
  if (dry.jobId) {
    const j = await waitJob(api, dry.jobId, 60000)
    rows.push('  ok  POST   /api/runtime/publish?dryRun=1          → job ' + j.status)
  }
  await hit('POST', '/api/runtime/reconcile', { dryRun: true })
  const rec = await api.post('/api/runtime/reconcile', { dryRun: true })
  if (rec.jobId) await waitJob(api, rec.jobId, 60000)
  await hit('GET', '/api/keys')
  const key = await api.post('/api/keys', { name: 'smoke', scopes: ['read'] })
  await hit('DELETE', '/api/keys/' + key.id)
  await hit('GET', '/api/jobs')
  await hit('GET', '/api/events')
  await hit('GET', '/api/apply-ops')
  await hit('GET', '/api/gateway/connections')
  await hit('POST', '/api/gateway/kick', { ip: '127.0.0.1' })
  await hit('GET', '/api/metrics')
  await hit('GET', '/api/health')
  await hit('GET', '/api/nodes/check-batch')
  const batch = await api.post('/api/nodes/check-batch', { nodeIds: [nid], depth: 'lite' })
  if (batch.jobId) await waitJob(api, batch.jobId, 30000)
  await hit('GET', '/') // 静态面板

  // v1
  const k2 = await api.post('/api/keys', { name: 'smoke2', scopes: ['read', 'credentials', 'sync:run', 'detect:run', 'publish:run'] })
  const v1 = makeApi(panel, { bearer: k2.plaintext })
  const v1rows: string[] = []
  for (const [m, p, b] of [
    ['GET', '/v1/health', undefined],
    ['GET', '/v1/gateway', undefined],
    ['GET', '/v1/nodes', undefined],
    ['GET', '/v1/nodes/' + nid + '/endpoint', undefined],
    ['GET', '/v1/endpoints', undefined],
    ['POST', '/v1/subscriptions/sync', { subscriptionId: sid }],
    ['POST', '/v1/detect/run', { nodeIds: [nid], depth: 'lite' }],
  ] as [string, string, unknown][]) {
    const r = await v1.raw(m, p, b)
    v1rows.push((r.status >= 500 ? ' ERR ' : r.status >= 400 ? ' warn' : '  ok ') + ' ' + m.padEnd(6) + p.padEnd(40) + ' → ' + r.status + (r.status >= 400 ? ' ' + JSON.stringify(r.body).slice(0, 120) : ''))
  }
  console.log(rows.join('\n'))
  console.log('')
  console.log(v1rows.join('\n'))
  const errs = [...rows, ...v1rows].filter((r) => r.startsWith(' ERR') || r.startsWith(' warn'))
  console.log('')
  console.log('异常端点 ' + errs.length + ' 个')
} finally {
  await panel.stop()
}
process.exit(0)
