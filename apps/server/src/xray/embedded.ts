/**
 * 内嵌 Xray 二进制的运行时解出（PANEL.md §14.1 的新形态）。
 *
 * `bun build --compile` 的内嵌文件是虚拟路径（如 `B:/~BUN/root/...`），只能读取、
 * 不能直接执行；所以启动时把内嵌的 xray[.exe] 落盘到 `DATA_DIR/bin/`，校验 SHA256 后
 * 交给 XrayProcess / XrayCli 使用。已存在且哈希一致时直接复用，避免每次启动重复写 30MB。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config'
import { logger } from '../core/log'
import { EMBEDDED_XRAY, type EmbeddedXrayInfo } from './embedded.generated'

export type { EmbeddedXrayInfo }

export interface MaterializedBinary {
  path: string
  /** 便于日志展示的来源描述 */
  source: string
}

let cache: MaterializedBinary | null | undefined
let warnedMismatch = false

/** 当前可执行文件是否携带内嵌 Xray（源码运行时为 null）。 */
export function embeddedXrayInfo(): EmbeddedXrayInfo | null {
  return EMBEDDED_XRAY
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 校验已解出的文件是否与内嵌版本一致（不一致或不可读返回 false）。 */
function existingMatches(path: string, expected: string, size: number): boolean {
  try {
    if (!existsSync(path) || statSync(path).size !== size) return false
    return sha256(readFileSync(path)) === expected
  } catch {
    return false
  }
}

/**
 * 把内嵌的 Xray 解出到 `DATA_DIR/bin/xray[.exe]` 并返回路径。
 * 未内嵌 / 平台不匹配 / 解出失败时返回 null，由调用方回退到外部二进制。
 */
export function materializeEmbeddedXray(): MaterializedBinary | null {
  if (cache !== undefined) return cache
  cache = null
  const info = EMBEDDED_XRAY
  if (!info) return null

  if (info.platform !== process.platform || info.arch !== process.arch) {
    if (!warnedMismatch) {
      warnedMismatch = true
      logger.warn(
        '内嵌 Xray 面向 ' + info.platform + '/' + info.arch + '，当前运行环境是 ' +
          process.platform + '/' + process.arch + '，已忽略内嵌二进制并回退到外部查找',
      )
    }
    return null
  }

  const target = join(paths.bin, info.filename)
  const label = '内嵌 Xray ' + info.version + '（' + info.platform + '/' + info.arch + '）'
  try {
    if (existingMatches(target, info.sha256, info.size)) {
      cache = { path: target, source: label + ' · 已解出' }
      logger.debug('复用已解出的内嵌 Xray：' + target)
      return cache
    }
    const data = readFileSync(info.file)
    if (data.byteLength !== info.size) {
      throw new Error('内嵌文件长度不符：' + data.byteLength + ' != ' + info.size)
    }
    const actual = sha256(data)
    if (actual !== info.sha256) {
      throw new Error('内嵌文件 SHA256 不符：' + actual + ' != ' + info.sha256)
    }
    mkdirSync(paths.bin, { recursive: true })
    const tmp = target + '.tmp-' + process.pid
    writeFileSync(tmp, data)
    if (process.platform !== 'win32') chmodSync(tmp, 0o755)
    try {
      renameSync(tmp, target)
    } catch (e) {
      // Windows 上正在运行的旧 xray.exe 可能仍被占用：先删再改名（仍失败则交给上层回退）。
      try {
        rmSync(target, { force: true })
        renameSync(tmp, target)
      } catch {
        rmSync(tmp, { force: true })
        throw e
      }
    }
    if (process.platform !== 'win32') chmodSync(target, 0o755)
    cache = { path: target, source: label }
    logger.info(label + ' 已解出到 ' + target + '（' + (data.byteLength / 1024 / 1024).toFixed(1) + ' MB）')
    return cache
  } catch (e) {
    logger.error('内嵌 Xray 解出失败，回退到外部二进制：' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

/** 仅供测试：清空解出缓存。 */
export function resetEmbeddedCache(): void {
  cache = undefined
  warnedMismatch = false
}
