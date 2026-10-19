import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../core/log'
import type { ErrorCode } from '../core/errors'

export interface XrayCliOptions {
  binary: () => string
  server: () => string
  timeoutSec: () => number
}

export interface XrayApiResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  durationMs: number
  errorKind?: ErrorCode
  unsupported?: boolean
}

export interface XrayOutboundInfo { tag: string; raw: Record<string, unknown> }
export interface XrayInboundInfo { tag: string; port?: number; listen?: string; raw: Record<string, unknown> }
export interface XrayRuleInfo { ruleTag: string; tag?: string; raw: Record<string, unknown> }

/**
 * 控制面 → 数据面通道：Bun.spawn(["xray","api",...])（PANEL.md D6，默认通道）。
 * 所有调用必须由调用方串行（单一 apply queue）。
 */
export class XrayCli {
  private tempRoot: string | null = null

  constructor(private opts: XrayCliOptions) {}

  binary(): string {
    return this.opts.binary()
  }

  private async raw(args: string[], timeoutMs?: number): Promise<XrayApiResult> {
    const bin = this.opts.binary()
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let code = -1
    try {
      const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = timeoutMs
        ? setTimeout(() => {
            try {
              proc.kill()
            } catch {
              /* ignore */
            }
          }, timeoutMs)
        : null
      const [outText, errText] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
      if (timer) clearTimeout(timer)
      code = await proc.exited
      stdout = outText
      stderr = errText
    } catch (e) {
      stderr = e instanceof Error ? e.message : String(e)
      code = -1
    }
    const durationMs = Date.now() - started
    const result: XrayApiResult = { ok: code === 0, code, stdout, stderr, durationMs }
    if (!result.ok) {
      result.errorKind = classifyXrayError(stderr, code)
      result.unsupported = /unknown command/i.test(stderr)
    }
    logger.debug('xray cli', { args: args.join(' '), code, ms: durationMs })
    return result
  }

  private serverArgs(): string[] {
    return [`--server=${this.opts.server()}`, `-timeout=${this.opts.timeoutSec()}`]
  }

  private async api(sub: string, extra: string[], timeoutMs?: number): Promise<XrayApiResult> {
    return this.raw(['api', sub, ...this.serverArgs(), ...extra], timeoutMs)
  }

  /** 写临时 JSON 载荷（ado/adi/adrules 需要文件参数） */
  async writePayload(name: string, payload: unknown): Promise<string> {
    if (!this.tempRoot) {
      this.tempRoot = await mkdtemp(join(tmpdir(), 'xcp-xray-'))
    }
    const file = join(this.tempRoot, name)
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
    return file
  }

  async cleanupTemp(): Promise<void> {
    if (!this.tempRoot) return
    try {
      await rm(this.tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    this.tempRoot = null
  }

  /** 新增出站：xray api ado <out.json...>（appendix B #1） */
  async ado(outbounds: Record<string, unknown>[]): Promise<XrayApiResult> {
    const file = await this.writePayload(`ado-${Date.now()}.json`, { outbounds })
    return this.api('ado', [file])
  }

  /** 新增入站：xray api adi <in.json...> */
  async adi(inbounds: Record<string, unknown>[]): Promise<XrayApiResult> {
    const file = await this.writePayload(`adi-${Date.now()}.json`, { inbounds })
    return this.api('adi', [file])
  }

  /**
   * 追加路由规则。**必须 --append**，否则整体替换规则表（PANEL.md §9.2 纪律 1 / R3）。
   * 这里的参数顺序是硬编码的，调用方无法绕过 --append。
   */
  async adrules(rules: Record<string, unknown>[]): Promise<XrayApiResult> {
    const file = await this.writePayload(`adrules-${Date.now()}.json`, { routing: { rules } })
    return this.api('adrules', ['--append', file])
  }

  async rmo(tags: string[]): Promise<XrayApiResult> {
    if (tags.length === 0) return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 0 }
    return this.api('rmo', tags)
  }

  async rmi(tags: string[]): Promise<XrayApiResult> {
    if (tags.length === 0) return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 0 }
    return this.api('rmi', tags)
  }

  async rmrules(ruleTags: string[]): Promise<XrayApiResult> {
    if (ruleTags.length === 0) return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 0 }
    return this.api('rmrules', ruleTags)
  }

  async lso(): Promise<{ result: XrayApiResult; outbounds: XrayOutboundInfo[] }> {
    const result = await this.api('lso', [])
    return { result, outbounds: result.ok ? parseTags(result.stdout, 'outbounds') : [] }
  }

  async lsi(): Promise<{ result: XrayApiResult; inbounds: XrayInboundInfo[] }> {
    const result = await this.api('lsi', [])
    return { result, inbounds: result.ok ? parseInbounds(result.stdout) : [] }
  }

  /**
   * 列路由规则。CLI 的 lsrules 只在较新构建里存在（PANEL.md V6 实测于 v26.10.10）；
   * 缺失时返回 supported=false，由对账器退化为「按已成功执行的 adrules/rmrules 审计重建」。
   */
  async lsrules(): Promise<{ result: XrayApiResult; rules: XrayRuleInfo[]; supported: boolean }> {
    const result = await this.api('lsrules', [])
    if (!result.ok) return { result, rules: [], supported: false }
    return { result, rules: parseRules(result.stdout), supported: true }
  }

  async statsquery(pattern?: string, reset = false): Promise<{ result: XrayApiResult; stats: Record<string, number> }> {
    const extra: string[] = []
    if (pattern) extra.push(`-pattern=${pattern}`)
    if (reset) extra.push('-reset')
    const result = await this.api('statsquery', extra)
    return { result, stats: parseStats(result.stdout) }
  }

  async version(): Promise<{ ok: boolean; raw: string; version: string }> {
    const r = await this.raw(['version'])
    const m = /Xray\s+(\S+)/.exec(r.stdout)
    return { ok: r.ok, raw: r.stdout.trim(), version: m?.[1] ?? '' }
  }

  /** xray run -test -c <file>：构建校验（PANEL.md §9.1 安全阀 / AC-9） */
  async testConfig(file: string, timeoutMs = 15000): Promise<XrayApiResult> {
    return this.raw(['run', '-test', '-c', file], timeoutMs)
  }
}

export function classifyXrayError(stderr: string, code: number): ErrorCode {
  const s = stderr.toLowerCase()
  if (/existing tag found|duplicate.*tag|tag.*conflict/.test(s)) return 'xray_tag_conflict'
  if (/address already in use|bind: |cannot assign requested address|only one usage of each socket address/.test(s)) return 'xray_port_conflict'
  if (/connection refused|no such host|transport: |rpc error|context deadline exceeded|failed to dial/.test(s)) return 'xray_api_unreachable'
  if (/unknown command/.test(s)) return 'xray_api_unreachable'
  if (code === -1) return 'xray_down'
  return 'xray_build_failed'
}

export function parseTags(stdout: string, key: string): XrayOutboundInfo[] {
  const json = tryJson(stdout)
  const list = (json?.[key] as unknown[]) ?? []
  const out: XrayOutboundInfo[] = []
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as any).tag === 'string') {
      out.push({ tag: (item as any).tag, raw: item as Record<string, unknown> })
    }
  }
  return out
}

export function parseInbounds(stdout: string): XrayInboundInfo[] {
  const json = tryJson(stdout)
  const list = (json?.inbounds as unknown[]) ?? []
  const out: XrayInboundInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const tag = (item as any).tag
    if (typeof tag !== 'string') continue
    const receiver = (item as any).receiverSettings ?? {}
    const port = typeof receiver.portList === 'number' ? receiver.portList : undefined
    out.push({ tag, port, listen: typeof receiver.listen === 'string' ? receiver.listen : undefined, raw: item as Record<string, unknown> })
  }
  return out
}

export function parseRules(stdout: string): XrayRuleInfo[] {
  const json = tryJson(stdout)
  const list = (json?.rules as unknown[]) ?? []
  const out: XrayRuleInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const ruleTag = (item as any).ruleTag
    if (typeof ruleTag === 'string' && ruleTag) out.push({ ruleTag, tag: (item as any).tag, raw: item as Record<string, unknown> })
  }
  return out
}

export function parseStats(stdout: string): Record<string, number> {
  const json = tryJson(stdout)
  const list = (json?.stat as unknown[]) ?? []
  const out: Record<string, number> = {}
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = (item as any).name
    const value = (item as any).value
    if (typeof name === 'string') {
      const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10)
      out[name] = Number.isFinite(n) ? n : 0
    }
  }
  return out
}

function tryJson(text: string): Record<string, any> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, any>
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, any>
      } catch {
        return null
      }
    }
    return null
  }
}
