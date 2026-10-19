/**
 * 生成 v4+ 迁移：
 *  1. 跑 drizzle-kit generate（对比 drizzle/meta 的快照与 src/core/schema.ts）；
 *  2. 把产出的 SQL 写进 apps/server/src/core/migrations.generated.ts。
 *
 * 版本映射：drizzle/0000_*.sql 是基线（描述 v1-v3 的结果），**永不执行**；
 * drizzle/0001_*.sql -> version 4，0002 -> 5，以此类推，与 core/migrations.ts 里手写的 v1-v3 接续。
 *
 * 生成成 TS 模块（而不是运行时读目录），是为了 bun build --compile 的单文件产物仍带上迁移。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const serverDir = join(root, 'apps', 'server')
const drizzleDir = join(serverDir, 'drizzle')
const outFile = join(serverDir, 'src', 'core', 'migrations.generated.ts')

const BASE_VERSION = 3 // v1-v3 是手写历史迁移，drizzle 从 v4 接着排

console.log('[db] drizzle-kit generate …')
const proc = Bun.spawn(['bunx', 'drizzle-kit', 'generate', '--config', 'drizzle.config.ts'], {
  cwd: serverDir,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await proc.exited) !== 0) {
  console.error('[db] drizzle-kit generate 失败')
  process.exit(1)
}

const files = readdirSync(drizzleDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
const out: string[] = []
for (const f of files) {
  const idx = Number(f.slice(0, 4))
  if (idx === 0) continue // 基线：v1-v3 已经把同样的表建出来了，重复执行会报错
  const version = BASE_VERSION + idx
  const name = f.slice(5).replace(/\.sql$/, '').replace(/_/g, '-')
  const statements = readFileSync(join(drizzleDir, f), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim().replace(/;+$/, ''))
    .filter(Boolean)
  const sql = statements.join(';\n') + ';'
  out.push('  { version: ' + version + ', name: ' + JSON.stringify(name) + ', sql: ' + JSON.stringify(sql) + ' },')
  console.log('[db] drizzle ' + f + ' -> version ' + version + ' (' + name + ')')
}

const header = [
  '/**',
  ' * 由 scripts/db-generate.ts 生成，勿手改。',
  ' *',
  ' * drizzle/0000_*.sql 是基线，描述的是 v1-v3 建表后的结果，**不会被执行**；',
  ' * drizzle/0001_*.sql 起才映射为 version 4、5 … 依次应用。',
  ' *',
  ' * 生成成 TS 模块而不是运行时读目录，是为了 bun build --compile 的单文件产物仍能带上迁移。',
  ' */',
  'export const DRIZZLE_MIGRATIONS: { version: number; name: string; sql: string }[] = [',
]
writeFileSync(outFile, header.concat(out, ']', '').join('\n'))
console.log('[db] 写入 ' + outFile + '（' + out.length + ' 条 v4+ 迁移）')
