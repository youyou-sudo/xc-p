/**
 * 验收总入口：bun run scripts/verify/run-all.ts
 * 结果写入 docs/VERIFY-REPORT.md（原始机器证据），人工结论见 docs/PANEL-COMPLIANCE.md。
 */
import { runAcceptance, type CheckResult } from './ac'
import { REPO } from './harness'
import { join } from 'node:path'

const started = Date.now()
const results: CheckResult[] = await runAcceptance()
const durationMs = Date.now() - started

const pass = results.filter((r) => r.status === 'pass').length
const fail = results.filter((r) => r.status === 'fail').length
const partial = results.filter((r) => r.status === 'partial').length
const skip = results.filter((r) => r.status === 'skip').length

const lines: string[] = []
lines.push('# 验收执行报告（自动生成）')
lines.push('')
lines.push('> 由 `bun run scripts/verify/run-all.ts` 生成，日期：' + new Date().toISOString())
lines.push('> 环境：Bun ' + Bun.version + ' / ' + process.platform + ' / Xray ' + (process.env.XRAY_BINARY || '.tools/xray'))
lines.push('')
lines.push('| 汇总 | 数量 |')
lines.push('| --- | --- |')
lines.push('| pass | ' + pass + ' |')
lines.push('| partial | ' + partial + ' |')
lines.push('| fail | ' + fail + ' |')
lines.push('| skip | ' + skip + ' |')
lines.push('| 总耗时 | ' + (durationMs / 1000).toFixed(1) + 's |')
lines.push('')
lines.push('## 逐项结果')
lines.push('')
lines.push('| ID | 验收项 | 结果 | 说明 |')
lines.push('| --- | --- | --- | --- |')
for (const r of results) {
  lines.push('| ' + r.id + ' | ' + r.title + ' | ' + r.status.toUpperCase() + ' | ' + r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' |')
}
lines.push('')
lines.push('## 证据明细')
lines.push('')
for (const r of results) {
  lines.push('### ' + r.id + ' · ' + r.title + ' — ' + r.status.toUpperCase())
  lines.push('')
  lines.push('判定：' + r.detail)
  lines.push('')
  if (r.evidence.length) {
    lines.push('```text')
    for (const e of r.evidence) lines.push(e.replace(/\n/g, '\n'))
    lines.push('```')
    lines.push('')
  }
}

const out = lines.join('\n')
await Bun.write(join(REPO, 'docs', 'VERIFY-REPORT.md'), out)
console.log('')
console.log('===== 验收汇总：pass=' + pass + ' partial=' + partial + ' fail=' + fail + ' skip=' + skip + ' =====')
console.log('报告已写入 docs/VERIFY-REPORT.md')
for (const r of results.filter((x) => x.status === 'fail')) console.log('FAIL ' + r.id + ': ' + r.detail)
process.exit(fail > 0 ? 1 : 0)
