import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { paths } from '../config'
import { materializeEmbeddedXray } from './embedded'

export interface XrayBinaryResolution {
  path: string
  source: string
}

const cache = new Map<string, XrayBinaryResolution | null>()

/** 默认二进制名：这类值视为「自动」，让内嵌二进制优先于 PATH，保证打包版版本一致。 */
const DEFAULT_NAMES = new Set(['xray', 'xray.exe'])

/**
 * 解析 xray 二进制路径。查找顺序（命中即停）：
 *   1. 显式配置且带路径分隔符（settings.xray.binary / XRAY_BINARY）
 *   2. 显式配置的**非默认**名字在 PATH 上的位置
 *   3. 内嵌二进制（bun build --compile 打包时嵌入，解出到 DATA_DIR/bin）
 *   4. 默认名字 xray / xray.exe 在 PATH 上
 *   5. 常见本地开发位置：<cwd>/.tools、<cwd>/bin、DATA_DIR/bin、仓库根/.tools
 *
 * 打包版把内嵌二进制排在 PATH 之前：面板默认 settings.xray.binary = "xray"，
 * 不能让宿主机上碰巧存在的旧 xray 顶掉构建时固定并校验过的版本；显式路径
 * 与显式名字仍然可以覆盖（用于本地开发与外置模式）。
 */
export function resolveXrayBinary(preferred?: string, cwd = process.cwd()): XrayBinaryResolution | null {
  const key = (preferred ?? '') + '|' + cwd
  if (cache.has(key)) return cache.get(key)!

  const candidates: { path: string; source: string }[] = []
  const names = process.platform === 'win32' ? ['xray.exe', 'xray'] : ['xray', 'xray.exe']
  const baseNames = [...names, 'xray.exe', 'xray']

  const pushExplicit = (value: string | undefined, source: string) => {
    if (!value) return
    if (isAbsolute(value) || value.includes('/') || value.includes('\\')) {
      candidates.push({ path: value, source })
    } else if (!DEFAULT_NAMES.has(value)) {
      const found = which(value)
      if (found) candidates.push({ path: found, source: source + ' (PATH)' })
    }
  }

  pushExplicit(preferred, 'settings.xray.binary')
  pushExplicit(process.env.XRAY_BINARY, 'XRAY_BINARY')

  const embedded = materializeEmbeddedXray()
  if (embedded) candidates.push({ path: embedded.path, source: embedded.source })

  for (const n of baseNames) {
    const found = which(n)
    if (found) candidates.push({ path: found, source: 'PATH' })
  }
  const roots = [cwd, join(cwd, '..'), process.env.DATA_DIR, paths.runtime].filter(Boolean) as string[]
  for (const root of roots) {
    for (const sub of ['.tools', 'bin', 'vendor']) {
      for (const n of baseNames) candidates.push({ path: join(root, sub, n), source: sub + '/' + n })
    }
  }

  for (const c of candidates) {
    try {
      if (existsSync(c.path) && statSync(c.path).isFile()) {
        const res = { path: c.path, source: c.source }
        cache.set(key, res)
        return res
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  cache.set(key, null)
  return null
}

export function which(name: string): string | null {
  try {
    const found = Bun.which(name)
    return found ?? null
  } catch {
    return null
  }
}

/** 找不到时的可执行提示 */
export function xrayNotFoundHint(preferred?: string): string {
  const tried = [
    'settings.xray.binary = ' + (preferred || '(未设置)'),
    'XRAY_BINARY 环境变量',
    '内嵌二进制（仅 bun build --compile 产物提供）',
    'PATH 上的 xray / xray.exe',
    '常见本地位置：./.tools/xray[.exe]、./bin/xray[.exe]、$DATA_DIR/bin/xray[.exe]',
  ]
  return (
    '未找到 Xray 二进制。已尝试：' +
    tried.join('；') +
    '。可执行：① 用 bun run build:exe 重新打包（构建时会把对应平台的 Xray 嵌入可执行文件）；' +
    '② 设置 XRAY_BINARY=/abs/path/to/xray；③ 在面板「系统设置 → xray.binary」填写绝对路径。'
  )
}
 
