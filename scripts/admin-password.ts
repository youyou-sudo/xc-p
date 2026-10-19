#!/usr/bin/env bun
/**
 * 重置面板管理员口令（不需要删除数据库）。
 *
 * 用法：
 *   bun run admin:password 新口令
 *   bun run admin:password 新口令 --user 管理员用户名
 *
 * 说明：口令只以 argon2id 哈希入库；重置后会吊销全部现有会话。
 */
import { Database } from 'bun:sqlite'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const dataDir = resolve(process.env.DATA_DIR || join(process.cwd(), 'data'))
const dbFile = join(dataDir, 'sb.db')

const args = process.argv.slice(2)
const userFlagIdx = args.indexOf('--user')
const username = userFlagIdx >= 0 ? args[userFlagIdx + 1] : undefined
// 注意：只有真的出现 --user 时才剔除这两个位置，否则会把口令本身过滤掉
const rest = userFlagIdx >= 0 ? args.filter((_, i) => i !== userFlagIdx && i !== userFlagIdx + 1) : args
const password = rest.join(' ').trim()

if (!password) {
  console.error('用法：bun run admin:password <新口令> [--user <用户名>]')
  console.error('例如：bun run admin:password "my-strong-passphrase"')
  process.exit(2)
}
if (password.length < 8) {
  console.error('口令太短：至少 8 位。')
  process.exit(2)
}
if (!existsSync(dbFile)) {
  console.error('未找到数据库：' + dbFile)
  console.error('请先启动一次面板（DATA_DIR=' + dataDir + '）以便初始化数据库，或设置正确的 DATA_DIR。')
  process.exit(2)
}

const db = new Database(dbFile)
try {
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
  const existing = db.query('SELECT id, username FROM admin LIMIT 1').get() as { id: number; username: string } | null
  const name = username || existing?.username || 'admin'
  if (existing) {
    db.run('UPDATE admin SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?', [name, hash, Date.now(), existing.id])
  } else {
    db.run('INSERT INTO admin (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)', [name, hash, Date.now()])
  }
  const revoked = db.run('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL', [Date.now()])
  console.log('已重置管理员口令')
  console.log('  数据库：' + dbFile)
  console.log('  用户名：' + name)
  console.log('  已吊销会话：' + revoked.changes + ' 个')
  console.log('现在可以用新口令登录面板。')
} finally {
  db.close()
}
