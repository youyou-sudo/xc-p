/**
 * 第二道门禁（PANEL.md §7.2 / docs/IMPL-CONTRACTS.md §2）：
 * 每个「可发布协议」fixture 归一化后的 outbound，包成 {"outbounds":[{"tag":"out-test",...}]}
 * 写临时文件后用 `.tools/xray.exe run -test -c <file>` 校验被接受。
 *
 * 关于 hysteria2 / tuic：D9 的支持矩阵**按契约**把它们标为 true（"视版本与构建而定"，
 * 由运行期的构建校验再试探）。本机 v26.3.27 的构建同样不包含这两个 outbound（xray 报
 * `unknown config id`），因此本测试对它们断言「必须被拒绝且原因可识别」，
 * 其余协议断言「必须被接受」。这样任何**解析/渲染**层面的回归都会立刻暴露，
 * 而构建缺协议的事实也被显式记录、可被父任务读取。
 *
 * 关于 allowInsecure（v26.3.27 起）：上游在 v26.2.6 把 `allowInsecure` 标为延时废弃
 * （UTC 2026-06-01 00:00 起报错，改用 `pinnedPeerCertSha256` / `verifyPeerCertByName`）。
 * 因此「渲染出 allowInsecure=true 的节点」在本构建上必须被拒绝，且错误原因可识别；
 * 这是构建能力的变化，不是渲染回归，所以单列一类断言而不是混进 BUILD_SUPPORTED。
 */

import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSubscription } from '../src/sub/formats'
import { normalizeNode, PROTOCOL_SUPPORT_MATRIX } from '../src/sub/normalize'
import type { NormalizedNode, Protocol } from '../src/sub/types'

// monorepo: test/ → apps/server/test，仓库根在上三级
const ROOT = join(import.meta.dir, '../../..')
const FIXTURES = join(import.meta.dir, 'fixtures', 'sub')

function findXray(): string | undefined {
  const candidates = [
    join(ROOT, '.tools', 'xray.exe'),
    join(ROOT, '.tools', 'xray'),
    process.env['XRAY_BIN'] ?? '',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return undefined
}

const XRAY = findXray()

/**
 * 本机 Xray 构建的能力画像（对着 `xray run -test` 实测）：
 * v25.9.11 / v26.3.27 都认识 shadowsocks/vmess/vless/trojan/socks/http，
 * **都不认识** hysteria2 / tuic / shadowsocksr。
 */
const BUILD_SUPPORTED: Record<Protocol, boolean> = {
  ss: true,
  ssr: false,
  vmess: true,
  vless: true,
  trojan: true,
  hysteria2: false,
  tuic: false,
  socks: true,
  http: true,
}

/** 渲染结果里是否带 allowInsecure=true（v26.2.6 起延时废弃，本机构建已生效，必须被拒绝） */
function hasInsecureTls(outbound: Record<string, unknown>): boolean {
  const stream = outbound['streamSettings'] as Record<string, any> | undefined
  return stream?.['tlsSettings']?.['allowInsecure'] === true || stream?.['realitySettings']?.['allowInsecure'] === true
}

/** 构建明确拒绝的协议 -> 期望在 stderr/stdout 里出现的原因片段 */
const EXPECTED_BUILD_REJECTION: Partial<Record<Protocol, RegExp>> = {
  hysteria2: /unknown config id: hysteria2/,
  tuic: /unknown config id: tuic/,
}

interface Sample {
  fixture: string
  protocol: Protocol
  fingerprint: string
  outbound: Record<string, unknown>
}

function collectSamples(): Sample[] {
  const seen = new Map<string, Sample>()
  for (const fixture of readdirSync(FIXTURES).sort()) {
    const body = readFileSync(join(FIXTURES, fixture), 'utf8')
    const result = parseSubscription(body, 'auto', 'sub-render')
    for (const input of result.nodes) {
      const node: NormalizedNode = normalizeNode(input)
      if (!node.protocolSupported) continue
      if (seen.has(node.fingerprint)) continue
      seen.set(node.fingerprint, {
        fixture,
        protocol: node.protocol,
        fingerprint: node.fingerprint,
        outbound: node.outbound,
      })
    }
  }
  return [...seen.values()].sort((a, b) => (a.protocol + a.fixture).localeCompare(b.protocol + b.fixture))
}

const SAMPLES = XRAY ? collectSamples() : []

/**
 * 跑一次 `xray run -test -c <file>`。
 * 用 spawn + 显式 kill，而不是 spawnSync+timeout：被 kill 时也要拿到已写出的输出，
 * 否则失败原因会丢。`ok=true` 还要看到 "Configuration OK" 才算真的被接受
 * （只看退出码会把某些"启动了但没输出"的情况误判为通过）。
 */
function runXrayTest(config: unknown, timeoutMs = 8000): Promise<{ ok: boolean; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'xc-p-xray-render-'))
  const file = join(dir, 'cfg.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return new Promise((resolve) => {
    const child = spawn(XRAY!, ['run', '-test', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let finished = false
    const done = (timedOut: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      rmSync(dir, { recursive: true, force: true })
      const output = (out + err).trim() + (timedOut ? '\n[timeout] xray run -test 未在限时内退出' : '')
      resolve({ ok: child.exitCode === 0 && /Configuration OK/.test(output), output })
    }
    const timer = setTimeout(() => done(true), timeoutMs)
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8') })
    child.on('error', (e) => { err += String(e); done(false) })
    child.on('close', () => done(false))
  })
}

describe('Xray 渲染门禁', () => {
  test('可用性前置条件', () => {
    if (!XRAY) {
      console.warn('未找到 .tools/xray，跳过渲染门禁')
      return
    }
    const res = spawnSync(XRAY, ['version'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/Xray \d/)
  }, 30_000)

  test('门禁本身有效：故意写坏的配置必须被拒绝', async () => {
    if (!XRAY) return
    const { ok, output } = await runXrayTest({
      outbounds: [{ tag: 'out-test', protocol: 'not-a-real-protocol', settings: {} }],
    })
    expect(ok).toBe(false)
    expect(output).toMatch(/unknown config id|failed to load/i)
  }, 30_000)

  test('构建能力画像：allowInsecure=true 的 TLS 出站必须被拒绝（v26.2.6 起延时废弃已生效）', async () => {
    if (!XRAY) return
    const { ok, output } = await runXrayTest({
      outbounds: [
        {
          tag: 'out-test',
          protocol: 'trojan',
          settings: { servers: [{ address: 'example.com', port: 443, password: 'x' }] },
          streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'example.com', allowInsecure: true } },
        },
      ],
    })
    expect(ok).toBe(false)
    expect(output).toMatch(/allowInsecure.*removed|pinnedPeerCertSha256/)
  })

  test('fixture 覆盖到 allowInsecure 渲染用例（构建会拒绝它，发布期由构建校验排除该节点）', () => {
    if (!XRAY) return
    expect(SAMPLES.some((s) => hasInsecureTls(s.outbound))).toBe(true)
  })

  test('fixture 覆盖到足够多的可发布节点', () => {
    if (!XRAY) return
    expect(SAMPLES.length).toBeGreaterThanOrEqual(40)
    const protocols = new Set(SAMPLES.map((s) => s.protocol))
    for (const p of ['ss', 'vmess', 'vless', 'trojan', 'socks', 'http'] as Protocol[]) {
      expect(protocols.has(p)).toBe(true)
    }
  })

  test('每个协议都渲染出了不含 tag 的 outbound 模板', () => {
    if (!XRAY) return
    for (const s of SAMPLES) {
      expect(s.outbound).not.toHaveProperty('tag')
      expect(typeof s.outbound.protocol).toBe('string')
      expect(s.outbound.settings).toBeDefined()
    }
  })

  // 逐条渲染检查（每个节点一个用例，失败时能直接定位到 fixture）
  describe('逐节点 xray run -test', () => {
    const list = XRAY ? SAMPLES : []
    for (const s of list) {
      const unsupportedProtocol = !BUILD_SUPPORTED[s.protocol]
      const insecureTls = hasInsecureTls(s.outbound)
      const tag = unsupportedProtocol ? '构建不支持 ' : insecureTls ? '构建拒绝 allowInsecure ' : ''
      const label = tag + s.protocol + ' @' + s.fixture
      test(label, async () => {
        const { ok, output } = await runXrayTest({ outbounds: [{ tag: 'out-test', ...s.outbound }] })
        if (unsupportedProtocol) {
          expect(ok).toBe(false)
          const pattern = EXPECTED_BUILD_REJECTION[s.protocol]
          if (pattern) expect(output).toMatch(pattern)
          return
        }
        // v26.2.6 起 allowInsecure 延时废弃（本机构建已生效）：渲染出现即拒绝，且原因可识别
        if (insecureTls) {
          expect(ok).toBe(false)
          expect(output).toMatch(/allowInsecure.*removed|pinnedPeerCertSha256/)
          return
        }
        expect(output).toContain('Configuration OK')
        expect(ok).toBe(true)
      }, 20000)
    }
  })

  test('D9 矩阵与 build 能力画像的关系被显式记录', () => {
    if (!XRAY) return
    const mismatched = (Object.keys(PROTOCOL_SUPPORT_MATRIX) as Protocol[]).filter(
      (p) => PROTOCOL_SUPPORT_MATRIX[p] !== BUILD_SUPPORTED[p],
    )
    // 目前唯一的分歧必须只有 hysteria2 / tuic（D9 标 true、本构建标 false）
    expect(mismatched.sort()).toEqual(['hysteria2', 'tuic'])
  })

  test('ssr 节点不进渲染集合（protocol_supported=false）', () => {
    if (!XRAY) return
    expect(SAMPLES.some((s) => s.protocol === 'ssr')).toBe(false)
    expect(PROTOCOL_SUPPORT_MATRIX.ssr).toBe(false)
  })
})