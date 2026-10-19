/**
 * 验收测试夹具（scripts/verify/harness.ts）
 *
 * 为了让 AC-1/3/7/12/13/14/16/18 这类「端到端」验收可以**完全在本机离线复现**，
 * 这里起三个本地进程/服务：
 *   1) origin      —— 目标站点（generate_204 / geoip / 慢速流）
 *   2) upstream    —— 一个最小的 HTTP 代理，被当作「订阅里的上游节点」
 *   3) panel       —— 真正的 xc-p 控制面（子进程），数据面用真 Xray 二进制
 *
 * 链路：client → 网关:19090（认证 user=节点ID）→ in-<node>(环回 http 入站)
 *       → out-<node>(http outbound) → upstream:19081 → origin:19080
 */
import { rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PORTS = {
  origin: 19080,
  originB: 19083,
  originC: 19086,
  upstream: 19081,
  upstreamB: 19084,
  upstreamC: 19087,
  panel: 19082,
  gateway: 19090,
  xrayApi: 19091,
  xrayMetrics: 19092,
  poolStart: 25100,
  poolEnd: 25199,
}

export const REPO = resolve(import.meta.dirname, '../..')
export const XRAY_BIN = process.env.XRAY_BINARY || join(REPO, '.tools', process.platform === 'win32' ? 'xray.exe' : 'xray')
export const DATA_DIR = join(REPO, '.data-verify')

export interface OriginHandle {
  port: number
  stop: () => void
  requests: string[]
  setSub: (text: string) => void
  subHits: () => number
  setFail: (mode: 'none' | '500' | 'timeout' | 'html') => void
}

/** 目标站点：模拟 generate_204 / IP 回显 / 慢速下载 */
export function startOrigin(port = PORTS.origin, opts: { ip?: string; country?: string; region?: string } = {}): OriginHandle {
  const requests: string[] = []
  let subText = ''
  let failMode: 'none' | '500' | 'timeout' | 'html' = 'none'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === '/sub') {
        if (failMode === '500') return new Response('upstream error', { status: 500 })
        if (failMode === 'timeout') {
          await sleep(30_000)
          return new Response('late', { status: 200 })
        }
        if (failMode === 'html') return new Response('<html><body>maintenance</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
        return new Response(subText, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      if (url.pathname === '/generate_204') return new Response(null, { status: 204 })
      if (url.pathname === '/geoip') {
        return Response.json({
          ip: opts.ip ?? '203.0.113.7',
          country_code: opts.country ?? 'HK',
          region: opts.region ?? 'Hong Kong',
          asn: 'AS64500',
          isp: 'xc-p verify',
        })
      }
      if (url.pathname === '/slow') {
        const stream = new ReadableStream({
          start(controller) {
            let n = 0
            const timer = setInterval(() => {
              n++
              try {
                controller.enqueue(new TextEncoder().encode('chunk-' + n + '-' + 'x'.repeat(1024) + '\n'))
              } catch {
                clearInterval(timer)
              }
            }, 50)
            ;(controller as any)._timer = timer
          },
          cancel() {
            /* 客户端断开 */
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      if (url.pathname === '/bytes') {
        const n = Number.parseInt(url.searchParams.get('n') ?? '1024', 10)
        return new Response(new Uint8Array(n).fill(65), { status: 200 })
      }
      return new Response('ok', { status: 200 })
    },
  })
  return {
    port,
    stop: () => server.stop(true),
    requests,
    setSub: (t: string) => {
      subText = t
    },
    subHits: () => requests.filter((p) => p === '/sub').length,
    setFail: (m) => {
      failMode = m
    },
  }
}

export interface UpstreamHandle {
  port: number
  stop: () => void
  log: string[]
}

/** 最小 HTTP 代理：被当作订阅里的「上游节点」；账号 hk/hk、jp/jp、us/us */
export function startUpstream(port = PORTS.upstream, opts: { forceTarget?: string } = {}): UpstreamHandle {
  const log: string[] = []
  const accepted = new Set(['hk:hk', 'jp:jp', 'us:us', 'n01:n01', 'n02:n02', 'n03:n03', 'n04:n04'])
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        // Bun 不会自动初始化 socket.data；缺这一步 data 回调里访问 socket.data 会抛错并静默断开
        ;(socket as any).data = { buf: Buffer.alloc(0), headDone: false, up: null, pending: null }
      },
      data(socket, data) {
        const st = socket.data as any
        if (!st) return
        if (!st.buf) st.buf = Buffer.alloc(0)
        st.buf = Buffer.concat([st.buf, Buffer.from(data)])
        if (!st.headDone && st.buf.includes('\r\n\r\n')) {
          st.headDone = true
          const head = st.buf.toString('latin1')
          const first = head.split('\r\n')[0]!
          log.push(first)
          const auth = /proxy-authorization:\s*basic\s+(\S+)/i.exec(head)
          const cred = auth ? Buffer.from(auth[1]!, 'base64').toString('utf8') : ''
          if (!accepted.has(cred)) {
            socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="upstream"\r\nContent-Length: 0\r\n\r\n')
            socket.end()
            return
          }
          if (/^CONNECT\s/i.test(first)) {
            const target = opts.forceTarget ?? first.split(/\s+/)[1]!
            const [host, p] = target.split(':')
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
            st.buf = Buffer.alloc(0)
            Bun.connect({
              hostname: host!,
              port: Number.parseInt(p!, 10),
              socket: {
                data(_up, d) {
                  socket.write(d)
                },
                close() {
                  socket.end()
                },
                error() {
                  socket.end()
                },
                connectError() {
                  socket.end()
                },
              },
            })
              .then((up) => {
                st.up = up
                if (st.pending && st.pending.length) {
                  up.write(st.pending)
                  st.pending = null
                }
              })
              .catch(() => socket.end())
            return
          }
          // 绝对 URI 形式：直接转发给目标
          const m = /^(GET|POST|PUT|DELETE|HEAD)\s+https?:\/\/([^\/\s]+)(\S*)/i.exec(first)
          if (m) {
            const target = m[2]!
            const [host, p] = target.split(':')
            Bun.connect({
              hostname: host!,
              port: Number.parseInt(p ?? '80', 10),
              socket: {
                open(up) {
                  const rewritten = head.replace(/^[A-Z]+\s+https?:\/\/[^\s]+/i, m[1] + ' ' + (m[3] || '/'))
                  up.write(rewritten)
                },
                data(_up, d) {
                  socket.write(d)
                },
                close() {
                  socket.end()
                },
                error() {
                  socket.end()
                },
              },
            }).catch(() => socket.end())
          }
          return
        }
        if (st.up) st.up.write(Buffer.from(data))
        else {
          st.pending = Buffer.concat([st.pending ?? Buffer.alloc(0), Buffer.from(data)])
        }
      },
      close(socket) {
        const st = socket.data as any
        try {
          st.up?.end()
        } catch {
          /* ignore */
        }
      },
      error() {
        /* ignore */
      },
    },
  })
  return { port, stop: () => server.stop(true), log }
}

export interface PanelHandle {
  port: number
  cookie: string
  proc: Bun.Subprocess
  stop: () => Promise<void>
  logs: () => string
}

export async function startPanel(opts: { settings?: Record<string, unknown>; dataDir?: string } = {}): Promise<PanelHandle> {
  const dataDir = opts.dataDir ?? DATA_DIR
  await rm(dataDir, { recursive: true, force: true })
  await mkdir(dataDir, { recursive: true })
  const bootstrap = {
    panel: { baseUrl: '127.0.0.1' },
    gateway: { listen: '0.0.0.0:' + PORTS.gateway, enabled: true },
    xray: {
      binary: XRAY_BIN,
      apiAddress: '127.0.0.1:' + PORTS.xrayApi,
      metricsListen: '127.0.0.1:' + PORTS.xrayMetrics,
      inboundPortStart: PORTS.poolStart,
      inboundPortEnd: PORTS.poolEnd,
      retireDelayMs: 1500,
      maintenanceWindow: '',
    },
    detect: {
      testUrl: 'http://127.0.0.1:' + PORTS.origin + '/generate_204',
      ipEchoUrls: ['http://127.0.0.1:' + PORTS.origin + '/geoip'],
      concurrency: 4,
      intervalSec: 3600,
      quarantineAfter: 3,
      recoverAfter: 2,
    },
    subsync: { concurrency: 2 },
    ...(opts.settings ?? {}),
  }
  const proc = Bun.spawn(['bun', 'run', 'apps/server/src/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PANEL_PORT: String(PORTS.panel),
      ADMIN_PASSWORD: 'verify-admin',
      XRAY_BINARY: XRAY_BIN,
      XCP_BOOTSTRAP_SETTINGS: JSON.stringify(bootstrap),
      LOG_LEVEL: 'info',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let out = ''
  void (async () => {
    for await (const c of proc.stdout as AsyncIterable<Uint8Array>) out += Buffer.from(c).toString('utf8')
  })()
  void (async () => {
    for await (const c of proc.stderr as AsyncIterable<Uint8Array>) out += Buffer.from(c).toString('utf8')
  })()

  const deadline = Date.now() + 45_000
  let healthy = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:' + PORTS.panel + '/api/health')
      if (res.ok) {
        const h = (await res.json()) as any
        if (h?.xray?.pid) {
          healthy = true
          break
        }
      }
    } catch {
      /* 尚未就绪 */
    }
    await sleep(300)
  }
  if (!healthy) throw new Error('面板未在 45s 内就绪（或数据面未成功拉起，可能存在幽灵 xray）\n' + out)

  const login = await fetch('http://localhost:' + PORTS.panel + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'verify-admin' }),
  })
  if (!login.ok) throw new Error('登录失败: ' + (await login.text()))
  const setCookie = login.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]!

  return {
    port: PORTS.panel,
    cookie,
    proc,
    logs: () => out,
    stop: async () => {
      // 关键：面板是被 SIGKILL 的，其 Xray 子进程不会自动退出，
      // 会在 API 端口上变成「幽灵数据面」，导致下一轮测试对着旧实例发指令。
      // 因此先按 health.pid 精确杀掉数据面，再兜底清理。
      try {
        const h = (await fetch('http://localhost:' + PORTS.panel + '/api/health').then((r) => r.json())) as any
        const pid = h?.xray?.pid
        if (pid) await killPid(pid)
      } catch {
        /* 面板可能已经不可达 */
      }
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      await sleep(500)
      await killXrayProcesses()
    },
  }
}

export async function killPid(pid: number): Promise<void> {
  try {
    await Bun.spawn(['taskkill', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' }).exited
  } catch {
    /* ignore */
  }
}

/** 清理所有 xray 进程（仅验收脚本使用；避免幽灵数据面） */
export async function killXrayProcesses(): Promise<void> {
  for (const image of ['xray.exe', 'xray']) {
    try {
      await Bun.spawn(['taskkill', '/F', '/IM', image], { stdout: 'ignore', stderr: 'ignore' }).exited
    } catch {
      /* 非 Windows 或不存在 */
    }
  }
  // 等待端口真正释放
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await portFree(PORTS.xrayApi)) return
    await sleep(250)
  }
}

export async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('x') })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

export interface Api {
  get: (path: string) => Promise<any>
  post: (path: string, body?: unknown) => Promise<any>
  patch: (path: string, body?: unknown) => Promise<any>
  del: (path: string) => Promise<any>
  raw: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
}

export function makeApi(panel: PanelHandle, opts: { bearer?: string } = {}): Api {
  const base = 'http://localhost:' + panel.port
  const raw = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {}
    if (opts.bearer) headers['authorization'] = 'Bearer ' + opts.bearer
    else headers['cookie'] = panel.cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: parsed }
  }
  return {
    raw,
    get: async (p) => (await raw('GET', p)).body,
    post: async (p, b) => (await raw('POST', p, b)).body,
    patch: async (p, b) => (await raw('PATCH', p, b)).body,
    del: async (p) => (await raw('DELETE', p)).body,
  }
}

export async function waitJob(api: Api, jobId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await api.get('/api/jobs/' + jobId)
    if (job.status === 'ok' || job.status === 'failed' || job.status === 'cancelled') return job
    await sleep(250)
  }
  throw new Error('任务超时: ' + jobId)
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v as T
      last = v
    } catch (e) {
      last = e
    }
    await sleep(200)
  }
  throw new Error('等待超时: ' + label + ' last=' + JSON.stringify(last))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 直接用 xray api 读数据面（独立于控制面的对账通道，用于交叉验证） */
export async function xrayApi(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // Go 的 flag 解析在遇到第一个非 flag 参数后停止：--server 必须紧跟子命令，放在文件参数之前。
  const [sub, ...rest] = args
  const proc = Bun.spawn([XRAY_BIN, 'api', sub!, '--server=127.0.0.1:' + PORTS.xrayApi, ...rest], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

export async function xrayApiTags(kind: 'lso' | 'lsi'): Promise<string[]> {
  const r = await xrayApi([kind])
  try {
    const j = JSON.parse(r.stdout) as any
    const list = kind === 'lso' ? j.outbounds : j.inbounds
    return (list ?? []).map((x: any) => x.tag)
  } catch {
    return []
  }
}


export function ensureXray(): void {
  if (!existsSync(XRAY_BIN)) {
    throw new Error('未找到 Xray 二进制：' + XRAY_BIN + '（可设置 XRAY_BINARY 环境变量）')
  }
}

/** 通过网关建一条隧道（HTTP CONNECT + Basic 认证），返回 socket 句柄 */
export interface Tunnel {
  socket: any
  data: Buffer[]
  write: (s: string) => void
  close: () => void
  bytes: () => number
}

export async function openTunnel(username: string, password: string, target: string, host = '127.0.0.1', port = PORTS.gateway): Promise<Tunnel> {
  const chunks: Buffer[] = []
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_s, d) {
        chunks.push(Buffer.from(d))
      },
      error() {
        /* ignore */
      },
      close() {
        /* ignore */
      },
    },
  })
  const auth = Buffer.from(username + ':' + password).toString('base64')
  socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\nProxy-Authorization: Basic ' + auth + '\r\n\r\n')
  // 等待 200 Connection established
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const text = Buffer.concat(chunks).toString('latin1')
    if (text.includes('\r\n\r\n')) break
    await sleep(50)
  }
  return {
    socket,
    data: chunks,
    write: (s: string) => socket.write(s),
    close: () => socket.end(),
    bytes: () => chunks.reduce((a, c) => a + c.length, 0),
  }
}
