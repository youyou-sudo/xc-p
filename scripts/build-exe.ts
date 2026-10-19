/**
 * 打包单文件可执行（bun build --compile），并把对应平台的 Xray 一起嵌进去。
 *
 * 流程：
 *   1. 解析目标平台（--target=bun-windows-x64 / bun-linux-x64 / bun-linux-arm64 / bun-darwin-arm64 …，
 *      省略时用当前构建机）；
 *   2. 构建 Furin 前端并嵌入控制面（--skip-web 可跳过）；
 *   3. 从 XTLS/Xray-core 下载该平台发行包（默认 v26.3.27，--xray-version 可换），
 *      用 .dgst 的 SHA2-256 校验压缩包，取出 xray[.exe] 并缓存到 .cache/xray/；
 *   4. 生成 apps/server/src/xray/embedded.generated.ts（`with { type: "file" }`）；
 *   5. `bun build --compile` 打单文件；最后把生成文件恢复为占位版本（源码运行无内嵌二进制）。
 *
 * 运行时 embedded.ts 会把内嵌的 xray 解出到 DATA_DIR/bin 并校验 SHA256 后再执行。
 *
 * 用法：
 *   bun run build:exe                                  # 当前平台
 *   bun run build:exe -- --target=bun-linux-x64        # 交叉编译
 *   bun run build:exe -- --xray-version=v26.3.27 --mirror=https://ghfast.top/
 *   XRAY_DOWNLOAD_MIRROR=https://ghfast.top/ bun run build:exe
 *   bun run build:exe -- --fetch-only                  # 只下载/解出 Xray，不编译
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_XRAY_VERSION,
  extractZipEntry,
  parseBuildTarget,
  parseDigestSha256,
  xrayReleaseAsset,
  type XrayBuildTarget,
} from '../apps/server/src/xray/release'

const root = resolve(import.meta.dir, '..')
const generatedPath = join(root, 'apps', 'server', 'src', 'xray', 'embedded.generated.ts')

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2)

function arg(name: string): string | undefined {
  const prefix = '--' + name + '='
  const inline = argv.find((a) => a.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const i = argv.indexOf('--' + name)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  return undefined
}

function flag(name: string): boolean {
  return argv.includes('--' + name)
}

function positionalTarget(): string | undefined {
  const withValue = new Set(['--xray-version', '--mirror', '--outfile', '--target'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (withValue.has(a)) i++
      continue
    }
    return a
  }
  return undefined
}

const targetArg = arg('target') ?? process.env.XCP_BUILD_TARGET ?? positionalTarget()
const xrayVersion = arg('xray-version') ?? process.env.XRAY_VERSION ?? DEFAULT_XRAY_VERSION
const mirror = arg('mirror') ?? process.env.XRAY_DOWNLOAD_MIRROR
const offline = flag('offline')
const skipWeb = flag('skip-web')
const fetchOnly = flag('fetch-only')

// ------------------------------------------------------------------ 工具
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function log(msg: string): void {
  console.log('[build] ' + msg)
}

async function run(cmd: string[], cwd = root): Promise<void> {
  log('$ ' + cmd.join(' '))
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  const code = await proc.exited
  if (code !== 0) throw new Error('命令失败（exit ' + code + '）：' + cmd.join(' '))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 镜像前缀：https://ghfast.top/ 或模板 https://mirror/{url}。 */
function mirrorUrl(githubUrl: string): string {
  if (!mirror) return githubUrl
  return mirror.includes('{url}')
    ? mirror.replace('{url}', githubUrl)
    : mirror.replace(/\/+$/, '') + '/' + githubUrl
}

async function fetchOk(url: string, label: string, attempts = 3): Promise<Response> {
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(300_000),
        headers: { 'user-agent': 'xc-p-build' },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
      return res
    } catch (e) {
      last = e
      if (i < attempts) {
        console.warn('[build] ' + label + ' 获取失败（第 ' + i + '/' + attempts + ' 次）：' + (e instanceof Error ? e.message : String(e)))
        await sleep(1000 * i)
      }
    }
  }
  throw new Error(label + ' 获取失败：' + (last instanceof Error ? last.message : String(last)))
}

function releaseUrl(asset: string): string {
  return 'https://github.com/XTLS/Xray-core/releases/download/' + xrayVersion + '/' + asset
}

/** 下载（或复用缓存）Xray 发行 zip，并用 .dgst 校验 SHA2-256。 */
async function ensureZip(assetName: string): Promise<Buffer> {
  const cacheDir = join(root, '.cache', 'xray', xrayVersion)
  const zipPath = join(cacheDir, assetName)
  const dgstPath = zipPath + '.dgst'
  mkdirSync(cacheDir, { recursive: true })

  // 1) .dgst（小文件；缓存优先，离线时允许缺失）
  let digestText: string | null = null
  if (existsSync(dgstPath)) {
    digestText = readFileSync(dgstPath, 'utf8')
  } else if (!offline) {
    try {
      const res = await fetchOk(mirrorUrl(releaseUrl(assetName + '.dgst')), assetName + '.dgst')
      digestText = await res.text()
      writeFileSync(dgstPath, digestText)
    } catch (e) {
      console.warn('[build] 未取到 .dgst（将跳过 SHA256 校验）：' + (e instanceof Error ? e.message : String(e)))
    }
  }
  const expected = digestText ? parseDigestSha256(digestText) : null

  // 2) zip：缓存命中且哈希一致则复用
  let bytes: Buffer | null = existsSync(zipPath) ? readFileSync(zipPath) : null
  if (bytes && expected && sha256Hex(bytes) !== expected) {
    console.warn('[build] 缓存压缩包校验失败，重新下载：' + zipPath)
    bytes = null
  }
  if (!bytes) {
    if (offline) throw new Error('离线模式下缺少缓存：' + zipPath)
    const url = mirrorUrl(releaseUrl(assetName))
    log('下载 ' + assetName + ' ← ' + url)
    const res = await fetchOk(url, assetName)
    bytes = Buffer.from(await res.arrayBuffer())
    const actual = sha256Hex(bytes)
    if (expected && actual !== expected) {
      throw new Error('Xray 发行包 SHA256 校验失败：' + actual + ' != ' + expected)
    }
    writeFileSync(zipPath + '.part', bytes)
    renameSync(zipPath + '.part', zipPath)
    log('已缓存 ' + zipPath + '（' + mb(bytes.byteLength) + '）')
  } else {
    log('使用缓存 ' + zipPath + '（' + mb(bytes.byteLength) + '）')
  }

  if (expected) log('SHA2-256 校验通过：' + expected)
  return bytes
}

/** 取出版本包里的 xray 可执行文件，并缓存到 .cache/xray/<version>/<asset>/<binary>。 */
function extractBinary(zip: Uint8Array, assetName: string, binaryName: string): { path: string; bytes: Uint8Array } {
  const data = extractZipEntry(zip, binaryName)
  if (data.byteLength < 1024 * 1024) throw new Error('解出的 ' + binaryName + ' 只有 ' + data.byteLength + ' 字节，疑似损坏')
  const dir = join(root, '.cache', 'xray', xrayVersion, assetName.replace(/\.zip$/, ''))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, binaryName)
  writeFileSync(path, data)
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return { path, bytes: data }
}

/** 生成 embedded.generated.ts 的临时内容（编译后由调用方恢复占位版本）。 */
function generatedModule(info: {
  path: string
  version: string
  platform: string
  arch: string
  filename: string
  sha256: string
  size: number
}): string {
  let rel = relative(dirname(generatedPath), info.path).split(sep).join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return [
    '// @ts-nocheck',
    '// 由 scripts/build-exe.ts 于 ' + new Date().toISOString() + ' 生成；编译结束后会恢复占位版本，请勿提交。',
    'import xrayBinary from ' + JSON.stringify(rel) + ' with { type: "file" }',
    '',
    'export interface EmbeddedXrayInfo {',
    '  file: string',
    '  version: string',
    "  platform: 'win32' | 'linux' | 'darwin'",
    "  arch: 'x64' | 'arm64' | 'arm'",
    "  filename: 'xray' | 'xray.exe'",
    '  sha256: string',
    '  size: number',
    '}',
    '',
    'export const EMBEDDED_XRAY: EmbeddedXrayInfo = {',
    '  file: xrayBinary as unknown as string,',
    '  version: ' + JSON.stringify(info.version) + ',',
    '  platform: ' + JSON.stringify(info.platform) + ' as EmbeddedXrayInfo["platform"],',
    '  arch: ' + JSON.stringify(info.arch) + ' as EmbeddedXrayInfo["arch"],',
    '  filename: ' + JSON.stringify(info.filename) + ' as EmbeddedXrayInfo["filename"],',
    '  sha256: ' + JSON.stringify(info.sha256) + ',',
    '  size: ' + String(info.size) + ',',
    '}',
    '',
  ].join('\n')
}

function outputBase(target: XrayBuildTarget): string {
  const explicit = arg('outfile')
  if (explicit) return explicit
  if (target.native) return 'dist/xc-p'
  const os = target.platform === 'win32' ? 'windows' : target.platform
  return 'dist/xc-p-' + os + '-' + target.arch
}

function statOutput(outBase: string): string | null {
  const abs = resolve(root, outBase)
  for (const candidate of [abs, abs + '.exe']) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

// ------------------------------------------------------------------ 主流程
async function main(): Promise<void> {
  const target = parseBuildTarget(targetArg)
  log(
    '目标平台：' + target.platform + '/' + target.arch +
      (target.native ? '（当前构建机）' : '（交叉编译 ' + target.bunTarget + '）') +
      ' · Xray ' + xrayVersion,
  )
  const { assetName, binaryName } = xrayReleaseAsset(target)

  if (!skipWeb && !fetchOnly) {
    log('构建前端并嵌入控制面')
    await run(['bun', 'run', 'web:build'])
  }

  const zip = await ensureZip(assetName)
  const binary = extractBinary(zip, assetName, binaryName)
  const sha256 = sha256Hex(binary.bytes)
  log('Xray 二进制：' + binary.path + '（' + mb(binary.bytes.byteLength) + '，sha256=' + sha256.slice(0, 12) + '…）')

  if (fetchOnly) {
    log('--fetch-only：跳过编译')
    return
  }

  const stub = readFileSync(generatedPath, 'utf8')
  const module_ = generatedModule({
    path: binary.path,
    version: xrayVersion,
    platform: target.platform,
    arch: target.arch,
    filename: binaryName,
    sha256,
    size: binary.bytes.byteLength,
  })
  writeFileSync(generatedPath, module_)
  try {
    const outBase = outputBase(target)
    mkdirSync(dirname(resolve(root, outBase)), { recursive: true })
    await run([
      'bun',
      'build',
      '--compile',
      '--minify',
      '--target=' + target.bunTarget,
      '--outfile',
      outBase,
      join('apps', 'server', 'src', 'index.ts'),
    ])
    const out = statOutput(outBase)
    if (!out) throw new Error('编译结束但未找到产物：' + outBase)
    log('完成：' + out + '（' + mb(statSync(out).size) + '，含内嵌 Xray ' + xrayVersion + '）')
  } finally {
    writeFileSync(generatedPath, stub)
    log('已恢复 embedded.generated.ts 占位版本')
  }
}

await main().catch((e) => {
  console.error('[build] 失败：' + (e instanceof Error ? (e.stack ?? e.message) : String(e)))
  process.exit(1)
})

// I have nothing but my burger and I want nothing more

