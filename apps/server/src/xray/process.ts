import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from '../config'
import type { SettingsStore } from '../core/settings'
import type { EventBus } from '../core/events'
import { logger } from '../core/log'
import { renderBaseConfig, type BaseConfigCredential } from './base-config'
import { resolveXrayBinary, xrayNotFoundHint } from './binary'

export interface XrayProcessState {
  status: 'stopped' | 'starting' | 'running' | 'external' | 'crashed'
  pid: number | null
  startedAt: number | null
  restarts: number
  lastError: string | null
  binary: string
  version: string
  configPath: string
}

/**
 * 数据面进程托管（PANEL.md §5.2 / §9.4 / §14.1）：
 * 面板负责 spawn/监督 Xray 子进程；崩溃后自动用启动配置拉起（重放由调用方随后执行）。
 */
export class XrayProcess {
  private proc: Bun.Subprocess | null = null
  private state: XrayProcessState
  private stopping = false
  private onCrash?: () => void
  private logPath: string
  /** 最近的数据面输出（用于把「退出原因」带进事件与健康检查） */
  private recentOutput = ''

  constructor(
    private settings: SettingsStore,
    private events: EventBus,
    private opts: { creds?: () => BaseConfigCredential[] } = {},
  ) {
    this.logPath = paths.logs + '/xray.log'
    this.state = {
      status: 'stopped',
      pid: null,
      startedAt: null,
      restarts: 0,
      lastError: null,
      binary: '',
      version: '',
      configPath: paths.baseConfig,
    }
  }

  getState(): XrayProcessState {
    return { ...this.state }
  }

  isManaged(): boolean {
    return this.settings.get().xray.mode === 'managed'
  }

  /** 写 DATA_DIR/runtime/base/xray.json（附录 A）。节点不在这个文件里（§9.4）。 */
  writeBaseConfig(): string {
    const settings = this.settings.get()
    const cfg = renderBaseConfig(settings, this.opts.creds?.() ?? [])
    mkdirSync(dirname(paths.baseConfig), { recursive: true })
    writeFileSync(paths.baseConfig, JSON.stringify(cfg, null, 2), 'utf8')
    return paths.baseConfig
  }

  /** 渲染本次发布的完整配置快照到 DATA_DIR/runtime/<rev>/xray.json（产物，可灾备重建） */
  writeRevisionConfig(
    revisionId: string,
    outbounds: Record<string, unknown>[],
    inbounds: Record<string, unknown>[],
    rules: Record<string, unknown>[],
  ): string {
    const settings = this.settings.get()
    const base = renderBaseConfig(settings, this.opts.creds?.() ?? []) as Record<string, any>
    const cfg = {
      ...base,
      inbounds: [...(base.inbounds as unknown[]), ...inbounds],
      outbounds: [...(base.outbounds as unknown[]), ...outbounds],
      routing: { rules: [...((base.routing?.rules as unknown[]) ?? []), ...rules] },
    }
    const dir = paths.runtime + '/' + revisionId
    mkdirSync(dir, { recursive: true })
    const file = dir + '/xray.json'
    writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
    return file
  }

  onExit(cb: () => void): void {
    this.onCrash = cb
  }

  async start(): Promise<XrayProcessState> {
    if (!this.isManaged()) {
      this.state.status = 'external'
      return this.getState()
    }
    if (this.proc) return this.getState()
    const configured = this.settings.get().xray.binary
    const resolved = resolveXrayBinary(configured)
    if (!resolved) throw new Error(xrayNotFoundHint(configured))
    const binary = resolved.path
    if (!existsSync(paths.baseConfig)) this.writeBaseConfig()
    mkdirSync(paths.logs, { recursive: true })
    // 端口 8501 已有人监听 → 多半是上一次运行残留的 xray，新进程会 bind 失败并进入重启循环
    if (await this.detectForeignApi()) {
      this.events.warn(
        'xray.api_port_busy',
        '管理端口 ' + this.settings.get().xray.apiAddress + ' 已被其它进程占用（可能是上一次运行的残留 xray），新数据面可能无法启动',
      )
    }
    this.recentOutput = ''
    this.state.status = 'starting'
    try {
      this.proc = Bun.spawn([binary, 'run', '-c', paths.baseConfig], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
      this.state.pid = this.proc.pid ?? null
      this.state.startedAt = Date.now()
      this.state.status = 'running'
      this.state.binary = binary
      this.pipeLogs(this.proc)
      void this.proc.exited.then((code) => this.handleExit(code))
      this.events.info('xray.started', '数据面已启动（pid=' + String(this.state.pid) + '）')
      logger.info('xray started pid=' + String(this.state.pid) + ' binary=' + binary)
    } catch (e) {
      this.state.status = 'crashed'
      this.state.lastError = e instanceof Error ? e.message : String(e)
      this.state.binary = this.settings.get().xray.binary
      this.events.error('xray.start_failed', '数据面启动失败：' + this.state.lastError)
      throw new Error('数据面（Xray）启动失败：' + this.state.lastError)
    }
    return this.getState()
  }

  private pipeLogs(proc: Bun.Subprocess): void {
    void (async () => {
      const { appendFileSync } = await import('node:fs')
      const write = (chunk: Uint8Array) => {
        try {
          appendFileSync(this.logPath, chunk)
        } catch {
          /* ignore */
        }
        try {
          this.recentOutput = (this.recentOutput + Buffer.from(chunk).toString('utf8')).slice(-8192)
        } catch {
          /* ignore */
        }
      }
      void (async () => {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) write(chunk)
      })().catch(() => undefined)
      void (async () => {
        for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) write(chunk)
      })().catch(() => undefined)
    })().catch(() => undefined)
  }

  private handleExit(code: number | null): void {
    const wasRunning = this.state.status === 'running'
    this.proc = null
    this.state.pid = null
    if (this.stopping) {
      this.state.status = 'stopped'
      this.events.info('xray.stopped', '数据面已停止')
      return
    }
    this.state.status = 'crashed'
    this.state.restarts++
    this.state.lastError = 'exit code ' + String(code) + this.tailHint()
    if (wasRunning) {
      this.events.error('xray.crashed', '数据面进程退出（code=' + String(code) + '）' + this.tailHint(), {
        detail: { output: this.recentOutputTail(600) },
      })
    }
    this.onCrash?.()
  }

  /** 数据面最后几行输出（用于定位启动失败原因，例如 API 端口被其它实例占用） */
  recentOutputTail(max = 400): string {
    const lines = this.recentOutput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return lines.slice(-4).join(' | ').slice(-max)
  }

  private tailHint(): string {
    const tail = this.recentOutputTail(300)
    return tail ? '：' + tail : ''
  }

  /** 启动前自检：API 端口若已被其它实例占用，说明大概率是上一次运行的残留 */
  async detectForeignApi(): Promise<boolean> {
    const addr = this.settings.get().xray.apiAddress
    const idx = addr.lastIndexOf(':')
    const host = idx > 0 ? addr.slice(0, idx) : '127.0.0.1'
    const port = Number.parseInt(idx > 0 ? addr.slice(idx + 1) : addr, 10)
    if (!Number.isFinite(port)) return false
    try {
      const sock = await Bun.connect({
        hostname: host === '0.0.0.0' ? '127.0.0.1' : host,
        port,
        socket: { data() {}, error() {}, close() {} },
      })
      sock.end()
      return true
    } catch {
      return false
    }
  }

  async stop(timeoutMs = 5000): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    try {
      proc.kill()
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, timeoutMs))])
    } catch {
      /* ignore */
    }
    this.proc = null
    this.state.pid = null
    this.state.status = 'stopped'
    this.stopping = false
  }

  /** 重启数据面（维护窗口 / 面板「立即重启」） */
  async restart(): Promise<XrayProcessState> {
    await this.stop()
    this.writeBaseConfig()
    return this.start()
  }

  /** 检查 xray 二进制与版本（§14.2#1；打包版优先探测内嵌并解出的二进制） */
  async probe(binary?: string): Promise<{ ok: boolean; version: string; raw: string; error?: string }> {
    const configured = binary || this.settings.get().xray.binary
    const resolved = resolveXrayBinary(configured)
    if (!resolved) return { ok: false, version: '', raw: '', error: xrayNotFoundHint(configured) }
    const bin = resolved.path
    try {
      const proc = Bun.spawn([bin, 'version'], { stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
      await proc.exited
      const m = /Xray\s+(\S+)/.exec(out)
      const version = m?.[1] ?? ''
      this.state.version = version
      return { ok: !!version, version, raw: (out || err).trim() }
    } catch (e) {
      return { ok: false, version: '', raw: '', error: e instanceof Error ? e.message : String(e) }
    }
  }
}
