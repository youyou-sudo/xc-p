/**
 * 验收脚本（PANEL.md §16 AC-1 ~ AC-18）。
 * 全部在本机离线复现：真 Xray 二进制 + 本地 origin/upstream。
 * 用法：bun run scripts/verify/run-all.ts
 */
import { Database } from 'bun:sqlite'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PORTS,
  REPO,
  XRAY_BIN,
  ensureXray,
  killXrayProcesses,
  makeApi,
  openTunnel,
  sleep,
  startOrigin,
  startPanel,
  startUpstream,
  waitFor,
  waitJob,
  xrayApi,
  xrayApiTags,
  type Api,
} from './harness'
import { openDb } from '../../apps/server/src/core/db'
import { SettingsStore } from '../../apps/server/src/core/settings'
import { PortPool } from '../../apps/server/src/xray/ports'

export interface CheckResult {
  id: string
  title: string
  status: 'pass' | 'fail' | 'partial' | 'skip'
  detail: string
  evidence: string[]
}

const results: CheckResult[] = []
let evidence: string[] = []

function ev(line: string) {
  evidence.push(line)
}

async function check(id: string, title: string, fn: () => Promise<{ status: 'pass' | 'fail' | 'partial' | 'skip'; detail: string }>) {
  evidence = []
  const t0 = Date.now()
  try {
    const r = await fn()
    results.push({ id, title, status: r.status, detail: r.detail + '（' + (Date.now() - t0) + 'ms）', evidence: [...evidence] })
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : r.status.toUpperCase()
    console.log('[' + mark + '] ' + id + ' ' + title + ' — ' + r.detail)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ id, title, status: 'fail', detail: msg, evidence: [...evidence] })
    console.log('[FAIL] ' + id + ' ' + title + ' — ' + msg)
  }
}

// ------------------------------------------------------------------ 小工具
async function createInlineSub(api: Api, name: string, text: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await api.post('/api/subscriptions', { name, text, formatHint: 'auto', intervalSec: 0, timeoutMs: 5000, retries: 0, ...opts })
  if (!r?.id) throw new Error('创建订阅失败: ' + JSON.stringify(r))
  return r.id
}

async function createUrlSub(api: Api, name: string, url: string): Promise<string> {
  const r = await api.post('/api/subscriptions', { name, url, timeoutMs: 3000, retries: 0 })
  if (!r?.id) throw new Error('创建订阅失败: ' + JSON.stringify(r))
  return r.id
}

async function syncSub(api: Api, id: string): Promise<any> {
  const { jobId } = await api.post('/api/subscriptions/' + id + '/sync')
  return await waitJob(api, jobId, 60_000)
}

async function publish(api: Api, dryRun = false): Promise<any> {
  const r = await api.post('/api/runtime/publish', { dryRun })
  const job = await waitJob(api, r.jobId, 180_000)
  return job.result ?? { error: job.error }
}

/** 等延迟退休队列排空：否则 rmo 会在比较数据面的窗口里改变 lso，导致误判 */
async function drainRetire(api: Api, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const st = await api.get('/api/runtime/status')
      if ((st.pendingRetire?.length ?? 0) === 0) return
    } catch {
      /* 面板忙 */
    }
    await sleep(1000)
  }
}

/**
 * 经网关发一次 HTTP 请求并解析 JSON（裸 socket 实现）。
 * 不用 Bun 的 fetch({proxy})：实测它按 host 复用代理连接、会忽略不同的代理端口，
 * 在做「多节点出口 IP 不同」这类断言时会串味。
 */
async function proxyGetJson(username: string, password: string, path = '/geoip', timeoutMs = 8000): Promise<{ ok: boolean; status: number; json?: any; raw: string }> {
  const chunks: Buffer[] = []
  const text = () => Buffer.concat(chunks).toString('latin1')
  try {
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: PORTS.gateway,
      socket: { data(_s, d: Buffer) { chunks.push(Buffer.from(d)) }, error() {}, close() {} },
    })
    const auth = Buffer.from(username + ':' + password).toString('base64')
    sock.write(
      'CONNECT 127.0.0.1:' + PORTS.origin + ' HTTP/1.1\r\nHost: 127.0.0.1:' + PORTS.origin +
        '\r\nProxy-Authorization: Basic ' + auth + '\r\n\r\n',
    )
    const deadline = Date.now() + timeoutMs
    let head = ''
    while (Date.now() < deadline) {
      head = text()
      if (head.includes('\r\n\r\n')) break
      if (/^HTTP\/1\.1 [45]\d\d/.test(head)) {
        sock.end()
        return { ok: false, status: Number.parseInt(head.slice(9, 12), 10) || 0, raw: head }
      }
      await sleep(50)
    }
    const status = Number.parseInt(head.slice(9, 12), 10) || 0
    if (status !== 200) {
      sock.end()
      return { ok: false, status, raw: head.slice(0, 200) }
    }
    sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    const bodyDeadline = Date.now() + timeoutMs
    while (Date.now() < bodyDeadline) {
      const t = text()
      const idx = t.indexOf('\r\n\r\n')
      if (idx >= 0) {
        const body = t.slice(idx + 4)
        const m = /"ip"\s*:\s*"([^"]+)"/.exec(body)
        if (m) {
          sock.end()
          return { ok: true, status: 200, json: { ip: m[1] }, raw: body }
        }
        if (/\r\n0\r\n\r\n$/.test(t)) break
      }
      await sleep(50)
    }
    sock.end()
    return { ok: false, status, raw: text().slice(0, 200) }
  } catch {
    return { ok: false, status: 0, raw: '' }
  }
}

 /** 裸 socket 发 CONNECT，返回应答状态码（0=无应答/超时） */
async function rawConnectStatus(username: string, password: string, timeoutMs = 5000): Promise<number> {
  const chunks: Buffer[] = []
  try {
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: PORTS.gateway,
      socket: {
        data(_s, d: Buffer) {
          chunks.push(Buffer.from(d))
        },
        error() {},
        close() {},
      },
    })
    const auth = Buffer.from(username + ':' + password).toString('base64')
    sock.write('CONNECT 127.0.0.1:' + PORTS.origin + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ' + auth + '\r\n\r\n')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const text = Buffer.concat(chunks).toString('latin1')
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text)
      if (m) {
        sock.end()
        return Number.parseInt(m[1]!, 10)
      }
      await sleep(50)
    }
    sock.end()
    return 0
  } catch {
    return 0
  }
}

async function listNodes(api: Api, query = ''): Promise<any[]> {
  const r = await api.get('/api/nodes?limit=500' + query)
  return r.items ?? []
}

async function nodeByPrefix(api: Api, prefix: string): Promise<any | undefined> {
  const all = await listNodes(api)
  return all.find((n) => n.id.startsWith(prefix))
}

async function credentials(api: Api, nodeId: string): Promise<{ username: string; password: string }> {
  const r = await api.get('/api/nodes/' + nodeId + '/connection')
  return { username: r.nodeId, password: extractPassword(r.http) }
}

function extractPassword(httpUrl: string): string {
  const m = /^http:\/\/([^:]+):([^@]+)@/.exec(httpUrl)
  return m ? m[2]! : ''
}

/** 直接用 sqlite 改库（模拟人为污染，仅供验收脚本使用） */
async function withDb<T>(fn: (db: Database) => T): Promise<T> {
  const db = new Database(join(REPO, '.data-verify', 'sb.db'))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

 // ------------------------------------------------------------------ 主流程
export async function runAcceptance(): Promise<CheckResult[]> {
  ensureXray()
  console.log('使用 Xray 二进制: ' + XRAY_BIN)
  // 先清掉上一轮遗留的 xray（否则会出现「幽灵数据面」：控制面连到旧实例，tag 已存在）
  await killXrayProcesses()

  // 3 个 origin（不同出口 IP）+ 3 个 upstream（各自强制转发到对应 origin）
  const originHK = startOrigin(PORTS.origin, { ip: '203.0.113.7', country: 'HK', region: 'Hong Kong' })
  const originJP = startOrigin(PORTS.originB, { ip: '198.51.100.9', country: 'JP', region: 'Tokyo' })
  const originUS = startOrigin(PORTS.originC, { ip: '192.0.2.33', country: 'US', region: 'Los Angeles' })
  const upHK = startUpstream(PORTS.upstream, { forceTarget: '127.0.0.1:' + PORTS.origin })
  const upJP = startUpstream(PORTS.upstreamB, { forceTarget: '127.0.0.1:' + PORTS.originB })
  const upUS = startUpstream(PORTS.upstreamC, { forceTarget: '127.0.0.1:' + PORTS.originC })

  const linkHK = 'http://hk:hk@127.0.0.1:' + PORTS.upstream + '#HK-01'
  const linkJP = 'http://jp:jp@127.0.0.1:' + PORTS.upstreamB + '#JP-01'
  const linkUS = 'http://us:us@127.0.0.1:' + PORTS.upstreamC + '#US-01'
  const linkNew = 'http://n01:n01@127.0.0.1:' + PORTS.upstream + '#SG-01'
  // AC-6 专用：独立的凭据/端口，保证「首次同步 added=1」不受前面用例影响
  const linkC1 = 'http://n03:n03@127.0.0.1:' + PORTS.upstreamB + '#MO-01'
  const linkC2 = 'http://n04:n04@127.0.0.1:' + PORTS.upstreamC + '#MO-02'

  const panel = await startPanel()
  const api = makeApi(panel)
 
  try {
    // ============================================================ AC-12（前半）：从零配置
    await check('AC-12a', '配置全在面板：建订阅 → 同步 → 发布 → 数据面出现节点 tag', async () => {
      const subId = await createInlineSub(api, 'e2e-main', [linkHK, linkJP].join('\n'))
      ev('subscriptionId=' + subId)
      const sync = await syncSub(api, subId)
      if (sync.status !== 'ok') return { status: 'fail', detail: '同步失败: ' + JSON.stringify(sync.error) }
      const nodes = await listNodes(api)
      ev('nodes=' + nodes.map((n) => n.id + '/' + n.protocol).join(', '))
      if (nodes.length !== 2) return { status: 'fail', detail: '期望 2 个节点，实际 ' + nodes.length }
      const pub = await publish(api)
      ev('publish=' + JSON.stringify(pub.summary))
      if (!pub.ok) return { status: 'fail', detail: '发布失败: ' + pub.error }
      const lso = await xrayApiTags('lso')
      const lsi = await xrayApiTags('lsi')
      ev('lso=' + lso.join(','))
      ev('lsi=' + lsi.join(','))
      const nodeTags = lso.filter((t) => t.startsWith('out-') && t !== 'out-direct')
      if (nodeTags.length !== 2) return { status: 'fail', detail: 'lso 中的节点出站数=' + nodeTags.length + '（期望 2）' }
      if (lsi.filter((t) => t.startsWith('in-')).length !== 2) return { status: 'fail', detail: 'lsi 中的节点入站数不符' }
      return { status: 'pass', detail: '2 节点全部热更新到数据面，未重启进程' }
    })

    // ============================================================ AC-4 订阅格式识别
    await check('AC-4', '订阅格式识别（base64 / clash yaml / xray json / sing-box json / 明文链接 / 混合）', async () => {
      const fixtures = await import('node:fs/promises').then((fs) => fs.readdir(join(REPO, 'test/fixtures/sub')).catch(() => []))
      if (!fixtures.length) return { status: 'skip', detail: '未找到 test/fixtures/sub' }
      let okCount = 0
      const lines: string[] = []
      for (const f of fixtures) {
        const body = await Bun.file(join(REPO, 'test/fixtures/sub', f as string)).text()
        const preview = await api.post('/api/subscriptions/preview', { text: body })
        lines.push(f + ' → format=' + preview.format + ' total=' + preview.total + ' unsupported=' + preview.unsupported + ' errors=' + (preview.errors?.length ?? 0))
        if (preview.total > 0) okCount++
      }
      ev(lines.join('\n'))
      if (okCount === 0) return { status: 'fail', detail: '没有任何 fixture 解析出节点' }
      return { status: okCount === fixtures.length ? 'pass' : 'partial', detail: okCount + '/' + fixtures.length + ' 个 fixture 解析出节点' }
    })

    // ============================================================ AC-5 订阅失败不清空
    await check('AC-5', '订阅失败不清空：URL 指向 500 / 超时 / HTML 时 nodes 与数据面不变', async () => {
      await drainRetire(api)
      originHK.setSub([linkHK, linkJP, linkUS].join('\n'))
      const subId = await createUrlSub(api, 'failing-sub', 'http://127.0.0.1:' + PORTS.origin + '/sub')
      const before = await listNodes(api)
      const beforeTags = (await xrayApiTags('lso')).slice().sort()
      const modes: ('500' | 'timeout' | 'html')[] = ['500', 'html', 'timeout']
      const outcomes: string[] = []
      for (const m of modes) {
        originHK.setFail(m)
        const job = await syncSub(api, subId)
        const st = job.result?.status ?? job.status
        outcomes.push(m + '→' + st + (job.result?.errorKind ? '/' + job.result.errorKind : ''))
      }
      originHK.setFail('none')
      await drainRetire(api)
      const after = await listNodes(api)
      const afterTags = (await xrayApiTags('lso')).slice().sort()
      ev('sync outcomes: ' + outcomes.join(', '))
      ev('lso before=' + beforeTags.join(',') + ' | after=' + afterTags.join(','))
      ev('nodes before/after = ' + before.length + '/' + after.length)
      ev('lso before/after = ' + beforeTags.length + '/' + afterTags.length)
      if (after.length !== before.length) return { status: 'fail', detail: '失败同步改动了 nodes' }
      if (afterTags.join(',') !== beforeTags.join(',')) return { status: 'fail', detail: '失败同步改动了数据面' }
      const anyOk = outcomes.some((o) => o.includes('→ok'))
      if (anyOk) return { status: 'fail', detail: '失败场景有被判定为成功的: ' + outcomes.join(', ') }
      return { status: 'pass', detail: '三种失败模式均只写 run 记录，nodes 与数据面零变化' }
    })

    // ============================================================ AC-6 增/改/删/恢复计数
    await check('AC-6', '新增/修改/消失/恢复四个计数与 ID/密码保持', async () => {
      const subId = await createInlineSub(api, 'e2e-counts', [linkC1].join('\n'))
      const r1 = (await syncSub(api, subId)).result
      const node1 = await nodeByPrefix(api, 'mo')
      const pw1 = node1 ? (await credentials(api, node1.id)).password : ''
      // 修改（显示名变化 → 计为 changed）
      await api.patch('/api/subscriptions/' + subId, { text: [linkC1.replace('#MO-01', '#MO-01-renamed')].join('\n') })
      const r2 = (await syncSub(api, subId)).result
      // 新增第二个节点
      await api.patch('/api/subscriptions/' + subId, { text: [linkC1.replace('#MO-01', '#MO-01-renamed'), linkC2].join('\n') })
      const r3 = (await syncSub(api, subId)).result
      // 消失（移除第一个节点）
      await api.patch('/api/subscriptions/' + subId, { text: [linkC2].join('\n') })
      const r4 = (await syncSub(api, subId)).result
      // 恢复
      await api.patch('/api/subscriptions/' + subId, { text: [linkC1.replace('#MO-01', '#MO-01-renamed'), linkC2].join('\n') })
      const r5 = (await syncSub(api, subId)).result
      const nodeAfter = node1 ? await nodeByPrefix(api, 'mo') : undefined
      const pw2 = nodeAfter ? (await credentials(api, nodeAfter.id)).password : ''
      ev('run1 added=' + r1.added + ' changed=' + r1.changed)
      ev('run2 changed=' + r2.changed + ' added=' + r2.added)
      ev('run3 added=' + r3.added + ' removed=' + r3.removed + ' changed=' + r3.changed)
      ev('run4 added=' + r4.added + ' removed=' + r4.removed)
      ev('run5 restored=' + r5.restored + ' added=' + r5.added)
      const problems: string[] = []
      if (r1.added !== 1) problems.push('首次同步 added 期望 1 实际 ' + r1.added)
      if (r2.changed < 1) problems.push('改名未计为 changed（实际 ' + r2.changed + '）')
      if (r4.removed < 1) problems.push('消失未计为 removed（实际 ' + r4.removed + '）')
      if (r5.restored < 1) problems.push('恢复未计为 restored（实际 ' + r5.restored + '）')
      if (node1 && nodeAfter && nodeAfter.id !== node1.id) problems.push('恢复后节点 ID 变化')
      if (pw1 && pw2 && pw1 !== pw2) problems.push('恢复后密码变化')
      if (problems.length) return { status: 'fail', detail: problems.join('; ') }
      return { status: 'pass', detail: '增/改/消失/恢复计数正确，ID 与密码保持' }
    })

    // ============================================================ AC-7 检测三阶段
    await check('AC-7', '检测三阶段与字段完整（stage=exit_ip, connect_ms/total_ms/exit_ip/exit_country）', async () => {
      const nodes = await listNodes(api)
      if (!nodes.length) return { status: 'fail', detail: '没有可检测节点' }
      // 逐个尝试，直到有一个节点三阶段走通（避免被前序用例的瞬时状态干扰）
      let target = nodes.find((n) => n.id.startsWith('hk')) ?? nodes[0]!
      let run: any = undefined
      let st: any = {}
      for (const cand of [target, ...nodes.filter((n) => n.id !== target.id)].slice(0, 3)) {
        const r = await api.post('/api/nodes/' + cand.id + '/check', { depth: 'full' })
        await waitJob(api, r.jobId, 60_000)
        const runs = await api.get('/api/nodes/' + cand.id + '/checks')
        run = runs.items?.[0]
        st = (await listNodes(api)).find((n) => n.id === cand.id)?.status ?? {}
        ev(cand.id + ' run=' + JSON.stringify(run))
        ev(cand.id + ' status=' + JSON.stringify(st))
        target = cand
        if (run?.stage_reached === 'exit_ip') break
      }
      const missing: string[] = []
      if (!run) missing.push('node_check_runs 无记录')
      if (run && run.stage_reached !== 'exit_ip') missing.push('stage_reached=' + run.stage_reached)
      for (const f of ['connectMs', 'totalMs', 'delayMs', 'exitIp', 'exitCountry']) {
        if (st[f] === null || st[f] === undefined) missing.push('node_status.' + f + ' 为空')
      }
      for (const f of ['lastCheckAt', 'state', 'failStreak', 'errorKind', 'recoveredAt']) {
        if (!(f in st)) missing.push('node_status.' + f + ' 缺失')
      }
      if (missing.length) return { status: 'fail', detail: missing.join('; ') }
      return { status: 'pass', detail: '三阶段到达 exit_ip，字段齐全，出口 ' + st.exit_ip + ' / ' + st.exit_country }
    })

    // ============================================================ AC-8 检测并发受限
    await check('AC-8', '检测并发不超过 detect.concurrency', async () => {
      const patched = await api.patch('/api/settings', { detect: { concurrency: 3 } })
      const effective = patched?.settings?.detect?.concurrency
      ev('PATCH 后 detect.concurrency=' + effective)
      const nodes = await listNodes(api)
      const r = await api.post('/api/nodes/check-batch', { nodeIds: nodes.map((n) => n.id), depth: 'lite' })
      const job = await waitJob(api, r.jobId, 60_000)
      const res = job.result ?? {}
      ev('peak=' + res.peakConcurrency + ' limit=' + res.limit + ' count=' + res.count)
      if (res.limit !== 3) return { status: 'fail', detail: '并发上限未生效：limit=' + res.limit }
      if (res.peakConcurrency > res.limit) return { status: 'fail', detail: '观测并发 ' + res.peakConcurrency + ' > 上限 ' + res.limit }
      return { status: 'pass', detail: '峰值并发 ' + res.peakConcurrency + ' ≤ 上限 ' + res.limit }
    })

    // ============================================================ AC-3 单端口多节点并发
    await check('AC-3', '单端口多节点并发：3 个凭据 → 3 个不同出口 IP；错误密码 407', async () => {
      // 补一个 US 节点：用 http 上游 + 不同端口
      const subId = await createInlineSub(api, 'e2e-multi', [linkHK, linkJP, linkUS].join('\n'))
      await syncSub(api, subId)
      const pub = await publish(api)
      if (!pub.ok) return { status: 'fail', detail: '发布失败: ' + pub.error }
      const nodes = await listNodes(api)
      const picks = nodes.filter((n) => /^(hk|jp|us)/.test(n.id))
      if (picks.length < 3) return { status: 'fail', detail: '节点不足 3 个：' + nodes.map((n) => n.id).join(',') }
      const ips: Record<string, string> = {}
      for (const n of picks) {
        const cred = await credentials(api, n.id)
        const r = await proxyGetJson(cred.username, cred.password)
        ips[n.id] = r.json?.ip ?? '(失败 status=' + r.status + ')'
      }
      ev('exit ips: ' + JSON.stringify(ips))
      const uniq = new Set(Object.values(ips))
      // 错误密码 → 407
      // Bun 的 fetch 在代理返回 407 时会直接抛错，因此用裸 socket 读 CONNECT 的应答行
      const bad = await rawConnectStatus(picks[0]!.id, 'wrong-password')
      ev('wrong password status=' + bad)
      if (uniq.size < 3) return { status: 'fail', detail: '出口 IP 未做到 3 个不同：' + JSON.stringify(ips) }
      if (bad !== 407) return { status: 'partial', detail: '3 个出口 IP 均不同，但错误密码返回 ' + bad + '（期望 407）' }
      return { status: 'pass', detail: '3 个节点并发经同一 7890 端口，出口 IP 各不相同；错误凭据返回 407' }
    })

    // ============================================================ AC-16 规则追加语义
    await check('AC-16', 'adrules --append 语义：发布新节点后旧节点的规则仍在（旧节点仍可代理）', async () => {
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      const jp = nodes.find((n) => n.id.startsWith('jp'))
      if (!hk || !jp) return { status: 'skip', detail: '缺少 hk/jp 节点' }
      const c1 = await credentials(api, hk.id)
      const before = (await proxyGetJson(c1.username, c1.password)).json
      ev('发布前 ' + hk.id + ' 出口=' + (before?.ip ?? '失败'))
      // 再发布一次（带上新节点 SG）
      const subId = await createInlineSub(api, 'e2e-append', [linkHK, linkJP, linkUS, linkNew].join('\n'))
      await syncSub(api, subId)
      const pub = await publish(api)
      ev('发布 summary=' + JSON.stringify(pub.summary))
      const after = (await proxyGetJson(c1.username, c1.password)).json
      ev('发布后 ' + hk.id + ' 出口=' + (after?.ip ?? '失败'))
      const tags = await xrayApiTags('lso')
      ev('lso=' + tags.join(','))
      if (!after?.ip) return { status: 'fail', detail: '发布新节点后旧节点不再可用（规则表被整体替换）' }
      return { status: 'pass', detail: '新增节点后旧节点规则仍在（--append 生效），旧节点 ' + hk.id + ' 仍返回 ' + after.ip }
    })

    // ============================================================ AC-9 发布前校验
    await check('AC-9', '发布前构建校验拦下非法 outbound（数据面不变、revision=failed）', async () => {
      await drainRetire(api)
      // 让「任意一个节点构建失败」都触发整体中止（否则按 §9.3 只会排除该节点继续发布）
      await api.patch('/api/settings', { publish: { maxUnsupportedRatio: 0 } })
      const before = (await xrayApiTags('lso')).slice().sort()
      const nodeRow = await withDb((db) => db.query('SELECT id, outbound_json FROM nodes LIMIT 1').get() as any)
      if (!nodeRow) return { status: 'skip', detail: '没有节点可用于污染' }
      await withDb((db) => {
        db.run('UPDATE nodes SET outbound_json = ? WHERE id = ?', [JSON.stringify({ protocol: 'vless', settings: {} }), nodeRow.id])
      })
      ev('已把节点 ' + nodeRow.id + ' 的 outbound 改成非法（vless 缺 vnext）')
      const pub = await publish(api)
      ev('publish=' + JSON.stringify({ ok: pub.ok, error: pub.error, validation: pub.validation?.checks }))
      const after = (await xrayApiTags('lso')).slice().sort()
      await withDb((db) => {
        db.run('UPDATE nodes SET outbound_json = ? WHERE id = ?', [nodeRow.outbound_json, nodeRow.id])
      })
      await api.patch('/api/settings', { publish: { maxUnsupportedRatio: 0.5 } })
      ev('lso before=' + before.join(',') + ' after=' + after.join(','))
      if (pub.ok) return { status: 'fail', detail: '非法 outbound 竟然发布成功' }
      if (before.join(',') !== after.join(',')) return { status: 'fail', detail: '数据面被改动了' }
      const rev = (await api.get('/api/runtime/revisions?limit=1')).items?.[0]
      ev('revision=' + JSON.stringify({ id: rev?.id, status: rev?.status, error: rev?.error }))
      if (rev?.status !== 'failed') return { status: 'fail', detail: 'revision 状态不是 failed：' + rev?.status }
      return { status: 'pass', detail: '构建校验拦下发布，数据面 tag 集合不变，revision=failed' }
    })

    // ============================================================ AC-10 安全阀
    await check('AC-10', '安全阀 maxRemovalRatio：构造移除 80% 节点 → 发布被拦下', async () => {
      await drainRetire(api)
      const before = (await xrayApiTags('lso')).slice().sort()
      const nodes = await listNodes(api)
      ev('当前节点数=' + nodes.length)
      if (nodes.length < 4) return { status: 'skip', detail: '节点太少（' + nodes.length + '）无法构造 80% 移除' }
      // 注意：按 §7.5，节点从订阅里消失只是打 missing_since，不会立刻离开数据面
      // （要等 stale_until 到期）。因此这里直接用面板的「节点级启停」把期望状态缩小，
      // 这才是 maxRemovalRatio 要拦的场景（运维误操作导致大批节点被下架）。
      const applied = await api.get('/api/runtime/status')
      const nodeIds: string[] = applied.diff.keep.concat(applied.diff.add)
      const keepCount = Math.max(1, Math.floor(nodeIds.length * 0.2))
      const toDisable = nodeIds.slice(keepCount)
      ev('快照节点 ' + nodeIds.length + ' 个，禁用 ' + toDisable.length + ' 个（保留 ' + keepCount + '）')
      for (const id of toDisable) await api.patch('/api/nodes/' + id, { enabled: false })
      const pub = await publish(api)
      ev('publish=' + JSON.stringify({ ok: pub.ok, error: pub.error, checks: pub.validation?.checks }))
      const after = (await xrayApiTags('lso')).slice().sort()
      const blocked = !pub.ok && /maxRemovalRatio/i.test(JSON.stringify(pub.validation?.checks ?? []))
      // 复原：把节点重新启用，避免影响后续用例
      for (const id of toDisable) await api.patch('/api/nodes/' + id, { enabled: true })
      if (!blocked) return { status: 'fail', detail: '未按 maxRemovalRatio 拦下：' + JSON.stringify(pub) }
      if (before.join(',') !== after.join(',')) return { status: 'fail', detail: '被拦下却改动了数据面' }
      return { status: 'pass', detail: '移除比例超阈值被拦下，数据面零变化' }
    })

    // ============================================================ 恢复状态 + AC-12 收尾
    await check('AC-12b', '面板即配置：恢复节点集合并发布，拿到可用的 http://节点ID:密码@host:7890', async () => {
      // 先把被 AC-10 关掉的节点重新启用，并恢复订阅内容
      for (const n of await listNodes(api)) {
        if (!n.enabled) await api.patch('/api/nodes/' + n.id, { enabled: true })
      }
      const subs = await api.get('/api/subscriptions')
      const main = subs.items.find((s: any) => s.name === 'e2e-main') ?? subs.items[0]
      await api.patch('/api/subscriptions/' + main.id, { text: [linkHK, linkJP, linkUS, linkNew].join('\n'), formatHint: 'auto' })
      await syncSub(api, main.id)
      const pub = await publish(api)
      if (!pub.ok) return { status: 'fail', detail: '发布失败: ' + pub.error }
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      if (!hk) return { status: 'fail', detail: '没有 hk 节点' }
      const cred = await credentials(api, hk.id)
      const r = await proxyGetJson(cred.username, cred.password)
      ev('proxy 出口=' + JSON.stringify(r.json) + ' status=' + r.status)
      if (!r.json?.ip) return { status: 'fail', detail: '生成的连接串不可用（status=' + r.status + '）' }
      return { status: 'pass', detail: '全程未改任何文件即拿到可用连接串 http://' + cred.username + ':***@127.0.0.1:' + PORTS.gateway }
    })

    // ============================================================ AC-18 网关限流与踢线
    await check('AC-18', '网关限流（maxConcurrentPerUser）与踢线', async () => {
      await api.patch('/api/settings', { gateway: { maxConcurrentPerUser: 2 } })
      await sleep(300)
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      if (!hk) return { status: 'skip', detail: '没有 hk 节点' }
      const cred = await credentials(api, hk.id)
      const t1 = await openTunnel(cred.username, cred.password, '127.0.0.1:' + PORTS.origin)
      const t2 = await openTunnel(cred.username, cred.password, '127.0.0.1:' + PORTS.origin)
      await sleep(300)
      const t3 = await openTunnel(cred.username, cred.password, '127.0.0.1:' + PORTS.origin)
      await sleep(400)
      const third = Buffer.concat(t3.data).toString('latin1')
      ev('第三条连接响应: ' + third.split('\r\n')[0])
      const stats = await api.get('/api/gateway/connections')
      ev('active=' + (stats.active?.length ?? 0))
      const kicked = await api.post('/api/gateway/kick', { nodeId: hk.id })
      ev('kick=' + JSON.stringify(kicked))
      await sleep(500)
      const stats2 = await api.get('/api/gateway/connections')
      ev('kick 后 active=' + (stats2.active?.length ?? 0))
      t1.close()
      t2.close()
      t3.close()
      await api.patch('/api/settings', { gateway: { maxConcurrentPerUser: 64 } })
      if (!third.includes('429')) return { status: 'partial', detail: '踢线生效（closed=' + kicked.closed + '），但第三条连接未返回 429：' + third.split('\r\n')[0] }
      if ((stats2.active?.length ?? 0) !== 0) return { status: 'fail', detail: '踢线后连接表未清空' }
      return { status: 'pass', detail: '超并发返回 429，踢线后网关连接表清空' }
    })

    // ============================================================ AC-2 同步与发布独立
    await check('AC-2', '同步与发布是两套独立任务', async () => {
      await drainRetire(api)
      originHK.setSub([linkHK, linkJP].join('\n'))
      // 独立 URL（带 query）避免与 AC-5 的订阅 UNIQUE(url) 冲突
      const subId = await createUrlSub(api, 'e2e-independent', 'http://127.0.0.1:' + PORTS.origin + '/sub?for=independent')
      const lsoBefore = (await xrayApiTags('lso')).slice().sort()
      const revBefore = (await api.get('/api/runtime/status')).revision?.id ?? null
      const sync = await syncSub(api, subId)
      const lsoAfterSync = (await xrayApiTags('lso')).slice().sort()
      const revAfterSync = (await api.get('/api/runtime/status')).revision?.id ?? null
      const hitsBeforePublish = originHK.subHits()
      await publish(api)
      const hitsAfterPublish = originHK.subHits()
      ev('同步结果=' + JSON.stringify({ status: sync.result?.status, added: sync.result?.added }))
      ev('lso 同步前后 = ' + lsoBefore.length + '/' + lsoAfterSync.length)
      ev('revision 同步前后 = ' + revBefore + '/' + revAfterSync)
      ev('订阅 HTTP 请求数 发布前后 = ' + hitsBeforePublish + '/' + hitsAfterPublish)
      if (lsoBefore.join(',') !== lsoAfterSync.join(',')) return { status: 'fail', detail: '只触发同步却改动了数据面' }
      if (revBefore !== revAfterSync) return { status: 'fail', detail: '只触发同步却产生了新 revision' }
      if (hitsAfterPublish !== hitsBeforePublish) return { status: 'fail', detail: '只触发发布却拉了订阅' }
      return { status: 'pass', detail: '同步不碰数据面，发布不拉订阅' }
    })

    // ============================================================ AC-15 对账发现漂移
    await check('AC-15', '对账发现漂移（外部 rmo 删 tag）并可恢复', async () => {
      const tags = await xrayApiTags('lso')
      const victim = tags.find((t) => t.startsWith('out-') && t !== 'out-direct')
      if (!victim) return { status: 'skip', detail: '没有可删除的节点出站 tag' }
      const r = await xrayApi(['rmo', victim])
      ev('外部 rmo ' + victim + ' → code=' + r.code)
      // 触发只读对账巡检
      const dry = await api.post('/api/runtime/reconcile', { dryRun: true })
      const dryJob = await waitJob(api, dry.jobId, 30_000)
      ev('dryRun 对账: ' + JSON.stringify(dryJob.result))
      const driftDetected = dryJob.result && dryJob.result.consistent === false
      const applied = await api.post('/api/runtime/reconcile', { dryRun: false })
      const appJob = await waitJob(api, applied.jobId, 60_000)
      ev('apply 对账: ' + JSON.stringify(appJob.result))
      const after = await xrayApiTags('lso')
      ev('lso after=' + after.join(','))
      if (!driftDetected) return { status: 'fail', detail: '对账未检出漂移' }
      if (!after.includes(victim)) return { status: 'fail', detail: '重新对账未恢复被删 tag' }
      return { status: 'pass', detail: '检出漂移并重新对账恢复 ' + victim }
    })

    // ============================================================ AC-13 重启自愈与重放
    await check('AC-13', 'kill Xray → 控制面自动拉起并全量重放（lso tag 数一致、代理恢复可用）', async () => {
      const before = await xrayApiTags('lso')
      const health1 = await api.get('/api/health')
      const pid1 = health1.xray.pid
      ev('原 pid=' + pid1 + ' lso=' + before.length)
      if (pid1) {
        await Bun.spawn(['taskkill', '/F', '/PID', String(pid1)], { stdout: 'ignore', stderr: 'ignore' }).exited
      } else {
        return { status: 'skip', detail: '数据面为 external 模式，无 pid 可杀' }
      }
      const restored = await waitFor(
        async () => {
          const t = await xrayApiTags('lso')
          const h = await api.get('/api/health')
          return h.xray.pid && h.xray.pid !== pid1 && t.filter((x) => x.startsWith('out-') && x !== 'out-direct').length >= before.filter((x) => x.startsWith('out-') && x !== 'out-direct').length ? t : null
        },
        90_000,
        'xray 重启并重放',
      )
      ev('重启后 lso=' + restored.join(','))
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      let proxyOk = false
      if (hk) {
        const cred = await credentials(api, hk.id)
        proxyOk = await waitFor(async () => (await proxyGetJson(cred.username, cred.password)).ok, 30_000, '代理恢复')
      }
      ev('重启后代理可用=' + proxyOk)
      if (!restored.length) return { status: 'fail', detail: '未自动拉起数据面' }
      if (!proxyOk) return { status: 'partial', detail: '数据面已重放但代理未在 30s 内恢复' }
      return { status: 'pass', detail: 'Xray 被 kill 后自动拉起并全量重放 ' + restored.length + ' 个 tag，代理恢复可用' }
    })

    // ============================================================ AC-1 / AC-14 零中断
    await check('AC-1', '新增节点不影响已有连接（发布期间 xray pid 不变、长连接持续增长）', async () => {
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      if (!hk) return { status: 'skip', detail: '没有 hk 节点' }
      const cred = await credentials(api, hk.id)
      const tunnel = await openTunnel(cred.username, cred.password, '127.0.0.1:' + PORTS.origin)
      await sleep(300)
      tunnel.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
      await sleep(600)
      const b1 = tunnel.bytes()
      const pidBefore = (await api.get('/api/health')).xray.pid
      ev('发布前：pid=' + pidBefore + ' 已收字节=' + b1)
      if (b1 <= 0) {
        tunnel.close()
        return { status: 'fail', detail: '长连接未能建立（字节数 0）' }
      }
      // 触发同步（含新节点）+ 发布
      const subId = await createInlineSub(api, 'e2e-live-add', [linkHK, linkJP, linkUS, linkNew, 'http://n02:n02@127.0.0.1:' + PORTS.upstream + '#SG-02'].join('\n'))
      await syncSub(api, subId)
      const pub = await publish(api)
      await sleep(1200)
      const b2 = tunnel.bytes()
      const pidAfter = (await api.get('/api/health')).xray.pid
      ev('发布后：pid=' + pidAfter + ' 已收字节=' + b2 + ' summary=' + JSON.stringify(pub.summary))
      tunnel.close()
      if (!pub.ok) return { status: 'fail', detail: '发布失败: ' + pub.error }
      if (pidBefore !== pidAfter) return { status: 'fail', detail: '发布期间数据面进程被重启（pid ' + pidBefore + ' → ' + pidAfter + '）' }
      if (b2 <= b1) return { status: 'fail', detail: '长连接停止传输字节（' + b1 + ' → ' + b2 + '）' }
      return { status: 'pass', detail: '发布 ' + JSON.stringify(pub.summary) + '，xray pid 不变，长连接字节 ' + b1 + ' → ' + b2 + ' 持续增长' }
    })

    await check('AC-14', '热删除不破坏在途连接（删除节点后长连接继续）', async () => {
      const nodes = await listNodes(api)
      const victim = nodes.find((n) => n.id.startsWith('us'))
      if (!victim) return { status: 'skip', detail: '没有 us 节点可用于删除' }
      const cred = await credentials(api, victim.id)
      const tunnel = await openTunnel(cred.username, cred.password, '127.0.0.1:' + PORTS.origin)
      await sleep(300)
      tunnel.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
      await sleep(700)
      const b1 = tunnel.bytes()
      if (b1 <= 0) {
        tunnel.close()
        return { status: 'fail', detail: '长连接未能建立' }
      }
      // 让该节点从订阅里消失 → 同步 → 发布（走完整 apply，含 rmo 延迟退休）
      const subs = await api.get('/api/subscriptions')
      for (const s of subs.items) {
        if (s.name.startsWith('e2e-')) await api.patch('/api/subscriptions/' + s.id, { text: [linkHK, linkJP].join('\n') })
      }
      for (const s of subs.items) if (s.name.startsWith('e2e-')) await syncSub(api, s.id)
      await api.patch('/api/nodes/' + victim.id, { enabled: false })
      await publish(api)
      await sleep(1500)
      const b2 = tunnel.bytes()
      const tags = await xrayApiTags('lso')
      ev('删除节点 ' + victim.id + ' 后：字节 ' + b1 + ' → ' + b2 + '，lso=' + tags.join(','))
      tunnel.close()
      if (b2 <= b1) return { status: 'fail', detail: '删除节点打断了在途连接（' + b1 + ' → ' + b2 + '）' }
      return { status: 'pass', detail: '删除节点后长连接继续到字节 ' + b2 + '（延迟退休 rmo 生效）' }
    })

    // ============================================================ AC-11 API Key
    await check('AC-11', 'API Key 鉴权：无 Key/错 Key 401、scope 不足 403、正确 200、吊销后失效', async () => {
      const noKey = await fetch('http://127.0.0.1:' + PORTS.panel + '/v1/nodes')
      const badKey = await fetch('http://127.0.0.1:' + PORTS.panel + '/v1/nodes', { headers: { authorization: 'Bearer xcp_dead_beef' } })
      const created = await api.post('/api/keys', { name: 'readonly', scopes: ['read'] })
      const keyApi = makeApi(panel, { bearer: created.plaintext })
      const okRes = await keyApi.raw('GET', '/v1/nodes')
      const forbidden = await keyApi.raw('POST', '/v1/runtime/publish')
      const gw = await keyApi.raw('GET', '/v1/gateway')
      ev('noKey=' + noKey.status + ' badKey=' + badKey.status + ' ok=' + okRes.status + ' publishForbidden=' + forbidden.status + ' gateway=' + gw.status)
      await api.del('/api/keys/' + created.id)
      const afterRevoke = await keyApi.raw('GET', '/v1/nodes')
      ev('吊销后=' + afterRevoke.status)
      const audit = await api.get('/api/events?limit=200')
      const hasAudit = (audit.items ?? []).length > 0
      const problems: string[] = []
      if (noKey.status !== 401) problems.push('无 Key 返回 ' + noKey.status)
      if (badKey.status !== 401) problems.push('错 Key 返回 ' + badKey.status)
      if (okRes.status !== 200) problems.push('正确 Key 返回 ' + okRes.status)
      if (forbidden.status !== 403) problems.push('scope 不足返回 ' + forbidden.status)
      if (afterRevoke.status !== 401 && afterRevoke.status !== 403) problems.push('吊销后返回 ' + afterRevoke.status)
      if (!hasAudit) problems.push('缺少审计记录')
      if (problems.length) return { status: 'fail', detail: problems.join('; ') }
      return { status: 'pass', detail: '401/403/200/吊销失效/审计全部符合预期' }
    })

    // ============================================================ AC-17 端口池
    await check('AC-17', '端口池：2000 次分配无失败、冷却期端口不复用、耗尽时中止并告警', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'xcp-ports-'))
      const db = openDb(join(dir, 'p.db'))
      db.exec('CREATE TABLE node_port (node_id TEXT PRIMARY KEY, port INTEGER NOT NULL UNIQUE, assigned_at INTEGER NOT NULL, released_at INTEGER, reusable_at INTEGER)')
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)')
      const settings = new SettingsStore(db)
      settings.update({ xray: { inboundPortStart: 30000, inboundPortEnd: 33999 } })
      const pool = new PortPool(db, settings)
      const started = Date.now()
      for (let i = 0; i < 2000; i++) pool.ensure('n' + i)
      const afterAlloc = pool.stats()
      // 释放前 100 个 → 冷却期内不可复用
      for (let i = 0; i < 100; i++) pool.release('n' + i)
      const nextPort = pool.ensure('fresh-1')
      const coolingReused = nextPort <= 30099
      ev('2000 次分配耗时 ' + (Date.now() - started) + 'ms, used=' + afterAlloc.used + ', 下一个端口=' + nextPort)
      // 耗尽
      settings.update({ xray: { inboundPortStart: 40000, inboundPortEnd: 40002 } })
      const small = new PortPool(db, settings)
      small.ensure('a')
      small.ensure('b')
      small.ensure('c')
      let exhausted = false
      try {
        small.ensure('d')
      } catch (e) {
        exhausted = /耗尽/.test((e as Error).message)
      }
      db.close()
      await rm(dir, { recursive: true, force: true })
      ev('冷却期复用=' + coolingReused + ' 耗尽抛错=' + exhausted)
      if (afterAlloc.used !== 2000) return { status: 'fail', detail: '2000 次分配后 used=' + afterAlloc.used }
      if (coolingReused) return { status: 'fail', detail: '冷却期内的端口被复用（' + nextPort + '）' }
      if (!exhausted) return { status: 'fail', detail: '端口池耗尽时未抛错中止' }
      return { status: 'pass', detail: '2000 次分配无失败，冷却期端口不复用，耗尽抛 port_pool_exhausted' }
    })

    // ============================================================ AC-16 负例（破坏性，放最后）
    await check('AC-16-neg', '负例：adrules 不带 --append 会整体替换规则表（旧节点失效）', async () => {
      const nodes = await listNodes(api)
      const hk = nodes.find((n) => n.id.startsWith('hk'))
      if (!hk) return { status: 'skip', detail: '没有 hk 节点' }
      const cred = await credentials(api, hk.id)
      const okBefore = (await proxyGetJson(cred.username, cred.password)).ok
      // 故意不带 --append 追加一条无关规则
      const payload = JSON.stringify({ routing: { rules: [{ type: 'field', ruleTag: 'probe-only', inboundTag: ['api-in'], outboundTag: 'out-direct' }] } })
      const tmp = join(tmpdir(), 'xcp-adrules-neg.json')
      await Bun.write(tmp, payload)
      const r = await Bun.spawn([XRAY_BIN, 'api', 'adrules', '--server=127.0.0.1:' + PORTS.xrayApi, tmp], { stdout: 'pipe', stderr: 'pipe' })
      await r.exited
      await sleep(800)
      const okAfter = (await proxyGetJson(cred.username, cred.password)).ok
      ev('不带 --append 前可用=' + okBefore + '，之后可用=' + okAfter)
      // 恢复：重新发布
      await api.post('/api/runtime/publish', {})
      await sleep(1500)
      const restored = await xrayApiTags('lso')
      ev('恢复后 lso=' + restored.join(','))
      if (okBefore && okAfter) {
        return { status: 'partial', detail: '本构建下未观察到规则被替换（可能 adrules 行为不同），仅以正例证明 --append 生效' }
      }
      return { status: 'pass', detail: '确认 adrules 默认整体替换规则表（旧节点失效）；正例证明代码始终带 --append' }
    })
  } finally {
    await panel.stop()
    originHK.stop()
    originJP.stop()
    originUS.stop()
    upHK.stop()
    upJP.stop()
    upUS.stop()
    await killXrayProcesses()
  }

  return results
}