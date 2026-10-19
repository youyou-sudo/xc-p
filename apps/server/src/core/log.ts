import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
let fileReady = false

 function writeFile(line: string) {
  try {
    if (!fileReady) {
      mkdirSync(paths.logs, { recursive: true })
      fileReady = true
    }
    appendFileSync(join(paths.logs, 'panel.log'), line + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function log(level: LogLevel, msg: string, detail?: unknown) {
  if (ORDER[level] < ORDER[minLevel]) return
  const ts = new Date().toISOString()
  const suffix = detail === undefined ? '' : ' ' + safeJson(detail)
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}${suffix}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  writeFile(line)
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const logger = {
  debug: (m: string, d?: unknown) => log('debug', m, d),
  info: (m: string, d?: unknown) => log('info', m, d),
  warn: (m: string, d?: unknown) => log('warn', m, d),
  error: (m: string, d?: unknown) => log('error', m, d),
}
