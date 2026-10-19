/**
 * 系统级引导参数：只允许来自环境变量（PANEL.md D8）。
 * 其余全部参数在 settings 表里，面板可视化编辑。
 */
import { join, resolve } from 'node:path'

export interface AppConfig {
  /** 持久化目录 */
  dataDir: string
  /** 面板监听端口 */
  panelPort: number
  /** 面板监听地址。默认只绑环回；容器里必须覆盖成 0.0.0.0，否则宿主机访问不到 */
  panelHost: string
  /** 首次启动的管理员口令（之后只存 argon2 哈希） */
  adminPassword: string
  /** 面板管理员用户名 */
  adminUsername: string
  /** 会话/日志时区（仅影响展示） */
  tz: string
  /** 面板资源版本号 */
  panelVersion: string
  /** xray 二进制路径（可由 settings.xray.binary 覆盖） */
  xrayBinary: string
  /** 运行环境 */
  env: string
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** 未设置 ADMIN_PASSWORD 时的内置默认口令（README/面板登录页都会写明） */
export const DEFAULT_ADMIN_PASSWORD = 'change-me-on-first-run'

export function loadConfig(): AppConfig {
  const dataDir = resolve(process.env.DATA_DIR || join(process.cwd(), 'data'))
  return {
    dataDir,
    panelPort: envInt('PANEL_PORT', 8080),
    panelHost: process.env.PANEL_HOST || 'localhost',
    adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    tz: process.env.TZ || 'Asia/Shanghai',
    panelVersion: '0.4.0',
    xrayBinary: process.env.XRAY_BINARY || 'xray',
    env: process.env.NODE_ENV || 'production',
  }
}

export const config: AppConfig = loadConfig()

export const paths = {
  db: join(config.dataDir, 'sb.db'),
  keyfile: join(config.dataDir, 'keyfile'),
  certs: join(config.dataDir, 'certs'),
  runtime: join(config.dataDir, 'runtime'),
  baseConfig: join(config.dataDir, 'runtime', 'base', 'xray.json'),
  logs: join(config.dataDir, 'logs'),
  /** 内嵌 Xray 解出目录（打包版启动时写入 xray[.exe]） */
  bin: join(config.dataDir, 'bin'),
}

/** 确保 DATA_DIR 骨架存在（PANEL.md §14.1） */
export async function ensureDataDirs(): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  for (const dir of [config.dataDir, paths.certs, paths.runtime, join(paths.runtime, 'base'), paths.logs, paths.bin]) {
    await mkdir(dir, { recursive: true })
  }
}
