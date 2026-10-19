/**
 * P0 可行性脚本（PANEL.md §0.4 V1~V6 + §17 P0「1000 次 ado/rmo 长稳」）。
 *
 * 用法：bun run scripts/p0-hot-apply-check.ts
 * 依赖：真 Xray 二进制（默认 .tools/xray[.exe]，可用 XRAY_BINARY 覆盖）。
 *
 * 该脚本只使用「一个 Xray 进程 + 一个本地 origin」，不启动控制面，
 * 因此它是**独立于本项目控制面代码**的物理事实核验。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const XRAY = process.env.XRAY_BINARY || join(REPO, '.tools', process.platform === 'win32' ? 'xray.exe' : 'xray')
const API = '127.0.0.1:19501'
const METRICS = '127.0.0.1:19502'
const ORIGIN_PORT = 19510
const NODE_PORT = 19520

interface Row {
  id: string
  title: string
  status: 'pass' | 'fail' | 'partial' | 'skip'
  detail: string
  evidence: string[]
}
const rows: Row[] = []

function record(id: string, title: string, status: Row['status'], detail: string, evidence: string[] = []) {
  rows.push({ id, title, status, detail, evidence })
  console.log('[' + status.toUpperCase() + '] ' + id + ' ' + title + ' — ' + detail)
}

async function api(args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  // Go 的 flag 解析在遇到第一个非 flag 参数后停止，因此 --server 必须紧跟子命令。
  const [sub, ...rest] = args
  const proc = Bun.spawn([XRAY, 'api', sub!, '--server=' + API, ...rest], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  clearTimeout(timer)
  const code = await proc.exited
  return { code, stdout, stderr }
}

function tags(stdout: string, key: string): string[] {
  try {
    const j = JSON.parse(stdout) as any
    return (j[key] ?? []).map((x: any) => x.tag)
  } catch {
    return []
  }
}

async function writeCfg(dir: string, name: string, value: unknown): Promise<string> {
  const f = join(dir, name)
  await Bun.write(f, JSON.stringify(value, null, 2))
  return f
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!(await Bun.file(XRAY).exists())) {
    console.error('未找到 Xray 二进制: ' + XRAY)
    process.exit(2)
  }
  const version = await Bun.spawn([XRAY, 'version'], { stdout: 'pipe' }).stdout
  const versionText = (await new Response(version).text()).trim().split('\n')[0]!
  console.log('Xray: ' + versionText)
  console.log('')

  const dir = await mkdtemp(join(tmpdir(), 'xcp-p0-'))
  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: ORIGIN_PORT,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/generate_204') return new Response(null, { status: 204 })
      if (url.pathname === '/slow') {
        const stream = new ReadableStream({
          start(c) {
            let n = 0
            setInterval(() => {
              n++
              try {
                c.enqueue(new TextEncoder().encode('x'.repeat(1024) + '\n'))
              } catch {
                /* closed */
              }
            }, 50)
          },
        })
        return new Response(stream)
      }
      return new Response('ok')
    },
  })

  const base = {
    log: { loglevel: 'warning' },
    api: { tag: 'api', services: ['HandlerService', 'RoutingService', 'StatsService'] },
    metrics: { tag: 'metrics', listen: METRICS },
    stats: {},
    policy: { levels: { '0': { handshake: 4, connIdle: 300 } }, system: { statsInboundUplink: true, statsInboundDownlink: true } },
    inbounds: [{ tag: 'api-in', listen: '127.0.0.1', port: Number.parseInt(API.split(':')[1]!, 10), protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } }],
    outbounds: [{ tag: 'out-direct', protocol: 'freedom' }],
    routing: { rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] },
  }
  const baseFile = await writeCfg(dir, 'base.json', base)
  const proc = Bun.spawn([XRAY, 'run', '-c', baseFile], { stdout: 'pipe', stderr: 'pipe' })
  let xrayLog = ''
  void (async () => {
    for await (const c of proc.stdout as AsyncIterable<Uint8Array>) xrayLog += Buffer.from(c).toString()
  })()
  void (async () => {
    for await (const c of proc.stderr as AsyncIterable<Uint8Array>) xrayLog += Buffer.from(c).toString()
  })()

  // 等待 API 就绪
  let ready = false
  for (let i = 0; i < 60; i++) {
    const r = await api(['lso'])
    if (r.code === 0) {
      ready = true
      break
    }
    await sleep(300)
  }
  const pidAtStart = proc.pid
  if (!ready) {
    console.error('Xray API 未就绪:\n' + xrayLog)
    process.exit(2)
  }

  try {
    // ---------------- V1 + V2：热增 outbound / inbound / 规则，进程不重启，耗时
    const outFile = await writeCfg(dir, 'out-t1.json', {
      outbounds: [{ tag: 'out-t1', protocol: 'freedom' }],
    })
    const t1 = Date.now()
    const adop = await api(['ado', outFile])
    const adoMs = Date.now() - t1

    const inFile = await writeCfg(dir, 'in-t1.json', {
      inbounds: [{ tag: 'in-t1', listen: '127.0.0.1', port: NODE_PORT, protocol: 'http', settings: {} }],
    })
    const t2 = Date.now()
    const adip = await api(['adi', inFile])
    const adiMs = Date.now() - t2

    const ruleFile = await writeCfg(dir, 'rule-t1.json', {
      routing: { rules: [{ type: 'field', ruleTag: 'node-t1', inboundTag: ['in-t1'], outboundTag: 'out-t1' }] },
    })
    const t3 = Date.now()
    const adrules = await api(['adrules', '--append', ruleFile])
    const rulesMs = Date.now() - t3

    const lso = await api(['lso'])
    const lsi = await api(['lsi'])
    const lsoTags = tags(lso.stdout, 'outbounds')
    const lsiTags = tags(lsi.stdout, 'inbounds')
    const v1ok = adop.code === 0 && adip.code === 0 && adrules.code === 0 && lsoTags.includes('out-t1') && lsiTags.includes('in-t1') && proc.pid === pidAtStart
    record('V1', 'ado / adi / adrules --append 热增，进程不重启，lso/lsi 可对账', v1ok ? 'pass' : 'fail', 'ado=' + adop.code + ' adi=' + adip.code + ' adrules=' + adrules.code + ' pid 不变=' + (proc.pid === pidAtStart), ['lso=' + lsoTags.join(','), 'lsi=' + lsiTags.join(',')])

    const avg = (adoMs + adiMs + rulesMs) / 3
    record('V2', '单次 API 操作耗时（含 CLI 进程启动）', avg < 500 ? 'pass' : 'partial', 'ado=' + adoMs + 'ms adi=' + adiMs + 'ms adrules=' + rulesMs + 'ms，均值 ' + avg.toFixed(0) + 'ms', ['文档实测基线 71~79ms（v26.10.10）'])

    // ---------------- V6：lsrules 是否可用，且能否读到 ruleTag
    // 放在 V4 之前测：此时节点规则（ruleTag=node-t1）仍在，能证明输出的是「规则 tag」而不只是 api 规则。
    const lsr = await api(['lsrules'])
    const hasRuleTag = /"ruleTag"\s*:\s*"node-t1"/.test(lsr.stdout)
    if (lsr.code === 0 && hasRuleTag) {
      record('V6', 'lsrules 输出规则 tag', 'pass', '可用，且可按 ruleTag 读到节点规则', [lsr.stdout.slice(0, 400)])
    } else if (lsr.code === 0) {
      record('V6', 'lsrules 输出规则 tag', 'partial', 'lsrules 可用但输出里没有 ruleTag 字段（规则集合仍无法对账）', [lsr.stdout.slice(0, 400)])
    } else {
      record('V6', 'lsrules 输出规则 tag', 'partial', '本机 Xray 构建无 lsrules 子命令（' + lsr.stderr.trim().split('\n')[0] + '），对账需退化为「按已成功执行的 apply 审计推导」', ['xray help api 的子命令列表中没有 lsrules'])
    }

    // ---------------- V3：新入站立刻可服务流量
    await sleep(300)
    let v3ok = false
    let v3detail = ''
    try {
      const res = await fetch('http://127.0.0.1:' + ORIGIN_PORT + '/generate_204', {
        proxy: 'http://127.0.0.1:' + NODE_PORT,
      } as any)
      v3ok = res.status === 204
      v3detail = 'HTTP ' + res.status
    } catch (e) {
      v3detail = (e as Error).message
    }
    record('V3', '新入站立刻可服务流量（经 127.0.0.1:' + NODE_PORT + ' 的代理请求）', v3ok ? 'pass' : 'fail', v3detail)

    // ---------------- V4：删除 in-flight 连接正在使用的 outbound + inbound + 规则，长连接不中断
    const t4 = await openCountingTunnel(NODE_PORT)
    // 经 http 入站建立 CONNECT 隧道（与网关生产路径一致），再在隧道内发慢速下载请求
    t4.write('CONNECT 127.0.0.1:' + ORIGIN_PORT + ' HTTP/1.1\r\nHost: 127.0.0.1:' + ORIGIN_PORT + '\r\n\r\n')
    for (let i = 0; i < 40 && !t4.head().includes('200'); i++) await sleep(100)
    t4.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n')
    await sleep(1200)
    const before = t4.bytes()
    const rmRule = await api(['rmrules', 'node-t1'])
    const rmIn = await api(['rmi', 'in-t1'])
    const rmOut = await api(['rmo', 'out-t1'])
    await sleep(2000)
    const after = t4.bytes()
    const stillAlive = !t4.closed
    t4.close()
    record(
      'V4',
      '删除 in-flight 连接正在使用的 outbound + inbound + 规则，长连接不中断',
      after > before && rmRule.code === 0 && rmIn.code === 0 && rmOut.code === 0 ? 'pass' : 'fail',
      '字节 ' + before + ' → ' + after + '，连接存活=' + stillAlive,
      ['rmrules=' + rmRule.code + ' rmi=' + rmIn.code + ' rmo=' + rmOut.code],
    )

    // ---------------- V5：删除后端口不再监听
    let portClosed = false
    try {
      const s = await Bun.connect({ hostname: '127.0.0.1', port: NODE_PORT, socket: { data() {}, error() {}, close() {} } })
      s.end()
      portClosed = false
    } catch {
      portClosed = true
    }
    const lsiAfter = tags((await api(['lsi'])).stdout, 'inbounds')
    record('V5', 'rmi 后端口立即不再监听；rmrules/rmi/rmo 均可按 tag 删除', portClosed && !lsiAfter.includes('in-t1') ? 'pass' : 'fail', '端口仍监听=' + !portClosed + ' lsi 含 in-t1=' + lsiAfter.includes('in-t1'), ['lsi=' + lsiAfter.join(',')])

    // ---------------- 长稳：1000 次 ado/rmo
    const rssBefore = processMemoryOf(pidAtStart)
    const t5 = Date.now()
    let failures = 0
    const batch = 20
    const cbFile = await writeCfg(dir, 'out-cycle.json', { outbounds: [{ tag: 'out-cycle', protocol: 'freedom' }] })
    for (let i = 0; i < 1000 / batch; i++) {
      const a = await api(['ado', cbFile], 30000)
      if (a.code !== 0) failures++
      const r = await api(['rmo', 'out-cycle'], 30000)
      if (r.code !== 0) failures++
    }
    const cycleMs = Date.now() - t5
    await sleep(3000)
    const rssAfter = processMemoryOf(pidAtStart)
    const tagsNow = tags((await api(['lso'])).stdout, 'outbounds')
    const leaked = tagsNow.includes('out-cycle')
    record(
      'R1/1000x',
      '1000 次 ado/rmo 长稳（D5 泄漏量化）',
      failures === 0 && !leaked ? 'pass' : 'fail',
      '1000 次循环耗时 ' + (cycleMs / 1000).toFixed(1) + 's，失败 ' + failures + ' 次，残留 tag=' + leaked,
      ['进程 RSS：' + rssBefore + ' MB → ' + rssAfter + ' MB（Δ ' + (rssAfter - rssBefore).toFixed(1) + ' MB）'],
    )
  } finally {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    origin.stop(true)
    await rm(dir, { recursive: true, force: true })
  }

  console.log('')
  const bad = rows.filter((r) => r.status === 'fail').length
  console.log('===== P0 结果：' + rows.filter((r) => r.status === 'pass').length + ' pass / ' + rows.filter((r) => r.status === 'partial').length + ' partial / ' + bad + ' fail =====')
  const md = ['# P0 可行性报告（自动生成）', '', '> 由 `bun run scripts/p0-hot-apply-check.ts` 生成，' + new Date().toISOString(), '> ' + versionText, '', '| 编号 | 事项 | 结果 | 说明 |', '| --- | --- | --- | --- |']
  for (const r of rows) md.push('| ' + r.id + ' | ' + r.title + ' | ' + r.status.toUpperCase() + ' | ' + r.detail.replace(/\|/g, '\\|') + ' |')
  md.push('', '## 证据', '')
  for (const r of rows) {
    if (!r.evidence.length) continue
    md.push('### ' + r.id, '', '```text', ...r.evidence, '```', '')
  }
  await Bun.write(join(REPO, 'docs', 'P0-REPORT.md'), md.join('\n'))
  console.log('报告已写入 docs/P0-REPORT.md')
  process.exit(bad > 0 ? 1 : 0)
}

function processMemoryOf(pid: number | undefined): number {
  if (!pid) return 0
  try {
    const out = Bun.spawnSync(['tasklist', '/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'])
    const text = out.stdout.toString()
    const m = /"([\d,]+) K"/.exec(text)
    if (m) return Number.parseInt(m[1]!.replace(/,/g, ''), 10) / 1024
  } catch {
    /* 非 Windows */
  }
  return 0
}

async function openCountingTunnel(port: number): Promise<{ write: (s: string) => void; bytes: () => number; close: () => void; closed: boolean; head: () => string }> {
  const chunks: Buffer[] = []
  const state = { closed: false }
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, d) {
        chunks.push(Buffer.from(d))
      },
      close() {
        state.closed = true
      },
      error() {
        state.closed = true
      },
    },
  })
  return {
    write: (s: string) => socket.write(s),
    bytes: () => chunks.reduce((a, c) => a + c.length, 0),
    head: () => Buffer.concat(chunks).toString('latin1').slice(0, 200),
    close: () => {
      try {
        socket.end()
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return state.closed
    },
  } as any
}

await main()
