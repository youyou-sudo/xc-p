/**
 * Xray-core 发行包与 Bun 交叉编译目标的映射工具。
 *
 * 只做纯计算（不联网、不写盘），供两处复用：
 * - `scripts/build-exe.ts`：构建时按目标平台下载 Xray 并解出二进制，再嵌入可执行文件；
 * - `apps/server/test/xray-embedded.test.ts`：对映射与 zip 提取做单测。
 */
import { inflateRawSync } from 'node:zlib'

/** 默认内嵌的 Xray 发行版本；可用 --xray-version / XRAY_VERSION 覆盖。 */
export const DEFAULT_XRAY_VERSION = 'v26.3.27'

/** Xray 官方发行包覆盖的平台（与 Bun --compile 的可用目标取交集）。 */
export type XrayPlatform = 'win32' | 'linux' | 'darwin'
export type XrayArch = 'x64' | 'arm64' | 'arm'

export interface XrayBuildTarget {
  /** 传给 `bun build --compile` 的 target；`bun` 表示当前构建机。 */
  bunTarget: string
  platform: XrayPlatform
  arch: XrayArch
  /** 目标平台与构建机一致 */
  native: boolean
}

const OS_ALIASES: Record<string, XrayPlatform> = {
  windows: 'win32',
  win: 'win32',
  win32: 'win32',
  linux: 'linux',
  darwin: 'darwin',
  macos: 'darwin',
  mac: 'darwin',
  osx: 'darwin',
}

const ARCH_ALIASES: Record<string, XrayArch> = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  arm: 'arm',
  armv7: 'arm',
  armv7a: 'arm',
  armhf: 'arm',
}

/** Xray 发行包后缀（Xray-<suffix>.zip） */
const RELEASE_SUFFIX: Record<string, string> = {
  'win32-x64': 'windows-64',
  'win32-arm64': 'windows-arm64-v8a',
  'linux-x64': 'linux-64',
  'linux-arm64': 'linux-arm64-v8a',
  'linux-arm': 'linux-arm32-v7a',
  'darwin-x64': 'macos-64',
  'darwin-arm64': 'macos-arm64-v8a',
}

function hostPlatform(): XrayPlatform {
  const p = process.platform
  if (p === 'win32' || p === 'linux' || p === 'darwin') return p
  throw new Error('当前构建平台 ' + p + ' 不受支持（Bun --compile 仅支持 win32 / linux / darwin）')
}

function hostArch(): XrayArch {
  const a = process.arch
  if (a === 'x64' || a === 'arm64' || a === 'arm') return a
  throw new Error('当前构建架构 ' + a + ' 不受支持（仅支持 x64 / arm64 / arm）')
}

/**
 * 解析打包目标：
 * - 省略 / `bun` / `host`：当前平台；
 * - `bun-linux-x64`、`bun-windows-x64-baseline`、`linux-arm64`、`darwin-arm64` 等。
 *
 * 未知后缀（baseline / modern / musl）原样交给 bun，只取前两段做 Xray 发行包映射。
 */
export function parseBuildTarget(input?: string): XrayBuildTarget {
  const raw = (input ?? '').trim()
  if (!raw || raw === 'bun' || raw === 'host' || raw === 'native') {
    return { bunTarget: 'bun', platform: hostPlatform(), arch: hostArch(), native: true }
  }
  const normalized = raw.startsWith('bun-') ? raw : 'bun-' + raw
  const parts = normalized.slice('bun-'.length).split('-')
  const os = OS_ALIASES[parts[0] ?? '']
  const arch = ARCH_ALIASES[parts[1] ?? '']
  if (!os || !arch) {
    throw new Error(
      '无法识别打包目标「' + raw + '」。示例：bun-windows-x64、bun-linux-x64、bun-linux-arm64、bun-darwin-arm64',
    )
  }
  return {
    bunTarget: normalized,
    platform: os,
    arch,
    native: os === hostPlatform() && arch === hostArch(),
  }
}

/** 目标平台对应的 Xray 发行包名与包内的可执行文件名。 */
export function xrayReleaseAsset(target: Pick<XrayBuildTarget, 'platform' | 'arch'>): {
  assetName: string
  binaryName: 'xray' | 'xray.exe'
} {
  const suffix = RELEASE_SUFFIX[target.platform + '-' + target.arch]
  if (!suffix) {
    throw new Error(
      'Xray 官方没有 ' + target.platform + '/' + target.arch + ' 的发行包，无法内嵌；可选：' +
        Object.keys(RELEASE_SUFFIX).join('、'),
    )
  }
  return { assetName: 'Xray-' + suffix + '.zip', binaryName: target.platform === 'win32' ? 'xray.exe' : 'xray' }
}

/** 从 .dgst 文本里取 SHA2-256（形如 `SHA2-256= <hex>`）。 */
export function parseDigestSha256(digestText: string): string | null {
  const m = /SHA2-256\s*=\s*([0-9a-f]{64})/i.exec(digestText)
  return m?.[1]?.toLowerCase() ?? null
}

function crc32(data: Uint8Array): number {
  let table = CRC_TABLE
  if (!table) {
    table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    CRC_TABLE = table
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

let CRC_TABLE: Uint32Array | null = null

/**
 * 从 zip 中提取单个文件（Xray 官方只发 zip，而 Bun.Archive 只支持 tar）。
 * 支持 store(0) / deflate(8) 两种压缩方式，并按中央目录校验长度与 CRC32。
 */
export function extractZipEntry(zip: Uint8Array, entryName: string): Uint8Array {
  if (zip.byteLength < 22) throw new Error('zip 文件过小，无法解析')
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const u16 = (o: number) => dv.getUint16(o, true)
  const u32 = (o: number) => dv.getUint32(o, true)

  // End of central directory：从尾部向前找（可能带 comment）
  let eocd = -1
  const budget = Math.min(zip.byteLength - 22, 65557)
  for (let i = 0; i <= budget; i++) {
    const at = zip.byteLength - 22 - i
    if (u32(at) !== 0x06054b50) continue
    if (at + 22 + u16(at + 20) === zip.byteLength) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（缺少 EOCD）')

  const total = u16(eocd + 10)
  let off = u32(eocd + 16)
  const wanted = entryName.replace(/\\/g, '/').replace(/^\/+/, '')
  const names: string[] = []

  for (let i = 0; i < total; i++) {
    if (u32(off) !== 0x02014b50) throw new Error('zip 中央目录损坏（偏移 ' + off + '）')
    const flags = u16(off + 8)
    const method = u16(off + 10)
    const expectedCrc = u32(off + 16)
    const compressedSize = u32(off + 20)
    const uncompressedSize = u32(off + 24)
    const nameLen = u16(off + 28)
    const extraLen = u16(off + 30)
    const commentLen = u16(off + 32)
    const localOffset = u32(off + 42)
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commentLen
    names.push(name)
    if (name !== wanted) continue
    if (flags & 1) throw new Error('zip 内 ' + wanted + ' 已加密，无法提取')
    if (uncompressedSize > 512 * 1024 * 1024) throw new Error('zip 内 ' + wanted + ' 解压后过大，已拒绝')
    if (u32(localOffset) !== 0x04034b50) throw new Error('zip 内 ' + wanted + ' 的本地头损坏')
    const localNameLen = u16(localOffset + 26)
    const localExtraLen = u16(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compressedSize > zip.byteLength) throw new Error('zip 数据越界')
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    let data: Uint8Array
    if (method === 0) data = raw.slice()
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw))
    else throw new Error('不支持的 zip 压缩方式 ' + method + '（仅支持 store/deflate）')
    if (data.byteLength !== uncompressedSize) {
      throw new Error('zip 内 ' + wanted + ' 长度不符：' + data.byteLength + ' != ' + uncompressedSize)
    }
    if (crc32(data) !== expectedCrc) throw new Error('zip 内 ' + wanted + ' CRC32 校验失败')
    return data
  }
  throw new Error('zip 内未找到 ' + wanted + '（包内文件：' + names.join(', ') + '）')
}
