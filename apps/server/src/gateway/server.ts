/**
 * L4 网关（PANEL.md §10.1，IMPL-CONTRACTS.md §3）。
 *
 * 单端口首字节分流：0x05 → SOCKS5，其余 → HTTP 代理。
 * 认证通过后与 127.0.0.1:<nodePort> 的 Xray http 入站建连，
 * 把原始 CONNECT 请求转发过去，之后双向 splice（不再解析内容），只统计上下行字节。
 */
import { readFileSync } from 'node:fs'
import type { Server as NodeServer, Socket as NodeSocket } from 'node:net'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import type { Socket, SocketHandler, TCPSocketListener } from 'bun'
import {
  HTTP_400,
  HTTP_407,
  HTTP_429,
  HTTP_502,
  SOCKS5_AUTH_VERSION,
  SOCKS5_CMD_CONNECT,
  SOCKS5_CMD_UDP_ASSOCIATE,
  SOCKS5_REP_ADDR_NOT_SUPPORTED,
  SOCKS5_REP_CMD_NOT_SUPPORTED,
  SOCKS5_REP_GENERAL_FAILURE,
  SOCKS5_REP_SUCCEEDED,
  SOCKS5_VERSION,
  buildConnectRequest,
  formatAddr,
  parseBasicCredential,
  parseSocks5Credential,
  splitListen,
  utf8,
  type CloseReason,
  type ConnectionRow,
  type Credential,
  type GatewayConfig,
  type GatewayDeps,
  type GatewayStats,
  type SessionSocket,
} from './types'

/** 会话状态机 */
type Phase = 'start' | 'auth' | 'http' | 'socks-request' | 'connecting' | 'tunnel' | 'closed'

/** 单条代理请求（一个客户端连接只处理一个） */
interface ProxyRequest {
  protocol: 'http' | 'socks5'
  /** 目标 host:port（CONNECT 行 / 绝对 URI 的 authority） */
  target: string
  /** 原样转发给环回入站的字节 */
  raw: Uint8Array
  /** 请求头之后紧跟的隧道数据 */
  rest: Uint8Array
}

/** 每个客户端连接的会话状态（网关侧持有，不放在 socket.data 上） */
interface SessionState {
  key: number
  /** deps.onOpen 返回的库内连接 ID；未进入隧道前为 0 */
  id: number
  phase: Phase
  client: SessionSocket
  remote: Socket<SessionState> | null
  clientIp: string
  username: string
  nodeId: string
  /** 认证后解析到的环回端口 */
  routePort: number
  target: string
  protocol: 'http' | 'socks5'
  startedAt: number
  lastActivityAt: number
  up: number
  down: number
  reportedUp: number
  reportedDown: number
  /** 未解析完的字节 */
  pending: Buffer | null
  socksGreeted: boolean
  socksAuthed: boolean
  /** 已回复过（407/429/502/400），忽略后续输入 */
  responded: boolean
  toRemoteQueue: Buffer[]
  toRemoteQueued: number
  toClientQueue: Buffer[]
  toClientQueued: number
  countIp: boolean
  countUser: boolean
  closed: boolean
  reason: CloseReason
  graceTimer: ReturnType<typeof setTimeout> | null
  /** 明文路径下底层 Bun socket（TLS 路径为 null） */
  raw: Socket<SessionState> | null
  /**
   * SOCKS5 专用：环回入站是 http 协议，会先回 "HTTP/1.1 200 Connection Established"。
   * 网关先读到这个响应头，确认隧道真的建立成功后才回 SOCKS5 成功码；
   * 响应原文随后照常转发给客户端（与真实 Xray http 入站行为一致）。
   * 非 null 表示正在等待/解析该响应头。
   */
  upstreamHead: Buffer | null
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const MAX_PENDING_HANDSHAKE = 64 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const BYTES_FLUSH_MS = 30_000
const SWEEP_MS = 1000

export class Gateway {
  private readonly deps: GatewayDeps
  private listener: TCPSocketListener<SessionState> | null = null
  private tlsListener: NodeServer | null = null
  private listening = false
  private cfg: GatewayConfig
  private currentListen = ''
  private sessions = new Map<number, SessionState>()
  private byIp = new Map<string, number>()
  private byUser = new Map<string, number>()
  private failures = new Map<string, number[]>()
  private bans = new Map<string, number>()
  /** 明文连接的 socket → 会话（不依赖 socket.data） */
  private sessionsBySocket = new WeakMap<Socket<SessionState>, SessionState>()
  /** selfCheck 期间使用的临时路由（用户名 → 自检回声端口） */
  private selfCheckRoute: { user: string; nodeId: string; port: number; expiresAt: number } | null =
    null
  private nextKey = 1
  private totalOpened = 0
  private totalClosed = 0
  private bytesUp = 0
  private bytesDown = 0
  private sweeper: ReturnType<typeof setInterval> | null = null
  private flusher: ReturnType<typeof setInterval> | null = null

  constructor(deps: GatewayDeps) {
    if (!deps) throw new Error('Gateway 需要 deps')
    this.deps = deps
    this.cfg = normalizeGatewayConfig(undefined)
  }

  /** 幂等；失败抛出可读错误 */
  start(): void {
    if (this.listening) return
    this.startWith(normalizeGatewayConfig(this.deps.getConfig()))
  }

  private startWith(cfg: GatewayConfig): void {
    if (this.listening) return
    this.cfg = cfg
    if (!cfg.enabled) {
      this.log('info', '网关未启用（gateway.enabled=false），未启动 listener')
      return
    }
    const { hostname, port } = splitListen(cfg.listen)
    const tls: { enabled: true; cert: string; key: string } | null = cfg.tls.enabled
      ? {
          enabled: true,
          cert: readTlsFile(cfg.tls.certFile, 'tls.certFile'),
          key: readTlsFile(cfg.tls.keyFile, 'tls.keyFile'),
        }
      : null

    if (tls) {
      // Bun 1.4 的 socket.upgradeTLS 不把事件转交给升级后的 socket，TLS 路径改用 node:tls
      const server = createTlsServer({ cert: tls.cert, key: tls.key, handshakeTimeout: 10_000 })
      server.on('secureConnection', (socket: TLSSocket) => this.attachClientSocket(socket))
      server.on('error', (e: Error) => this.log('error', '网关 TLS listener 错误: ' + e.message))
      server.listen(port, hostname)
      this.tlsListener = server
    } else {
      this.listener = Bun.listen<SessionState>({
        hostname,
        port,
        socket: this.clientHandlers(),
        allowHalfOpen: true,
      })
    }

    this.listening = true
    this.currentListen = cfg.listen
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    this.flusher = setInterval(() => this.flushBytes(), BYTES_FLUSH_MS)
    this.log('info', `网关已监听 ${cfg.listen}${tls ? '（TLS）' : ''}`)
  }

  /** 停止并关闭所有连接 */
  stop(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    if (this.flusher) {
      clearInterval(this.flusher)
      this.flusher = null
    }
    const server = this.listener
    this.listener = null
    const tlsServer = this.tlsListener
    this.tlsListener = null
    this.listening = false
    this.currentListen = ''
    if (server) {
      try {
        server.stop(true)
      } catch (e) {
        this.log('warn', '停止 listener 失败', errText(e))
      }
    }
    if (tlsServer) {
      try {
        tlsServer.close()
      } catch (e) {
        this.log('warn', '停止 TLS listener 失败', errText(e))
      }
    }
    for (const s of Array.from(this.sessions.values())) {
      this.finish(s, 'shutdown')
    }
    this.sessions.clear()
    this.byIp.clear()
    this.byUser.clear()
  }

  /** 配置变更后重建 listener（enabled/listen/TLS 变化时重建） */
  reconfigure(cfg: GatewayConfig): void {
    const next = normalizeGatewayConfig(cfg)
    const prev = this.cfg
    const needsRestart =
      this.listening !== next.enabled ||
      this.currentListen !== next.listen ||
      prev.tls.enabled !== next.tls.enabled ||
      prev.tls.certFile !== next.tls.certFile ||
      prev.tls.keyFile !== next.tls.keyFile
    this.cfg = next
    if (!this.listening) {
      if (next.enabled) this.start()
      return
    }
    if (needsRestart) {
      this.log('info', '网关配置变化，重建 listener')
      this.stop()
      // 用 reconfigure 传入的配置重建，避免再次读 deps（可能与数据库写入有时序差）
      this.startWith(next)
    }
  }

  /** 主动断开：predicate 返回 true 的连接被关闭，返回断开数量 */
  kick(pred: (c: ConnectionRow) => boolean): number {
    if (typeof pred !== 'function') return 0
    let n = 0
    for (const s of Array.from(this.sessions.values())) {
      if (s.closed) continue
      if (pred(this.rowOf(s))) {
        n++
        this.finish(s, 'kicked')
      }
    }
    if (n > 0) this.log('info', `已断开 ${n} 条连接`)
    return n
  }

  listConnections(): ConnectionRow[] {
    const out: ConnectionRow[] = []
    for (const s of this.sessions.values()) {
      if (s.closed) continue
      out.push(this.rowOf(s))
    }
    return out
  }

  stats(): GatewayStats {
    const activeByNode: Record<string, number> = {}
    const activeByIp: Record<string, number> = {}
    for (const s of this.sessions.values()) {
      if (s.closed || !s.nodeId) continue
      activeByNode[s.nodeId] = (activeByNode[s.nodeId] ?? 0) + 1
    }
    for (const [ip, n] of this.byIp) {
      if (n > 0) activeByIp[ip] = n
    }
    return {
      listen: this.currentListen || this.cfg.listen,
      activeConns: this.sessions.size,
      activeByNode,
      activeByIp,
      authFailures5m: this.recentFailureCount(),
      bannedIps: this.bannedIps(),
      totalOpened: this.totalOpened,
      totalClosed: this.totalClosed,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
    }
  }

  /**
   * 用一个临时用户名走完整链路自检（PANEL.md §14.2#5）：
   * 起一个本地环回回声目标 → 解析出它的端口 → 经网关发一次 CONNECT（username 由 deps.resolveRoute 路由到该端口）
   * → 校验回声 → 断开。自检连接不进入连接表与统计。
   */
  async selfCheck(username?: string): Promise<boolean> {
    if (!this.listening) {
      this.log('warn', '网关自检失败：listener 未启动')
      return false
    }
    const cfg = this.cfg
    const user = username ?? '__selfcheck__'
    const target = 'selfcheck.example:80'
    const payload = Buffer.from('xc-p-selfcheck')

    interface EchoState {
      header: Buffer
      tunnel: boolean
    }
    let echo: TCPSocketListener<EchoState> | null = null
    try {
      // 自检用的环回回声目标（HTTP CONNECT + 回显）
      echo = Bun.listen<EchoState>({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          open(socket) {
            socket.data = { header: Buffer.alloc(0), tunnel: false }
          },
          data(socket, data: Buffer) {
            const st = socket.data
            if (st.tunnel) {
              socket.write(data)
              return
            }
            st.header = Buffer.concat([st.header, Buffer.from(data)])
            const idx = st.header.indexOf('\r\n\r\n')
            if (idx < 0) return
            st.tunnel = true
            const rest = st.header.subarray(idx + 4)
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (rest.length > 0) socket.write(rest)
          },
          close() {},
        },
      })

      // 临时路由：让 deps.resolveRoute 认得的用户名指向自检端口（10s 后自动失效）
      const external = this.deps.resolveRoute(user)
      const echoPort = echo.port
      this.selfCheckRoute = {
        user,
        nodeId: external?.nodeId ?? 'selfcheck',
        port: echoPort,
        expiresAt: Date.now() + 10_000,
      }

      const gatewayPort = splitListen(this.currentListen || cfg.listen).port
      const timeoutMs = Math.max(1500, cfg.dialTimeoutMs * 2)
      return await new Promise<boolean>((resolve) => {
        let settled = false
        let client: Socket<{ buf: Buffer; echoed: boolean }> | null = null
        const settle = (ok: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try {
            client?.end()
          } catch {
            /* ignore */
          }
          resolve(ok)
        }
        const timer = setTimeout(() => settle(false), timeoutMs)
        Bun.connect<{ buf: Buffer; echoed: boolean }>({
          hostname: '127.0.0.1',
          port: gatewayPort,
          socket: {
            binaryType: 'buffer',
            open(s) {
              client = s
              s.data = { buf: Buffer.alloc(0), echoed: false }
              s.write(
                `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
                  `Proxy-Authorization: Basic ${Buffer.from(`${user}:selfcheck`).toString('base64')}\r\n\r\n`,
              )
            },
            data(s, data: Buffer) {
              s.data.buf = Buffer.concat([s.data.buf, Buffer.from(data)])
              if (!s.data.echoed) {
                const idx = s.data.buf.indexOf('\r\n\r\n')
                if (idx < 0) return
                const head = s.data.buf.subarray(0, idx).toString()
                if (!/^HTTP\/1\.1 200/.test(head)) {
                  settle(false)
                  return
                }
                s.data.echoed = true
                s.data.buf = Buffer.from(s.data.buf.subarray(idx + 4))
                s.write(payload)
              }
              if (s.data.echoed && s.data.buf.indexOf(payload) >= 0) settle(true)
            },
            close() {
              settle(false)
            },
            error() {
              settle(false)
            },
            connectError() {
              settle(false)
            },
          },
        }).catch(() => settle(false))
      })
    } catch (e) {
      this.log('warn', '网关自检异常', errText(e))
      return false
    } finally {
      this.selfCheckRoute = null
      try {
        echo?.stop(true)
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- 客户端事件

  /** 明文监听器（Bun.listen）的 socket 处理器 */
  private clientHandlers(): SocketHandler<SessionState> {
    return {
      open: (socket) => this.newBunSession(socket),
      data: (socket, data: Buffer) => {
        const s = this.sessionsBySocket.get(socket)
        if (!s || s.closed) return
        this.onClientData(s, data)
      },
      close: (socket) => {
        const s = this.sessionsBySocket.get(socket)
        if (s) this.finish(s, 'client')
      },
      end: (socket) => {
        const s = this.sessionsBySocket.get(socket)
        if (!s || s.closed) return
        this.onClientEnd(s)
      },
      error: (socket, error: Error) => {
        const s = this.sessionsBySocket.get(socket)
        if (!s || s.closed) return
        this.log('warn', `客户端连接错误: ${error?.message ?? error}`)
        this.finish(s, 'error')
      },
      drain: (socket) => {
        const s = this.sessionsBySocket.get(socket)
        if (!s || s.closed) return
        this.onClientDrain(s)
      },
    }
  }

  /** node:tls 连接：包装成 SessionSocket 后走与明文完全相同的状态机 */
  private attachClientSocket(socket: NodeSocket): void {
    const ip = socket.remoteAddress || '0.0.0.0'
    const s = this.newSession(ip)
    s.client = {
      get remoteAddress() {
        return ip
      },
      write: (buf: Uint8Array) => {
        socket.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
        return buf.byteLength
      },
      end: (buf?: Uint8Array) => {
        if (buf) socket.end(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
        else socket.end()
      },
      close: () => socket.destroy(),
    }
    try {
      socket.setNoDelay(true)
    } catch {
      /* 某些 TLSSocket 实现不支持 */
    }
    socket.on('data', (data: Buffer) => {
      if (s.closed) return
      this.onClientData(s, data)
    })
    socket.on('drain', () => {
      if (s.closed) return
      this.onClientDrain(s)
    })
    socket.on('end', () => {
      if (s.closed) return
      this.onClientEnd(s)
    })
    socket.on('close', () => this.finish(s, 'client'))
    socket.on('error', (e: Error) => {
      if (s.closed) return
      this.log('warn', `客户端连接错误: ${e.message}`)
      this.finish(s, 'error')
    })
  }

  /** 明文连接：包装 Bun.Socket 并登记会话（会话状态存在网关侧 WeakMap，不依赖 socket.data） */
  private newBunSession(socket: Socket<SessionState>): void {
    const s = this.newSession(socket.remoteAddress || '0.0.0.0')
    this.sessionsBySocket.set(socket, s)
    s.raw = socket
    s.client = {
      get remoteAddress() {
        return s.clientIp
      },
      write: (buf: Uint8Array) => socket.write(buf),
      end: (buf?: Uint8Array) => {
        if (buf) socket.end(buf)
        else socket.end()
      },
      close: () => socket.close(),
    }
    try {
      socket.setNoDelay(true)
      socket.setKeepAlive(true)
    } catch {
      /* ignore */
    }
  }

  /** 建立会话状态（明文路径与 TLS 路径共用） */
  private newSession(clientIp: string): SessionState {
    const now = Date.now()
    const s: SessionState = {
      key: this.nextKey++,
      id: 0,
      phase: 'start',
      client: null as unknown as SessionSocket,
      remote: null,
      clientIp,
      username: '',
      nodeId: '',
      routePort: 0,
      target: '',
      protocol: 'http',
      startedAt: now,
      lastActivityAt: now,
      up: 0,
      down: 0,
      reportedUp: 0,
      reportedDown: 0,
      pending: null,
      socksGreeted: false,
      socksAuthed: false,
      responded: false,
      toRemoteQueue: [],
      toRemoteQueued: 0,
      toClientQueue: [],
      toClientQueued: 0,
      countIp: false,
      countUser: false,
      closed: false,
      reason: 'client',
      graceTimer: null,
      upstreamHead: null,
      raw: null,
    }
    this.sessions.set(s.key, s)
    this.totalOpened++
    return s
  }

  private onClientData(s: SessionState, data: Buffer): void {
    if (s.closed || s.responded) return
    s.lastActivityAt = Date.now()
    try {
      if (s.phase === 'tunnel') {
        this.pumpToRemote(s, data)
        return
      }
      if (s.phase === 'connecting') return // 隧道未建立前的数据由 pending 兜底（见 beginConnect）
      if (s.phase === 'auth' || s.phase === 'socks-request') {
        this.handleSocks5(s, data)
        return
      }
      if (s.phase === 'http') {
        this.handleHttp(s, data)
        return
      }
      // phase === 'start'：首字节分流
      if (data.length === 0) return
      if (data[0] === SOCKS5_VERSION) {
        if (!this.cfg.protocols.socks5) {
          this.log('info', 'socks5 已关闭，拒绝连接')
          this.sendOrClose(s, HTTP_400)
          return
        }
        s.protocol = 'socks5'
        s.phase = 'auth'
        this.handleSocks5(s, data)
        return
      }
      if (!this.cfg.protocols.http) {
        this.log('info', 'http 代理已关闭，拒绝连接')
        this.sendOrClose(s, HTTP_400)
        return
      }
      s.protocol = 'http'
      s.phase = 'http'
      this.handleHttp(s, data)
    } catch (e) {
      this.log('warn', `处理客户端数据异常: ${errText(e)}`)
      this.failRequest(s, 'error')
    }
  }

  private onClientEnd(s: SessionState): void {
    if (s.closed) return
    if (s.phase === 'tunnel' && s.remote) {
      // 客户端半关：把 FIN 传到上游，保持上行可读
      try {
        s.remote.end()
      } catch {
        /* ignore */
      }
      return
    }
    this.finish(s, 'client')
  }

  private onClientDrain(s: SessionState): void {
    if (s.closed) return
    this.flushToClient(s)
  }

  // ------------------------------------------------------------------ HTTP 代理

  private handleHttp(s: SessionState, chunk: Buffer): void {
    s.pending = s.pending ? Buffer.concat([s.pending, chunk]) : Buffer.from(chunk)
    const head = s.pending
    const idx = head.indexOf('\r\n\r\n')
    if (idx < 0) {
      if (head.length > MAX_HEADER_BYTES) {
        s.pending = null
        this.sendOrClose(s, HTTP_400)
      }
      return
    }
    const headBytes = head.subarray(0, idx)
    const rest = Buffer.from(head.subarray(idx + 4))
    s.pending = null

    const parsed = parseHttpHead(headBytes)
    if (!parsed) {
      this.sendOrClose(s, HTTP_400)
      return
    }
    // 原始请求字节（含 CONNECT 行与代理认证头）原样转发
    const raw = Buffer.concat([Buffer.from(headBytes), Buffer.from('\r\n\r\n')])
    const credential =
      parseBasicCredential(parsed.proxyAuthorization ?? '') ??
      parseBasicCredential(parsed.authorization ?? '')
    if (!credential) {
      this.noteAuthFailure(s.clientIp)
      this.deps.onAuthFailure(s.clientIp)
      this.rejectAuth(s, '缺少代理凭据')
      return
    }
    const route = this.authorize(s, credential)
    if (!route) return
    this.beginConnect(
      s,
      { protocol: 'http', target: parsed.target, raw, rest },
      route.port,
      route.nodeId,
    )
  }

  // ---------------------------------------------------------------- SOCKS5 代理

  private handleSocks5(s: SessionState, chunk: Buffer): void {
    s.pending = s.pending ? Buffer.concat([s.pending, chunk]) : Buffer.from(chunk)
    let buf = s.pending
    if (buf.length > MAX_PENDING_HANDSHAKE) {
      this.finish(s, 'error')
      return
    }

    // 1) 方法协商
    if (!s.socksGreeted) {
      if (buf.length < 2) {
        s.pending = buf
        return
      }
      const nmethods = buf[1]!
      if (buf.length < 2 + nmethods) {
        s.pending = buf
        return
      }
      const methods = buf.subarray(2, 2 + nmethods)
      if (buf[0] !== SOCKS5_VERSION || !methods.includes(0x02)) {
        s.pending = null
        this.writeClient(s, Buffer.from([SOCKS5_VERSION, 0xff]))
        this.log('info', 'socks5: 客户端未提供用户名/密码认证方法，拒绝')
        this.finish(s, 'client')
        return
      }
      s.socksGreeted = true
      this.writeClient(s, Buffer.from([SOCKS5_VERSION, 0x02]))
      buf = buf.subarray(2 + nmethods)
      s.pending = buf
    }

    // 2) RFC1929 用户名/密码子协商
    if (!s.socksAuthed) {
      if (buf.length < 2) {
        s.pending = buf
        return
      }
      const ulen = buf[1]!
      if (buf.length < 2 + ulen + 1) {
        s.pending = buf
        return
      }
      const plen = buf[2 + ulen]!
      if (buf.length < 3 + ulen + plen) {
        s.pending = buf
        return
      }
      const credential = parseSocks5Credential(buf.subarray(0, 3 + ulen + plen))
      buf = buf.subarray(3 + ulen + plen)
      s.pending = buf
      if (!credential) {
        this.writeClient(s, Buffer.from([SOCKS5_AUTH_VERSION, 0x01]))
        this.log('warn', 'socks5: 认证报文非法，拒绝')
        this.finish(s, 'client')
        return
      }
      s.socksAuthed = true
      if (!this.authorize(s, credential)) return
      // RFC1929 子协商成功应答
      this.writeClient(s, Buffer.from([SOCKS5_AUTH_VERSION, 0x00]))
    }

    // 3) 请求：CONNECT(0x01) / UDP ASSOCIATE(0x03)
    if (buf.length < 5) {
      s.pending = buf
      return
    }
    const cmd = buf[1]!
    const target = formatAddr(buf, 3)
    let reqLen = 0
    if (buf[3] === 0x01) reqLen = 10
    else if (buf[3] === 0x04) reqLen = 22
    else if (buf[3] === 0x03 && buf.length >= 5) reqLen = 4 + 1 + buf[4]! + 2
    if (!target || reqLen === 0) {
      if (buf[3] === 0x03 && buf.length < 5) {
        s.pending = buf
        return
      }
      s.pending = null
      this.socks5ReplyError(s, SOCKS5_REP_ADDR_NOT_SUPPORTED)
      return
    }
    if (buf.length < reqLen) {
      s.pending = buf
      return
    }
    const rest = Buffer.from(buf.subarray(reqLen))
    s.pending = null

    if (cmd === SOCKS5_CMD_UDP_ASSOCIATE) {
      // 明确拒绝：每个环回入站都是 http 协议，不承载 UDP
      this.log('info', 'socks5: 拒绝 UDP ASSOCIATE')
      this.socks5ReplyError(s, SOCKS5_REP_CMD_NOT_SUPPORTED)
      return
    }
    if (cmd !== SOCKS5_CMD_CONNECT) {
      this.socks5ReplyError(s, SOCKS5_REP_CMD_NOT_SUPPORTED)
      return
    }
    if (!s.routePort || !s.nodeId) {
      this.socks5ReplyError(s, SOCKS5_REP_GENERAL_FAILURE)
      return
    }
    this.beginConnect(
      s,
      { protocol: 'socks5', target, raw: buildConnectRequest(target), rest },
      s.routePort,
      s.nodeId,
    )
  }

  // -------------------------------------------------------------- 认证与并发限制

  /**
   * 校验凭据（含来源封禁与连续失败计数）并把用户名解析为环回端口。
   * 失败时已回复客户端，返回 undefined。
   */
  private authorize(
    s: SessionState,
    credential: Credential,
  ): { port: number; nodeId: string } | undefined {
    const ip = s.clientIp
    if (this.isBanned(ip) || this.deps.isBanned(ip)) {
      this.log('warn', `认证来源已封禁: ${ip}`)
      this.rejectAuth(s, '来源 IP 已封禁', false)
      return undefined
    }
    const username = credential.username
    const route = username ? this.resolveTarget(username) : undefined
    // selfCheck 的临时路由由网关自己签发，不再向 deps 校验凭据
    const isSelfCheck = !!this.selfCheckRoute && this.selfCheckRoute.user === username
    const credentialOk =
      isSelfCheck || this.cfg.authMode === 'username-only'
        ? true
        : !!username && this.deps.verifyCredential(username, credential.password)
    const valid = !!username && !!route && credentialOk

    if (!valid) {
      this.noteAuthFailure(ip)
      this.deps.onAuthFailure(ip)
      this.log('warn', `认证失败: user=${username || '(空)'} ip=${ip}`)
      this.rejectAuth(s, '认证失败')
      return undefined
    }

    this.noteAuthSuccess(ip)
    this.deps.onAuthSuccess(ip)
    s.username = username
    s.nodeId = route!.nodeId
    s.routePort = route!.port
    return { port: route!.port, nodeId: route!.nodeId }
  }

  /** 路由解析：自检临时路由优先，其次走 deps.resolveRoute */
  private resolveTarget(username: string): { nodeId: string; port: number } | undefined {
    const sc = this.selfCheckRoute
    if (sc) {
      if (sc.expiresAt <= Date.now()) {
        this.selfCheckRoute = null
      } else if (sc.user === username) {
        return { nodeId: sc.nodeId, port: sc.port }
      }
    }
    return this.deps.resolveRoute(username)
  }

  private rejectAuth(s: SessionState, msg: string, replySocks5 = true): void {
    if (s.protocol === 'socks5') {
      if (replySocks5) this.writeClient(s, Buffer.from([SOCKS5_AUTH_VERSION, 0x01]))
      this.log('info', `socks5 认证拒绝: ${msg}`)
      this.finish(s, 'client')
      return
    }
    this.log('info', `http 认证拒绝: ${msg}`)
    this.sendOrClose(s, HTTP_407)
  }

  private checkConcurrency(s: SessionState): boolean {
    const ipLimit = this.cfg.maxConcurrentPerIp
    const userLimit = this.cfg.maxConcurrentPerUser
    if (ipLimit > 0 && (this.byIp.get(s.clientIp) ?? 0) >= ipLimit) return false
    if (userLimit > 0 && s.username && (this.byUser.get(s.username) ?? 0) >= userLimit) return false
    return true
  }

  // -------------------------------------------------------------------- 建立隧道

  private beginConnect(
    s: SessionState,
    req: ProxyRequest,
    port: number,
    nodeId: string,
  ): void {
    s.target = req.target
    s.protocol = req.protocol
    s.nodeId = nodeId
    if (!this.checkConcurrency(s)) {
      this.log('warn', `并发超限: user=${s.username} ip=${s.clientIp}`)
      this.failRequest(s, 'concurrency')
      return
    }
    s.phase = 'connecting'
    this.connectUpstream(s, req, port)
  }

  private connectUpstream(s: SessionState, req: ProxyRequest, port: number): void {
    const dialTimeout = Math.max(200, this.cfg.dialTimeoutMs)
    let timer: ReturnType<typeof setTimeout> | null = null
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    Bun.connect<SessionState>({
      hostname: '127.0.0.1',
      port,
      allowHalfOpen: true,
      socket: {
        binaryType: 'buffer',
        open: (remote) => {
          clearTimer()
          if (s.closed) {
            this.closeSocket(remote)
            return
          }
          s.remote = remote
          remote.data = s
          this.enterTunnel(s, req)
        },
        data: (_remote, data: Buffer) => {
          if (s.closed) return
          s.lastActivityAt = Date.now()
          const chunk = Buffer.from(data)
          if (s.upstreamHead !== null) {
            // 环回入站（http）的响应头：只用于判断隧道是否真的建立成功，不转发给客户端
            s.upstreamHead = Buffer.concat([s.upstreamHead, chunk])
            const idx = s.upstreamHead.indexOf('\r\n\r\n')
            if (idx < 0) {
              if (s.upstreamHead.length > MAX_HEADER_BYTES) this.finish(s, 'error')
              return
            }
            const headText = s.upstreamHead.subarray(0, idx).toString('latin1')
            // 环回入站的响应（HTTP 响应头 + 已到达的载荷）原样转发给客户端，
            // 与真实 Xray http 入站的行为完全一致；下行字节从响应头第一个字节起计
            const response = Buffer.from(s.upstreamHead)
            s.upstreamHead = null
            if (!/^HTTP\/1\.[01]\s+2\d\d/.test(headText)) {
              this.log('warn', '环回入站返回非 2xx: ' + headText.split('\r\n')[0])
              this.socks5ReplyError(s, SOCKS5_REP_GENERAL_FAILURE)
              return
            }
            this.writeClient(
              s,
              Buffer.from([SOCKS5_VERSION, SOCKS5_REP_SUCCEEDED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            )
            s.down += response.length
            this.bytesDown += response.length
            this.pumpToClient(s, response)
            return
          }
          s.down += chunk.length
          this.bytesDown += chunk.length
          this.pumpToClient(s, chunk)
        },
        drain: () => {
          if (s.closed) return
          this.flushToRemote(s)
        },
        close: () => {
          clearTimer()
          this.finish(s, 'remote')
        },
        end: () => {
          clearTimer()
          if (s.closed) return
          // 上游半关：把 FIN 传给客户端，等客户端收尾
          try {
            s.client.end()
          } catch {
            /* ignore */
          }
        },
        error: (_remote, error) => {
          clearTimer()
          if (s.closed) return
          this.log('warn', `上游连接错误: ${error?.message ?? error}`)
          this.failRequest(s, 'error')
        },
        connectError: (_remote, error) => {
          clearTimer()
          if (s.closed) return
          this.log('warn', `上游连接失败 127.0.0.1:${port}: ${error?.message ?? error}`)
          this.failRequest(s, 'dial')
        },
      },
    }).catch((e) => {
      clearTimer()
      if (s.closed) return
      this.log('warn', `上游连接异常 127.0.0.1:${port}: ${errText(e)}`)
      this.failRequest(s, 'dial')
    })

    timer = setTimeout(() => {
      timer = null
      if (s.closed || s.phase !== 'connecting') return
      this.log('warn', `上游拨号超时 127.0.0.1:${port}`)
      this.failRequest(s, 'dial')
    }, dialTimeout)
  }

  private enterTunnel(s: SessionState, req: ProxyRequest): void {
    if (s.closed || !s.remote) return
    const id = this.deps.onOpen({
      nodeId: s.nodeId,
      username: s.username,
      clientIp: s.clientIp,
      protocol: req.protocol,
      target: req.target,
    })
    s.id = typeof id === 'number' && id > 0 ? id : 0
    s.startedAt = Date.now()
    s.lastActivityAt = Date.now()
    s.phase = 'tunnel'

    this.byIp.set(s.clientIp, (this.byIp.get(s.clientIp) ?? 0) + 1)
    s.countIp = true
    if (s.username) {
      this.byUser.set(s.username, (this.byUser.get(s.username) ?? 0) + 1)
      s.countUser = true
    }

    // 原样把请求转发给环回入站
    const head = Buffer.concat([Buffer.from(req.raw), req.rest])
    s.up += req.raw.length
    this.bytesUp += req.raw.length
    try {
      s.remote.write(head)
    } catch (e) {
      this.log('warn', `写入环回入站失败: ${errText(e)}`)
      this.finish(s, 'error')
      return
    }

    if (req.protocol === 'socks5') {
      // SOCKS5 的成功应答要等环回入站的 HTTP 响应头回来之后再发（见 connectUpstream 的 data 处理），
      // 这样既能区分「隧道建立成功 / 入站拒绝」，响应原文也照常转发给客户端。
      s.upstreamHead = Buffer.alloc(0)
    }
    this.log('info', `隧道建立: ${s.username} → ${req.target} (127.0.0.1:${s.routePort})`)
  }

  // ------------------------------------------------------------------ 双向 splice

  private pumpToRemote(s: SessionState, data: Uint8Array): void {
    if (s.closed || !s.remote) return
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    s.up += buf.length
    this.bytesUp += buf.length
    if (s.toRemoteQueued > 0) {
      s.toRemoteQueue.push(buf)
      s.toRemoteQueued += buf.length
      if (s.toRemoteQueued > MAX_BUFFERED_BYTES) this.finish(s, 'error')
      return
    }
    try {
      const written = s.remote.write(buf)
      if (written < buf.length) {
        const rest = buf.subarray(written)
        s.toRemoteQueue.push(rest)
        s.toRemoteQueued += rest.length
      }
    } catch (e) {
      this.log('warn', `转发到上游失败: ${errText(e)}`)
      this.finish(s, 'error')
    }
  }

  private flushToRemote(s: SessionState): void {
    if (s.closed || !s.remote) return
    while (s.toRemoteQueue.length > 0) {
      const buf = s.toRemoteQueue[0]!
      try {
        const written = s.remote.write(buf)
        if (written < buf.length) {
          s.toRemoteQueue[0] = buf.subarray(written)
          s.toRemoteQueued -= written
          return
        }
      } catch (e) {
        this.log('warn', `刷新上游缓冲失败: ${errText(e)}`)
        this.finish(s, 'error')
        return
      }
      s.toRemoteQueue.shift()
      s.toRemoteQueued -= buf.length
    }
    s.toRemoteQueued = 0
  }

  private pumpToClient(s: SessionState, data: Uint8Array): void {
    if (s.closed) return
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (s.toClientQueued > 0) {
      s.toClientQueue.push(buf)
      s.toClientQueued += buf.length
      if (s.toClientQueued > MAX_BUFFERED_BYTES) this.finish(s, 'error')
      return
    }
    try {
      const written = s.client.write(buf)
      if (written < buf.length) {
        const rest = buf.subarray(written)
        s.toClientQueue.push(rest)
        s.toClientQueued += rest.length
      }
    } catch (e) {
      this.log('warn', `转发到客户端失败: ${errText(e)}`)
      this.finish(s, 'error')
    }
  }

  private flushToClient(s: SessionState): void {
    if (s.closed) return
    while (s.toClientQueue.length > 0) {
      const buf = s.toClientQueue[0]!
      try {
        const written = s.client.write(buf)
        if (written < buf.length) {
          s.toClientQueue[0] = buf.subarray(written)
          s.toClientQueued -= written
          return
        }
      } catch (e) {
        this.log('warn', `刷新客户端缓冲失败: ${errText(e)}`)
        this.finish(s, 'error')
        return
      }
      s.toClientQueue.shift()
      s.toClientQueued -= buf.length
    }
    s.toClientQueued = 0
  }

  // -------------------------------------------------------------- 关闭 / 统计

  private finish(s: SessionState | undefined, reason: CloseReason): void {
    if (!s || s.closed) return
    s.closed = true
    s.phase = 'closed'
    s.reason = reason
    if (s.graceTimer) {
      clearTimeout(s.graceTimer)
      s.graceTimer = null
    }
    this.sessions.delete(s.key)
    if (s.countIp) {
      const n = (this.byIp.get(s.clientIp) ?? 1) - 1
      if (n <= 0) this.byIp.delete(s.clientIp)
      else this.byIp.set(s.clientIp, n)
      s.countIp = false
    }
    if (s.countUser) {
      const n = (this.byUser.get(s.username) ?? 1) - 1
      if (n <= 0) this.byUser.delete(s.username)
      else this.byUser.set(s.username, n)
      s.countUser = false
    }
    const remote = s.remote
    s.remote = null
    if (remote) this.closeSocket(remote)
    this.closeSocket(s.client)
    if (s.id > 0) {
      this.totalClosed++
      try {
        this.deps.onClose(s.id, reason, s.up, s.down)
      } catch (e) {
        this.log('error', `onClose 回调异常: ${errText(e)}`)
      }
    }
  }

  /** 协议层失败（拨号/并发等）时按当前协议回错误并关闭 */
  private failRequest(s: SessionState, kind: 'dial' | 'concurrency' | 'error'): void {
    if (s.closed) return
    if (s.protocol === 'socks5') {
      this.socks5ReplyError(s, SOCKS5_REP_GENERAL_FAILURE)
      return
    }
    this.sendOrClose(s, kind === 'concurrency' ? HTTP_429 : HTTP_502)
  }

  private sendOrClose(s: SessionState, text: string): void {
    if (s.closed) return
    s.responded = true
    this.writeClient(s, Buffer.from(text))
    // write 之后立刻 close() 会丢弃缓冲，留一个极短窗口让 Bun 落盘
    s.graceTimer = setTimeout(() => this.finish(s, 'client'), 20)
  }

  private socks5ReplyError(s: SessionState, rep: number): void {
    if (s.closed) return
    s.responded = true
    this.writeClient(
      s,
      Buffer.from([SOCKS5_VERSION, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
    )
    s.graceTimer = setTimeout(() => this.finish(s, 'client'), 20)
  }

  private writeClient(s: SessionState, buf: Uint8Array): void {
    try {
      s.client.write(buf)
    } catch {
      /* 对端已断开 */
    }
  }

  private closeSocket<S>(socket: Socket<S> | SessionSocket): void {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }

  private rowOf(s: SessionState): ConnectionRow {
    return {
      id: s.id,
      nodeId: s.nodeId,
      username: s.username,
      clientIp: s.clientIp,
      target: s.target,
      startedAt: s.startedAt,
      upBytes: s.up,
      downBytes: s.down,
      protocol: s.protocol,
    }
  }

  /** 周期性把增量字节数通过 onBytes 交给外部落库 */
  private flushBytes(): void {
    for (const s of this.sessions.values()) {
      if (s.closed || s.id <= 0) continue
      const du = s.up - s.reportedUp
      const dd = s.down - s.reportedDown
      if (du === 0 && dd === 0) continue
      s.reportedUp = s.up
      s.reportedDown = s.down
      try {
        this.deps.onBytes(s.id, s.up, s.down)
      } catch (e) {
        this.log('error', `onBytes 回调异常: ${errText(e)}`)
      }
    }
  }

  /** 每秒执行：空闲/握手超时、封禁过期、失败窗口裁剪 */
  private sweep(): void {
    const now = Date.now()
    const idleMs = Math.max(1, this.cfg.idleTimeoutSec) * 1000
    const handshakeMs = Math.max(5000, this.cfg.dialTimeoutMs * 2)
    for (const s of Array.from(this.sessions.values())) {
      if (s.closed) continue
      if (s.phase !== 'tunnel') {
        if (now - s.lastActivityAt > handshakeMs) {
          this.log('info', `握手超时，关闭: ${s.clientIp}`)
          this.finish(s, 'error')
        }
        continue
      }
      if (now - s.lastActivityAt > idleMs) {
        this.log('info', `空闲超时，关闭: ${s.username || s.clientIp}`)
        this.finish(s, 'client')
      }
    }
    for (const [ip, until] of Array.from(this.bans)) {
      if (until <= now) {
        this.bans.delete(ip)
        this.failures.delete(ip)
        this.log('info', `封禁解除: ${ip}`)
      }
    }
    const windowStart = now - 300_000
    for (const [ip, list] of Array.from(this.failures)) {
      if (list.length === 0 || list[list.length - 1]! < windowStart) this.failures.delete(ip)
    }
  }

  private isBanned(ip: string): boolean {
    const until = this.bans.get(ip)
    if (until === undefined) return false
    if (until <= Date.now()) {
      this.bans.delete(ip)
      return false
    }
    return true
  }

  private bannedIps(): string[] {
    const now = Date.now()
    const out: string[] = []
    for (const [ip, until] of this.bans) {
      if (until > now) out.push(ip)
    }
    return out
  }

  private noteAuthFailure(ip: string): void {
    let list = this.failures.get(ip)
    if (!list) {
      list = []
      this.failures.set(ip, list)
    }
    list.push(Date.now())
    const limit = this.cfg.authFailBanCount
    if (limit > 0 && list.length >= limit) {
      const sec = Math.max(1, this.cfg.authFailBanSec)
      this.bans.set(ip, Date.now() + sec * 1000)
      list.length = 0
      this.log('warn', `连续认证失败 ${limit} 次，封禁 ${ip} ${sec}s`)
    }
  }

  private noteAuthSuccess(ip: string): void {
    this.failures.delete(ip)
  }

  private recentFailureCount(): number {
    const now = Date.now()
    let n = 0
    for (const list of this.failures.values()) {
      for (const t of list) {
        if (now - t <= 300_000) n++
      }
    }
    return n
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, detail?: unknown): void {
    try {
      this.deps.log(level, msg, detail)
    } catch {
      /* 日志失败不影响数据面 */
    }
  }
}

// -------------------------------------------------------------------- 辅助函数

interface HttpHead {
  method: string
  target: string
  version: string
  proxyAuthorization?: string
  authorization?: string
}

/** 解析 HTTP 请求头（只解析请求行与代理认证头，其余原样转发） */
export function parseHttpHead(head: Uint8Array): HttpHead | undefined {
  const text = utf8(head)
  const lines = text.split('\r\n')
  const first = lines[0]
  if (!first) return undefined
  const m = /^(\S+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(first)
  if (!m) return undefined
  const method = m[1]!.toUpperCase()
  const target = m[2]!
  const version = m[3]!
  let proxyAuthorization: string | undefined
  let authorization: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const name = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (name === 'proxy-authorization' && proxyAuthorization === undefined) {
      proxyAuthorization = value
    } else if (name === 'authorization' && authorization === undefined) {
      authorization = value
    }
  }
  if (method === 'CONNECT') {
    if (!/^\[?[^\]]+\]?:\d{1,5}$/.test(target)) return undefined
    return { method, target, version, proxyAuthorization, authorization }
  }
  // 绝对 URI 形式（http://host[:port]/...）
  const abs = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#\s]+)/.exec(target)
  if (!abs) return undefined
  const scheme = abs[1]!.toLowerCase()
  const authority = abs[2]!
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority
  if (!hostPort) return undefined
  if (scheme !== 'http') return undefined
  const targetHostPort = hostPort.includes(':') ? hostPort : `${hostPort}:80`
  return { method, target: targetHostPort, version, proxyAuthorization, authorization }
}

function readTlsFile(path: string, field: string): string {
  if (!path) throw new Error(`gateway.tls.enabled=true 但 ${field} 为空`)
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`读取 ${field} 失败（${path}）: ${errText(e)}`)
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 容忍外部传入的历史配置形态（缺字段时用 PANEL.md §6.7 默认值补齐） */
export function normalizeGatewayConfig(raw: unknown): GatewayConfig {
  const r = (raw ?? {}) as Partial<GatewayConfig> & {
    tls?: Partial<GatewayConfig['tls']>
    protocols?: Partial<GatewayConfig['protocols']>
  }
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'string' ? Number.parseInt(v, 10) : (v as number)
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback
  }
  return {
    enabled: r.enabled === undefined ? true : !!r.enabled,
    listen: typeof r.listen === 'string' && r.listen.trim() ? r.listen.trim() : '0.0.0.0:7890',
    authMode: r.authMode === 'username-only' ? 'username-only' : 'strict',
    tls: {
      enabled: !!r.tls?.enabled,
      certFile: typeof r.tls?.certFile === 'string' ? r.tls.certFile : '',
      keyFile: typeof r.tls?.keyFile === 'string' ? r.tls.keyFile : '',
    },
    maxConcurrentPerUser: num(r.maxConcurrentPerUser, 64),
    maxConcurrentPerIp: num(r.maxConcurrentPerIp, 256),
    idleTimeoutSec: num(r.idleTimeoutSec, 300),
    dialTimeoutMs: num(r.dialTimeoutMs, 3000),
    authFailBanCount: num(r.authFailBanCount, 20),
    authFailBanSec: num(r.authFailBanSec, 300),
    protocols: {
      http: r.protocols?.http === undefined ? true : !!r.protocols.http,
      socks5: r.protocols?.socks5 === undefined ? true : !!r.protocols.socks5,
    },
  }
}
