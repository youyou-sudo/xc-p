/**
 * 网关模块测试（IMPL-CONTRACTS.md §3）。
 * 用假 deps + 一个假的「环回入站」（HTTP CONNECT 回显服务器）验证
 * 407/429/200、SOCKS5 成功与失败、kick、并发上限、字节统计、TLS 包装、selfCheck。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import type { Socket } from 'bun'
import { Gateway } from '../src/gateway/server'
import type { ConnectionRow, GatewayConfig, GatewayDeps, RouteTarget } from '../src/gateway/types'

// ---------------------------------------------------------------- 测试基础设施

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
})

/**
 * 取一个空闲端口。
 * 注意：Bun 1.4/Windows 上 Bun.listen({port:0}) 可能分配到一个仍被上一个
 * listener 占用的端口，导致客户端连到旧监听器。这里改用固定范围内的单调递增端口。
 */
let portSeq = Math.floor(Math.random() * 20_000)
function freePort(): number {
  for (let i = 0; i < 500; i++) {
    const port = 20_000 + ((portSeq + i) % 40_000)
    try {
      const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
      probe.stop(true)
      portSeq += i + 1
      return port
    } catch {
      /* 被占用，换下一个 */
    }
  }
  throw new Error('无法分配空闲端口')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(stepMs)
  }
  return pred()
}

const CRLF = '\r\n'

const MASK = 0x5a
const HTTP_PREAMBLE = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')

function mask(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]! ^ MASK
  return out
}

interface FakeInboundState {
  header: Buffer
  tunnel: boolean
  /** 记录收到的请求行（含 CONNECT 行） */
  requestLine: string
}

/**
 * 假「环回入站」：Bun.listen 上的最小 HTTP CONNECT 服务器。
 * - CONNECT：回 200 后把隧道内字节逐字异或回显（模拟 Xray http 入站 + 出口）
 * - 非 CONNECT：整个 HTTP 请求原样异或回显（用于绝对 URI 转发验证）
 */
function startFakeInbound(): { port: number; state: { hits: number; lastRequestLine: string; lastHeader: string } } {
  const shared = { hits: 0, lastRequestLine: '', lastHeader: '' }
  const listener = Bun.listen<FakeInboundState>({
    hostname: '127.0.0.1',
    port: freePort(),
    socket: {
      open(socket) {
        socket.data = { header: Buffer.alloc(0), tunnel: false, requestLine: '' }
      },
      data(socket, data: Buffer) {
        const st = socket.data
        const chunk = Buffer.from(data)
        if (st.tunnel) {
          socket.write(mask(chunk))
          return
        }
        st.header = st.header.length ? Buffer.concat([st.header, chunk]) : chunk
        const idx = st.header.indexOf('\r\n\r\n')
        if (idx < 0) return
        st.tunnel = true
        st.requestLine = st.header.subarray(0, st.header.indexOf('\r\n')).toString()
        shared.hits++
        shared.lastRequestLine = st.requestLine
        shared.lastHeader = st.header.subarray(0, idx).toString()
        const rest = st.header.subarray(idx + 4)
        const head = st.requestLine.startsWith('CONNECT ')
          ? 'HTTP/1.1 200 Connection Established\r\n\r\n'
          : 'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nproxied!'
        // 单次写入，保证「响应头 + 回显」在一个 TCP 段里（贴近真实 Xray 行为）
        socket.write(Buffer.concat([Buffer.from(head), rest.length > 0 ? mask(rest) : Buffer.alloc(0)]))
      },
      close() {},
    },
  })
  cleanups.push(() => listener.stop(true))
  return { port: listener.port, state: shared }
}

interface Control {
  onOpen: Array<{ id: number; info: { nodeId: string; username: string; clientIp: string; protocol: 'http' | 'socks5'; target: string } }>
  onClose: Array<{ id: number; reason: string; up: number; down: number }>
  onBytes: Array<{ id: number; up: number; down: number }>
  attempts: string[]
  successes: string[]
  failures: string[]
  selfcheckRoute: number | null
  selfcheckUser: string
  logs: string[]
  route: Map<string, RouteTarget>
  password: Map<string, string>
  deps: GatewayDeps
}

type ConfigOverrides = Partial<Omit<GatewayConfig, 'tls' | 'protocols'>> & {
  tls?: Partial<GatewayConfig['tls']>
  protocols?: Partial<GatewayConfig['protocols']>
}

function makeControl(listen: string, overrides: ConfigOverrides = {}): Control {
  const cfg: GatewayConfig = {
    enabled: true,
    listen,
    authMode: 'strict',
    maxConcurrentPerUser: 64,
    maxConcurrentPerIp: 256,
    idleTimeoutSec: 300,
    dialTimeoutMs: 1000,
    authFailBanCount: 20,
    authFailBanSec: 300,
    ...overrides,
    tls: { enabled: false, certFile: '', keyFile: '', ...(overrides.tls ?? {}) },
    protocols: { http: true, socks5: true, ...(overrides.protocols ?? {}) },
  }
  const c: Control = {
    onOpen: [],
    onClose: [],
    onBytes: [],
    attempts: [],
    successes: [],
    failures: [],
    selfcheckRoute: null,
    selfcheckUser: '__selfcheck__',
    logs: [],
    route: new Map(),
    password: new Map(),
    deps: undefined as unknown as GatewayDeps,
  }
  c.deps = {
    getConfig: () => cfg,
    resolveRoute(username: string): RouteTarget | undefined {
      if (username === c.selfcheckUser && c.selfcheckRoute !== null) {
        return { nodeId: 'selfcheck', port: c.selfcheckRoute }
      }
      return c.route.get(username)
    },
    verifyCredential(username: string, password: string): boolean {
      if (!c.route.has(username)) return false
      return c.password.get(username) === password
    },
    isBanned: () => false,
    onAuthFailure(ip: string) {
      c.failures.push(ip)
    },
    onAuthSuccess(ip: string) {
      c.successes.push(ip)
    },
    onOpen(info) {
      const id = c.onOpen.length + 1
      c.onOpen.push({ id, info })
      return id
    },
    onClose(id, reason, up, down) {
      c.onClose.push({ id, reason, up, down })
    },
    onBytes(id, up, down) {
      c.onBytes.push({ id, up, down })
    },
    log(level, msg) {
      c.logs.push(level + ':' + msg)
    },
  }
  return c
}

function startGateway(c: Control): Gateway {
  const gw = new Gateway(c.deps)
  cleanups.push(() => {
    try {
      gw.stop()
    } catch {
      /* ignore */
    }
  })
  gw.start()
  return gw
}

const FAKE_PREAMBLE = HTTP_PREAMBLE.length

/** 去掉假环回入站的 HTTP 响应头，只留隧道载荷 */
function bodyOf(buf: Buffer): Buffer {
  const idx = buf.indexOf('\r\n\r\n')
  if (idx < 0) return buf
  return Buffer.from(buf.subarray(idx + 4))
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

// ------------------------------------------------------------------ HTTP 客户端

interface HttpResult {
  text: string
  payload: Buffer
  closed: boolean
}

function httpConnect(
  port: number,
  headers: string[],
  opts: {
    payload?: Buffer
    onOpenHook?: (s: Socket<{ buf: Buffer }>) => void
    closeAfterReply?: boolean
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let sawHead = false
    let text = ''
    let payload = Buffer.alloc(0)
    let closed = false
    let sock: Socket<{ buf: Buffer }> | null = null
    const expected = opts.payload ? FAKE_PREAMBLE + opts.payload.length : 0
    const timer = setTimeout(() => settle(), opts.payload ? 1500 : 4000)
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.closeAfterReply) {
        try {
          sock?.end()
        } catch {
          /* ignore */
        }
      }
      resolve({ text, payload, closed })
    }
    Bun.connect<{ buf: Buffer }>({
      hostname: '127.0.0.1',
      port,
      socket: {
        binaryType: 'buffer',
        open(s) {
          sock = s
          s.data = { buf: Buffer.alloc(0) }
          if (opts.onOpenHook) {
            opts.onOpenHook(s)
            return
          }
          s.write(`CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n${headers.join('\r\n')}\r\n\r\n`)
          if (opts.payload) s.write(opts.payload)
        },
        data(s, data: Buffer) {
          const chunk = Buffer.from(data)
          if (!sawHead) {
            s.data.buf = Buffer.concat([s.data.buf, chunk])
            const idx = s.data.buf.indexOf('\r\n\r\n')
            if (idx < 0) return
            sawHead = true
            text = s.data.buf.subarray(0, idx).toString()
            payload = Buffer.from(s.data.buf.subarray(idx + 4))
            if (/^(HTTP\/1\.1 (407|429|502|400)|HTTP\/1\.1 200)/.test(text) && expected === 0) {
              setTimeout(settle, 30)
            }
            return
          }
          payload = Buffer.concat([payload, chunk])
          if (expected > 0 && payload.length >= expected) settle()
        },
        close() {
          closed = true
          settle()
        },
        error() {
          closed = true
          settle()
        },
        connectError(_s, e) {
          clearTimeout(timer)
          reject(e)
        },
        drain() {},
      },
    }).catch(reject)
  })
}

interface Socks5Result {
  reply: Buffer
  payload: Buffer
  closed: boolean
  /** 收到的全部原始字节（调试用） */
  all: Buffer
}

/**
 * SOCKS5 客户端：greeting → 方法选择 → RFC1929 → CONNECT → 可选负载。
 * 认证成功后立即发送（可选）负载（乐观数据），再按固定布局解析应答：
 *   应答(10) + 环回入站 HTTP 响应头(39) + 回显
 * 错误路径没有响应头，布局退化为：前 4 字节(方法/认证应答) + 应答(10)。
 */
function socks5Connect(
  port: number,
  opts: {
    user?: string
    pass?: string
    cmd?: number
    target?: Buffer
    payload?: Buffer
    combined?: boolean
  } = {},
): Promise<Socks5Result> {
  const user = opts.user ?? 'nodeA'
  const pass = opts.pass ?? 'pw-A'
  const cmd = opts.cmd ?? 0x01
  const target = opts.target ?? Buffer.from([0x03, 11, ...Buffer.from('example.com'), 0x00, 0x50])
  const payloadIn = opts.payload ?? Buffer.alloc(0)

  const u8 = Buffer.from(user)
  const p8 = Buffer.from(pass)
  const authMsg = Buffer.concat([Buffer.from([0x01, u8.length]), u8, Buffer.from([p8.length]), p8])
  const greeting = Buffer.from([0x05, 0x02, 0x00, 0x02])
  const request = Buffer.concat([Buffer.from([0x05, cmd, 0x00]), target])

  return new Promise((resolve, reject) => {
    let settled = false
    let gotMethod = false
    let gotAuth = false
    let sentRequest = false
    let gotReply = false
    let payloadSent = false
    let reply = Buffer.alloc(0)
    let echo = Buffer.alloc(0)
    let bytes = Buffer.alloc(0)
    let buf = Buffer.alloc(0)
    let waiter: ReturnType<typeof setInterval> | null = null
    const startedAt = Date.now()
    const timer = setTimeout(() => done(), 4000)

    function done(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (waiter) clearInterval(waiter)
      resolve({ reply, payload: echo, closed: false, all: bytes })
    }
    function failReply(): void {
      if (reply.length > 0) reply = Buffer.from(reply.subarray(0, 2))
      done()
    }
    /** 等待更多字节（响应头/回显可能后到），到期后按固定布局对齐收尾 */
    function waitMore(): void {
      if (waiter) return
      waiter = setInterval(() => {
        if (Date.now() - startedAt > 2200) {
          if (!gotReply && bytes.length >= 12) {
            const h = bytes.indexOf(HTTP_PREAMBLE)
            const base = h >= 0 ? h - 10 : 4
            const echoStart = h >= 0 ? h + HTTP_PREAMBLE.length : base + 10
            reply = Buffer.from(bytes.subarray(base, base + 10))
            echo = Buffer.from(bytes.subarray(echoStart))
          }
          done()
          return
        }
        if (!gotReply && bytes.length >= 12) {
          const h = bytes.indexOf(HTTP_PREAMBLE)
          const base = h >= 0 ? h - 10 : 4
          const re = Buffer.from(bytes.subarray(base, base + 10))
          if (re.length === 10 && re[0] === 0x05) {
            const echoStart = h >= 0 ? h + HTTP_PREAMBLE.length : base + 10
            reply = re
            echo = Buffer.from(bytes.subarray(echoStart))
            gotReply = true
          }
        }
        if (gotReply && payloadIn.length > 0 && echo.indexOf(mask(payloadIn)) >= 0) done()
      }, 20)
    }

    Bun.connect<Record<string, never>>({
      hostname: '127.0.0.1',
      port,
      socket: {
        binaryType: 'buffer',
        open(s) {
          s.data = {}
          s.write(opts.combined ? Buffer.concat([greeting, authMsg, request]) : greeting)
        },
        data(s, chunk: Buffer) {
          bytes = Buffer.concat([bytes, Buffer.from(chunk)])
          buf = Buffer.concat([buf, Buffer.from(chunk)])

          if (!gotMethod) {
            if (buf.length < 2) return
            if (buf[0] !== 0x05) {
              // 非 SOCKS5 应答（例如协议被关闭时网关回的 HTTP 400）：多等一点再收
              reply = Buffer.from(buf.subarray(0, Math.min(buf.length, 16)))
              done()
              return
            }
            const method = buf[1]!
            buf = Buffer.from(buf.subarray(2))
            if (method !== 0x02) {
              reply = Buffer.from([0x05, method])
              done()
              return
            }
            gotMethod = true
            if (!opts.combined) s.write(authMsg)
          }
          if (!gotAuth) {
            if (buf.length < 2) return
            if (buf[0] !== 0x01) {
              reply = Buffer.from(buf.subarray(0, 2))
              done()
              return
            }
            const status = buf[1]!
            buf = Buffer.from(buf.subarray(2))
            if (status !== 0x00) {
              reply = Buffer.from([0x01, status])
              done()
              return
            }
            gotAuth = true
            if (!opts.combined) s.write(request)
            sentRequest = true
          }
          if (sentRequest && !gotReply) {
            // 成功路径布局：应答(10) + 环回入站 HTTP 响应头(39) + 回显
            // 错误路径布局：方法应答(2) + 认证应答(2) + 应答(10)
            const h = bytes.indexOf(HTTP_PREAMBLE)
            const base = h >= 0 ? h - 10 : 4
            const echoStart = h >= 0 ? h + HTTP_PREAMBLE.length : base + 10
            if (bytes.length - base < 10) {
              waitMore()
              return
            }
            reply = Buffer.from(bytes.subarray(base, base + 10))
            echo = Buffer.from(bytes.subarray(echoStart))
            gotReply = true
            if (reply[1] !== 0x00) {
              failReply()
              return
            }
            if (payloadIn.length === 0) {
              done()
              return
            }
            if (!payloadSent) {
              payloadSent = true
              // 等网关把 CONNECT 请求转发到环回入站（进入隧道态）后再发负载
              setTimeout(() => {
                if (!settled) s.write(payloadIn)
              }, 60)
            }
            if (echo.indexOf(mask(payloadIn)) >= 0) done()
            else waitMore()
            return
          }
          if (gotReply) {
            // 已拿到应答：后续到达的字节都算回显
            const h = bytes.indexOf(HTTP_PREAMBLE)
            const echoStart = h >= 0 ? h + HTTP_PREAMBLE.length : 4 + 10
            echo = Buffer.from(bytes.subarray(echoStart))
          }
        },
        close() {
          if (!gotReply && bytes.length >= 12) {
            const h = bytes.indexOf(HTTP_PREAMBLE)
            const base = h >= 0 ? h - 10 : 4
            const echoStart = h >= 0 ? h + HTTP_PREAMBLE.length : base + 10
            reply = Buffer.from(bytes.subarray(base, base + 10))
            echo = Buffer.from(bytes.subarray(echoStart))
            gotReply = true
          }
          done()
        },
        error() {
          done()
        },
        connectError(_s, e) {
          clearTimeout(timer)
          reject(e)
        },
        drain() {},
      },
    }).catch(reject)
  })
}

// ---------------------------------------------------------------- HTTP 代理用例

describe('HTTP 代理', () => {
  test('缺少凭据 → 407 + Proxy-Authenticate', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)

    const r = await httpConnect(port(c), [])
    expect(r.text.startsWith('HTTP/1.1 407')).toBe(true)
    expect(r.text.toLowerCase()).toContain('proxy-authenticate: basic realm="xc-p"')
    expect(inbound.state.hits).toBe(0)
    expect(c.failures.length).toBe(1)
  })

  test('错误密码 → 407；Authorization 头也接受', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)

    const bad = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'WRONG')])
    expect(bad.text.startsWith('HTTP/1.1 407')).toBe(true)

    const good = await httpConnect(port(c), ['Authorization: ' + basic('nodeA', 'pw-A')])
    expect(good.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(c.successes.length).toBe(1)
    expect(c.failures.length).toBe(1)
  })

  test('CONNECT 成功 → 200 + 双向 splice + 字节统计', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const payload = Buffer.from('hello-through-gateway')
    const r = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], {
      payload,
      closeAfterReply: true,
    })
    expect(r.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(r.payload.equals(mask(payload))).toBe(true)

    // 环回入站收到的必须是原样的 CONNECT 请求（含认证头）
    expect(inbound.state.lastRequestLine).toBe('CONNECT example.com:80 HTTP/1.1')
    expect(inbound.state.lastHeader.toLowerCase()).toContain('proxy-authorization: basic ')

    const rows = gw.listConnections()
    expect(rows.length).toBe(1)
    expect(rows[0]!.nodeId).toBe('nodeA')
    expect(rows[0]!.username).toBe('nodeA')
    expect(rows[0]!.target).toBe('example.com:80')
    expect(rows[0]!.protocol).toBe('http')
    expect(rows[0]!.upBytes).toBeGreaterThan(payload.length)
    expect(rows[0]!.downBytes).toBe(FAKE_PREAMBLE + payload.length)

    const st = gw.stats()
    expect(st.activeConns).toBe(1)
    expect(st.activeByNode.nodeA).toBe(1)
    expect(st.totalOpened).toBe(1)
    expect(st.bytesUp).toBe(rows[0]!.upBytes)
    expect(st.bytesDown).toBe(FAKE_PREAMBLE + payload.length)

    const closed = await waitFor(() => gw.listConnections().length === 0)
    expect(closed).toBe(true)
    expect(c.onClose.length).toBe(1)
    expect(['client', 'remote']).toContain(c.onClose[0]!.reason)
    expect(c.onClose[0]!.up).toBe(rows[0]!.upBytes)
    expect(c.onClose[0]!.down).toBe(FAKE_PREAMBLE + payload.length)
    expect(gw.stats().totalClosed).toBe(1)
  })

  test('绝对 URI（GET http://...）原样转发', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const r = await new Promise<{ text: string; body: string }>((resolve, reject) => {
      let buf = Buffer.alloc(0)
      const settle = (body: string) => resolve({ text: buf.toString(), body })
      const timer = setTimeout(() => settle(''), 3000)
      Bun.connect<{ buf: Buffer }>({
        hostname: '127.0.0.1',
        port: port(c),
        socket: {
          binaryType: 'buffer',
          open(s) {
            s.data = { buf: Buffer.alloc(0) }
            s.write(
              `GET http://example.com/hello HTTP/1.1\r\nHost: example.com\r\n` +
                `Proxy-Authorization: ${basic('nodeA', 'pw-A')}\r\n\r\n`,
            )
          },
          data(_s, data: Buffer) {
            buf = Buffer.concat([buf, Buffer.from(data)])
            if (buf.indexOf('proxied!') >= 0) {
              clearTimeout(timer)
              settle('proxied!')
            }
          },
          error() {
            settle('')
          },
          connectError(_s, e) {
            clearTimeout(timer)
            reject(e)
          },
        },
      }).catch(reject)
    })

    expect(r.body).toBe('proxied!')
    expect(inbound.state.lastRequestLine).toBe('GET http://example.com/hello HTTP/1.1')
    expect(gw.stats().activeConns).toBe(1)
    const rows = gw.listConnections()
    expect(rows[0]!.target).toBe('example.com:80')
    await waitFor(() => gw.listConnections().length === 0)
  })

  test('上游连接失败 → 502', async () => {
    const deadPort = freePort() // 未监听
    const c = makeControl('127.0.0.1:' + freePort(), { dialTimeoutMs: 800 })
    c.route.set('dead', { nodeId: 'dead', port: deadPort })
    c.password.set('dead', 'pw')
    const gw = startGateway(c)

    const r = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('dead', 'pw')])
    expect(r.text.startsWith('HTTP/1.1 502')).toBe(true)
    expect(gw.listConnections().length).toBe(0)
    expect(c.onClose.length).toBe(0)
  })

  test('超过每用户并发上限 → 429', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { maxConcurrentPerUser: 1 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const first = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], {
      payload: Buffer.from('keep-open'),
    })
    expect(first.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(await waitFor(() => gw.listConnections().length === 1)).toBe(true)

    const second = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(second.text.startsWith('HTTP/1.1 429')).toBe(true)
  })

  test('超过每 IP 并发上限 → 429', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { maxConcurrentPerIp: 1 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const first = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(first.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(await waitFor(() => gw.listConnections().length === 1)).toBe(true)

    const second = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(second.text.startsWith('HTTP/1.1 429')).toBe(true)
  })

  test('连续认证失败达到阈值 → 封禁（stats.bannedIps）', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { authFailBanCount: 3, authFailBanSec: 60 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    for (let i = 0; i < 3; i++) {
      const r = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'bad')])
      expect(r.text.startsWith('HTTP/1.1 407')).toBe(true)
    }
    expect(gw.stats().bannedIps.length).toBe(1)
    // 封禁后即便凭据正确也被拒
    const banned = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(banned.text.startsWith('HTTP/1.1 407')).toBe(true)
    expect(inbound.state.hits).toBe(0)
  })

  test('空闲超时 → 自动断开', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { idleTimeoutSec: 1 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const r = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(r.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(await waitFor(() => gw.listConnections().length === 0, 4000)).toBe(true)
    expect(c.onClose.length).toBe(1)
    expect(c.onClose[0]!.reason).toBe('client')
  })

  test('协议开关：关闭 http 时代理请求被拒', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { protocols: { http: false, socks5: true } })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)

    const r = await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')])
    expect(r.text.startsWith('HTTP/1.1 400')).toBe(true)
    expect(inbound.state.hits).toBe(0)
  })

  test('gateway.enabled=false 时不监听', async () => {
    const p = freePort()
    const c = makeControl('127.0.0.1:' + p, { enabled: false })
    const gw = startGateway(c)
    expect(gw.stats().listen).toBe('127.0.0.1:' + p)
    expect(gw.listConnections().length).toBe(0)
    let refused = false
    try {
      await Bun.connect({ hostname: '127.0.0.1', port: p, socket: { data() {} } })
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })
})

// -------------------------------------------------------------- SOCKS5 用例

describe('SOCKS5 代理', () => {
  test('首字节 0x05 → SOCKS5；CONNECT 成功 + 字节统计', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const payload = Buffer.from('socks-payload')
    const r = await socks5Connect(port(c), { payload })
    expect(r.reply[0]).toBe(0x05)
    expect(r.reply[1]).toBe(0x00)
    expect(bodyOf(r.payload).equals(mask(payload))).toBe(true)

    // 环回侧的请求必须是 HTTP CONNECT（每个环回入站都是 http 协议）
    expect(inbound.state.lastRequestLine).toBe('CONNECT example.com:80 HTTP/1.1')
    const rows = gw.listConnections()
    expect(rows.length).toBe(1)
    expect(rows[0]!.protocol).toBe('socks5')
    expect(rows[0]!.target).toBe('example.com:80')
    expect(rows[0]!.downBytes).toBe(FAKE_PREAMBLE + payload.length)
    expect(gw.stats().bytesDown).toBe(FAKE_PREAMBLE + payload.length)
    await waitFor(() => gw.listConnections().length === 0)
  })

  test('greeting+认证+请求合并到一个 TCP 段也能处理', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const payload = Buffer.from('combined-segment')
    const r = await socks5Connect(port(c), { combined: true, payload })
    expect(r.reply[0]).toBe(0x05)
    expect(r.reply[1]).toBe(0x00)
    expect(bodyOf(r.payload).equals(mask(payload))).toBe(true)
    expect(gw.listConnections().length).toBe(1)
    await waitFor(() => gw.listConnections().length === 0)
  })

  test('错误密码 → 0x01 失败', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)

    const r = await socks5Connect(port(c), { pass: 'WRONG' })
    expect(r.reply[0]).toBe(0x01)
    expect(r.reply[1]).toBe(0x01)
    expect(inbound.state.hits).toBe(0)
    expect(c.failures.length).toBe(1)
  })

  test('未知用户名 → 0x01 失败', async () => {
    const c = makeControl('127.0.0.1:' + freePort())
    startGateway(c)
    const r = await socks5Connect(port(c), { user: 'nobody', pass: 'x' })
    expect(r.reply[0]).toBe(0x01)
    expect(r.reply[1]).toBe(0x01)
  })

  test('UDP ASSOCIATE → 0x07 拒绝', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)

    const r = await socks5Connect(port(c), { cmd: 0x03 })
    expect(r.reply[0]).toBe(0x05)
    expect(r.reply[1]).toBe(0x07)
    expect(inbound.state.hits).toBe(0)
  })

  test('不支持的 CMD（BIND 0x02）→ 0x07', async () => {
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: freePort() })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)
    const r = await socks5Connect(port(c), { cmd: 0x02 })
    expect(r.reply[1]).toBe(0x07)
  })

  test('上游失败 → 通用失败码 0x01', async () => {
    const c = makeControl('127.0.0.1:' + freePort(), { dialTimeoutMs: 600 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: freePort() })
    c.password.set('nodeA', 'pw-A')
    startGateway(c)
    const r = await socks5Connect(port(c))
    expect(r.reply[0]).toBe(0x05)
    expect(r.reply[1]).toBe(0x01)
  })

  test('关闭 socks5 时 0x05 首字节被拒', async () => {
    const c = makeControl('127.0.0.1:' + freePort(), { protocols: { http: true, socks5: false } })
    startGateway(c)
    const r = await socks5Connect(port(c))
    // 网关按 HTTP 语义回 400 并关闭（响应不是 SOCKS5 报文）
    expect(r.reply[0]).not.toBe(0x05)
    expect(r.reply.toString('latin1').startsWith('HTTP/1.1 400')).toBe(true)
  })

  test('每用户并发上限 → SOCKS5 通用失败码', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { maxConcurrentPerUser: 1 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const first = await socks5Connect(port(c), { payload: Buffer.from('hold') })
    expect(first.reply[1]).toBe(0x00)
    expect(await waitFor(() => gw.listConnections().length === 1)).toBe(true)

    const second = await socks5Connect(port(c))
    expect(second.reply[0]).toBe(0x05)
    expect(second.reply[1]).toBe(0x01)
  })
})

// ------------------------------------------------------------ kick / 统计 / 自检

describe('连接表、kick 与自检', () => {
  test('listConnections + kick(username) + onClose(reason=kicked)', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    const payload = Buffer.from('stay-alive')
    const client = httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], { payload })
    expect(await waitFor(() => gw.listConnections().length === 1)).toBe(true)

    const rows = gw.listConnections() as ConnectionRow[]
    expect(rows[0]!.id).toBe(1)
    expect(rows[0]!.startedAt).toBeLessThanOrEqual(Date.now())

    const n = gw.kick((r) => r.username === 'nodeA')
    expect(n).toBe(1)
    expect(gw.listConnections().length).toBe(0)

    const res = await client
    expect(res.closed || res.text.startsWith('HTTP/1.1 200')).toBe(true)
    expect(c.onClose.length).toBe(1)
    expect(c.onClose[0]!.reason).toBe('kicked')
    expect(gw.kick(() => true)).toBe(0)
  })

  test('stats 汇总（按节点/IP、失败计数、字节）', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort())
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.route.set('nodeB', { nodeId: 'nodeB', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    c.password.set('nodeB', 'pw-B')
    const gw = startGateway(c)

    await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], {
      payload: Buffer.from('a'),
    })
    await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeB', 'pw-B')], {
      payload: Buffer.from('bb'),
    })
    await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'nope')])
    expect(await waitFor(() => gw.listConnections().length === 2)).toBe(true)
    // 主动断开全部，确保后续测试不受影响

    const st = gw.stats()
    expect(st.activeByNode.nodeA).toBe(1)
    expect(st.activeByNode.nodeB).toBe(1)
    expect(Object.keys(st.activeByIp).length).toBe(1)
    expect(st.activeByIp['127.0.0.1']).toBe(2)
    expect(st.authFailures5m).toBe(1)
    expect(st.bannedIps).toEqual([])
    expect(st.bytesUp).toBeGreaterThan(0)
    expect(st.bytesDown).toBe(2 * FAKE_PREAMBLE + 3)
  })

  test('onBytes 回调周期性上报增量', async () => {
    const inbound = startFakeInbound()
    const c = makeControl('127.0.0.1:' + freePort(), { idleTimeoutSec: 1 })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)

    await httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], {
      payload: Buffer.from('xyz'),
    })
    expect(await waitFor(() => gw.listConnections().length === 0, 4000)).toBe(true)
    // 手动触发一次字节快照
    const anyGw = gw as unknown as { flushBytes(): void }
    const second = httpConnect(port(c), ['Proxy-Authorization: ' + basic('nodeA', 'pw-A')], {
      payload: Buffer.from('12345'),
    })
    expect(await waitFor(() => gw.listConnections().length === 1)).toBe(true)
    anyGw.flushBytes()
    await second
    expect(c.onBytes.length).toBeGreaterThanOrEqual(1)
    const last = c.onBytes[c.onBytes.length - 1]!
    expect(last.down).toBeGreaterThan(0)
    expect(last.up).toBeGreaterThan(0)
  })

  test('reconfigure 幂等 + 换端口重建 listener', () => {
    const p1 = freePort()
    const p2 = freePort()
    const inbound = startFakeInbound()
    const base = makeControl('127.0.0.1:' + p1)
    base.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    base.password.set('nodeA', 'pw-A')
    const gw = new Gateway(base.deps)
    cleanups.push(() => gw.stop())
    gw.start()
    gw.start() // 幂等
    expect(gw.stats().listen).toBe('127.0.0.1:' + p1)

    gw.reconfigure({ ...base.deps.getConfig(), listen: '127.0.0.1:' + p2 })
    expect(gw.stats().listen).toBe('127.0.0.1:' + p2)

    gw.stop()
    gw.stop() // 幂等
    expect(gw.stats().activeConns).toBe(0)
  })

  test('selfCheck 通过（临时凭据走完整链路）', async () => {
    const c = makeControl('127.0.0.1:' + freePort())
    const gw = startGateway(c)
    const ok = await gw.selfCheck()
    expect(ok).toBe(true)
    // 自检走完整链路（含 deps.onOpen / onClose），但结束后连接表清空
    expect(c.onOpen.length).toBe(1)
    expect(c.onOpen[0]!.info.username).toBe('__selfcheck__')
    expect(await waitFor(() => gw.listConnections().length === 0)).toBe(true)
  })

  test('selfCheck 在 listener 未启动时返回 false', async () => {
    const c = makeControl('127.0.0.1:' + freePort(), { enabled: false })
    const gw = new Gateway(c.deps)
    cleanups.push(() => gw.stop())
    expect(await gw.selfCheck()).toBe(false)
  })
})

// ------------------------------------------------------------------- TLS 包装

const TLS_CNF = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = xcp-test-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
`

const TLS_SERVER_CNF = `[server_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`

/** 生成一套可校验的 CA + 服务端证书（Bun 的 TLS 客户端无法与 node:tls 服务端交换应用数据，
 *  因此幂等测试用 node:tls 客户端配合 CA 校验）。 */
function makeCaSignedCert(openssl: string): { certFile: string; keyFile: string; caFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-gw-tls-'))
  const cnf = join(dir, 'ca.cnf')
  const serverCnf = join(dir, 'server.cnf')
  const caKey = join(dir, 'ca.key')
  const caPem = join(dir, 'ca.pem')
  const srvKey = join(dir, 'srv.key')
  const srvCsr = join(dir, 'srv.csr')
  const srvPem = join(dir, 'srv.pem')
  writeFileSync(cnf, TLS_CNF)
  writeFileSync(serverCnf, TLS_SERVER_CNF)
  const run = (args: string[]) => {
    const p = Bun.spawnSync([openssl, ...args])
    if (p.exitCode !== 0) throw new Error('openssl 失败: ' + p.stderr.toString())
  }
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caPem, '-days', '2', '-config', cnf])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', srvCsr, '-subj', '/CN=localhost'])
  run([
    'x509',
    '-req',
    '-in',
    srvCsr,
    '-CA',
    caPem,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    srvPem,
    '-days',
    '2',
    '-extfile',
    serverCnf,
    '-extensions',
    'server_ext',
  ])
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { certFile: srvPem, keyFile: srvKey, caFile: caPem }
}

function findOpenssl(): string | null {
  for (const exe of ['openssl']) {
    const p = Bun.spawnSync([exe, 'version'])
    if (p.exitCode === 0) return exe
  }
  return null
}

const openssl = findOpenssl()

describe('TLS 包装', () => {
  // 注意：Bun 1.4.3 的 TLS 客户端无法与 node:tls 服务端交换应用数据（已实测），
  // 因此这里用 node:tls 客户端 + CA 校验。
  test.skipIf(!openssl)('tls.enabled：TLS 客户端可完成 CONNECT 并转发', async () => {
    const inbound = startFakeInbound()
    const tls = makeCaSignedCert(openssl!)
    const c = makeControl('127.0.0.1:' + freePort(), {
      tls: { enabled: true, certFile: tls.certFile, keyFile: tls.keyFile },
    })
    c.route.set('nodeA', { nodeId: 'nodeA', port: inbound.port })
    c.password.set('nodeA', 'pw-A')
    const gw = startGateway(c)
    const ca = readFileSync(tls.caFile, 'utf8')

    const r = await new Promise<{ text: string; payload: Buffer; authorized: boolean }>(
      (resolve, reject) => {
        let head = ''
        let payload = Buffer.alloc(0)
        let sawHead = false
        let buf = Buffer.alloc(0)
        let authorized = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({ text: head, payload, authorized })
        }
        const timer = setTimeout(finish, 3000)
        const sock = connect({ host: '127.0.0.1', port: port(c), ca, servername: 'localhost' }, () => {
          authorized = sock.authorized
          sock.write(
            'CONNECT tls.example:443 HTTP/1.1' + CRLF + 'Host: tls.example:443' + CRLF +
              'Proxy-Authorization: ' + basic('nodeA', 'pw-A') + CRLF + CRLF,
          )
        })
        sock.on('data', (chunk: Buffer) => {
          const c2 = Buffer.from(chunk)
          if (!sawHead) {
            buf = Buffer.concat([buf, c2])
            const idx = buf.indexOf(CRLF + CRLF)
            if (idx < 0) return
            sawHead = true
            head = buf.subarray(0, idx).toString()
            payload = Buffer.from(buf.subarray(idx + 4))
            clearTimeout(timer)
            setTimeout(finish, 30)
            return
          }
          payload = Buffer.concat([payload, c2])
        })
        sock.on('error', (e: Error) => {
          clearTimeout(timer)
          reject(e)
        })
      },
    )

    expect(r.authorized).toBe(true)
    expect(r.text.startsWith('HTTP/1.1 200')).toBe(true)
    // TLS 路径下连接同样进入连接表（环回入站收到的是原样 CONNECT 请求）
    expect(gw.listConnections().length).toBe(1)
    expect(gw.listConnections()[0]!.nodeId).toBe('nodeA')
  }, 30_000)

  test('tls.enabled 但证书文件缺失 → start() 抛出可读错误', () => {
    const c = makeControl('127.0.0.1:' + freePort(), {
      tls: { enabled: true, certFile: join(tmpdir(), 'xcp-missing-cert.pem'), keyFile: 'x' },
    })
    const gw = new Gateway(c.deps)
    cleanups.push(() => gw.stop())
    expect(() => gw.start()).toThrow(/certFile/)
  })
})

function port(c: Control): number {
  return Number((c.deps.getConfig().listen || '').split(':').pop())
}
