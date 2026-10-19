import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import {
  DEFAULT_XRAY_VERSION,
  extractZipEntry,
  parseBuildTarget,
  parseDigestSha256,
  xrayReleaseAsset,
} from '../src/xray/release'
import { EMBEDDED_XRAY } from '../src/xray/embedded.generated'
import { materializeEmbeddedXray, resetEmbeddedCache } from '../src/xray/embedded'
import { eq } from 'drizzle-orm'
import { openDb } from '../src/core/db'
import { settings as settingsTable } from '../src/core/schema'
import { SettingsStore } from '../src/core/settings'

describe('Xray 打包目标映射', () => {
  test('交叉编译目标解析出平台与架构', () => {
    expect(parseBuildTarget('bun-windows-x64')).toMatchObject({ platform: 'win32', arch: 'x64', bunTarget: 'bun-windows-x64' })
    expect(parseBuildTarget('bun-linux-x64')).toMatchObject({ platform: 'linux', arch: 'x64' })
    expect(parseBuildTarget('bun-linux-arm64')).toMatchObject({ platform: 'linux', arch: 'arm64' })
    expect(parseBuildTarget('bun-darwin-arm64')).toMatchObject({ platform: 'darwin', arch: 'arm64' })
    expect(parseBuildTarget('linux-x64-baseline')).toMatchObject({ bunTarget: 'bun-linux-x64-baseline', platform: 'linux', arch: 'x64' })
  })

  test('省略目标时使用当前构建机', () => {
    const native = parseBuildTarget()
    expect(native.native).toBe(true)
    expect(native.bunTarget).toBe('bun')
  })

  test('未知目标报错而不是静默产出错误平台', () => {
    expect(() => parseBuildTarget('bun-plan9-x64')).toThrow()
    expect(() => parseBuildTarget('bun-linux-sparc')).toThrow()
  })

  test('发行包名与包内文件名', () => {
    expect(xrayReleaseAsset({ platform: 'win32', arch: 'x64' })).toEqual({ assetName: 'Xray-windows-64.zip', binaryName: 'xray.exe' })
    expect(xrayReleaseAsset({ platform: 'win32', arch: 'arm64' })).toEqual({ assetName: 'Xray-windows-arm64-v8a.zip', binaryName: 'xray.exe' })
    expect(xrayReleaseAsset({ platform: 'linux', arch: 'x64' })).toEqual({ assetName: 'Xray-linux-64.zip', binaryName: 'xray' })
    expect(xrayReleaseAsset({ platform: 'linux', arch: 'arm64' })).toEqual({ assetName: 'Xray-linux-arm64-v8a.zip', binaryName: 'xray' })
    expect(xrayReleaseAsset({ platform: 'darwin', arch: 'arm64' })).toEqual({ assetName: 'Xray-macos-arm64-v8a.zip', binaryName: 'xray' })
    expect(() => xrayReleaseAsset({ platform: 'win32', arch: 'arm' })).toThrow()
  })

  test('默认版本是 v 前缀的 Xray tag', () => {
    expect(DEFAULT_XRAY_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  test('.dgst 解析 SHA2-256', () => {
    const text = 'MD5= 402f\nSHA1= 42e5\nSHA2-256= d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad\nSHA2-512= 5b13'
    expect(parseDigestSha256(text)).toBe('d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad')
    expect(parseDigestSha256('nothing here')).toBeNull()
  })
})

// ------------------------------------------------------------------ 最小 zip 构造（只用于测试 extractZipEntry）
function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(entries: { name: string; data: Uint8Array; method: 0 | 8 }[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const payload = entry.method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
    const crc = crc32(entry.data)

    const local = new Uint8Array(30 + name.length + payload.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, entry.method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, payload.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(payload, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, entry.method, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, entry.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const chunk of [...locals, ...centrals, eocd]) {
    total.set(chunk, at)
    at += chunk.length
  }
  return total
}

describe('Xray 发行 zip 提取', () => {
  const payload = new TextEncoder().encode('Xray 26.3.27 test payload '.repeat(40))

  test('支持 store 与 deflate，且只取目标文件', () => {
    const zip = buildZip([
      { name: 'README.md', data: new TextEncoder().encode('readme'), method: 0 },
      { name: 'xray.exe', data: payload, method: 8 },
      { name: 'geoip.dat', data: new TextEncoder().encode('geo'), method: 0 },
    ])
    expect(Array.from(extractZipEntry(zip, 'xray.exe'))).toEqual(Array.from(payload))
  })

  test('支持 store 方式', () => {
    const zip = buildZip([{ name: 'xray', data: payload, method: 0 }])
    expect(new TextDecoder().decode(extractZipEntry(zip, 'xray'))).toBe(new TextDecoder().decode(payload))
  })

  test('文件缺失 / 非 zip 时报错', () => {
    const zip = buildZip([{ name: 'xray', data: payload, method: 0 }])
    expect(() => extractZipEntry(zip, 'xray.exe')).toThrow(/未找到/)
    expect(() => extractZipEntry(new Uint8Array(64), 'xray')).toThrow()
  })

  test('CRC32 损坏时报错', () => {
    const zip = buildZip([{ name: 'xray', data: payload, method: 8 }])
    // 中央目录里的 CRC 位于中央目录偏移 16；找到它并翻转一位
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    let eocd = -1
    for (let i = zip.byteLength - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    const centralOffset = dv.getUint32(eocd + 16, true)
    zip[centralOffset + 16] ^= 0xff
    expect(() => extractZipEntry(zip, 'xray')).toThrow(/CRC32/)
  })
})

describe('后台不再提供 Xray 版本固定', () => {
  test('老数据库里的 xray.versionPin 会被丢弃且不再回写', () => {
    const db = openDb(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    db.insert(settingsTable)
      .values({
        key: 'root',
        value_json: JSON.stringify({ xray: { versionPin: 'v1.2.3', binary: 'xray' } }),
        updated_at: Date.now(),
      })
      .run()
    const store = new SettingsStore(db)
    expect('versionPin' in store.get().xray).toBe(false)
    store.update({ panel: { language: 'zh-CN' } })
    const row = db.select({ value_json: settingsTable.value_json }).from(settingsTable).where(eq(settingsTable.key, 'root')).get()!
    expect('versionPin' in (JSON.parse(row.value_json) as { xray: Record<string, unknown> }).xray).toBe(false)
    db.close()
  })
})

describe('内嵌二进制占位实现', () => {
  test('源码运行时没有内嵌二进制，解出返回 null', () => {
    expect(EMBEDDED_XRAY).toBeNull()
    resetEmbeddedCache()
    expect(materializeEmbeddedXray()).toBeNull()
    resetEmbeddedCache()
    expect(materializeEmbeddedXray()).toBeNull()
  })
})
