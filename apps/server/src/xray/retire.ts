import type { Db } from '../core/db'
import { randomId } from '../core/ids'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import type { XrayCli } from './cli'

export interface RetireItem {
  id: string
  kind: 'outbound' | 'inbound' | 'rule'
  tag: string
  node_id: string | null
  revision_id: string | null
  retire_after: number
  done_at: number | null
  error: string | null
}

/**
 * 延迟退休队列（PANEL.md D2 步骤 6 / §9.2 阶段 B）：
 * 旧 outbound 不立刻 rmo，给在途连接一个自然收尾窗口。
 */
export class RetireQueue {
  constructor(
    private db: Db,
    private cli: XrayCli,
    private settings: SettingsStore,
    private events: EventBus,
  ) {}

  enqueue(items: { kind: RetireItem['kind']; tag: string; nodeId?: string | null; revisionId?: string | null }[]): void {
    const delay = this.settings.get().xray.retireDelayMs
    const now = Date.now()
    for (const it of items) {
      if (!it.tag) continue
      // 同一个 tag 可能因为「对账 + 发布」重复进入删除计划，避免排队两次。
      const existing = this.db.get<{ id: string }>(
        'SELECT id FROM pending_retire WHERE kind = ? AND tag = ? AND done_at IS NULL LIMIT 1',
        [it.kind, it.tag],
      )
      if (existing) continue
      this.db.run(
        'INSERT INTO pending_retire (id, kind, tag, node_id, revision_id, retire_after, done_at, error) VALUES (?,?,?,?,?,?,NULL,NULL)',
        [randomId('ret_'), it.kind, it.tag, it.nodeId ?? null, it.revisionId ?? null, now + delay],
      )
    }
  }

  due(now = Date.now(), limit = 200): RetireItem[] {
    return this.db.all<RetireItem>(
      'SELECT * FROM pending_retire WHERE done_at IS NULL AND retire_after <= ? ORDER BY retire_after ASC LIMIT ?',
      [now, limit],
    )
  }

  list(limit = 200): RetireItem[] {
    return this.db.all<RetireItem>('SELECT * FROM pending_retire WHERE done_at IS NULL ORDER BY retire_after ASC LIMIT ?', [limit])
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pending_retire WHERE done_at IS NULL')?.n ?? 0
  }

  /** 已在队列里、尚未完成的 tag（对账时视为已知过渡态，不算漂移） */
  pendingTags(): Set<string> {
    const rows = this.db.all<{ tag: string }>('SELECT tag FROM pending_retire WHERE done_at IS NULL')
    return new Set(rows.map((r) => r.tag))
  }

  /** tag 已经被移除（幂等成功）：xray api 对不存在的 tag 会报错，按文案识别 */
  private alreadyGone(stderr: string): boolean {
    return /not found|not exist|no such|unknown|already|does not exist|failed to find|cannot find/i.test(stderr)
  }

  /** 当前数据面真实存在的 outbound tag；接口不可达时返回 null（保持 pending 重试） */
  private async currentOutboundTags(): Promise<Set<string> | null> {
    try {
      const res = await this.cli.lso()
      if (!res.result.ok) return null
      return new Set(res.outbounds.map((o) => o.tag))
    } catch {
      return null
    }
  }

  /**
   * 执行到期的删除（每 30s 由调度器调用一次，PANEL.md §13）。
   * 失败时不能标记 done——否则 tag 会永久留在数据面，漂移再也清不掉；
   * 这里保留 pending 并在 60s 后重试，下一轮调度会继续处理。
   */
  async processDue(now = Date.now()): Promise<number> {
    const items = this.due(now)
    if (items.length === 0) return 0
    let done = 0
    const RETRY_MS = 60_000
    const outbounds = items.filter((i) => i.kind === 'outbound')
    const others = items.filter((i) => i.kind !== 'outbound')
    if (outbounds.length) {
      const tags = outbounds.map((i) => i.tag)
      const started = Date.now()
      const res = await this.cli.rmo(tags)
      this.db.run(
        'INSERT INTO xray_apply_ops (revision_id, at, op, tag, payload_json, ok, duration_ms, stdout, stderr, error_kind) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [outbounds[0]!.revision_id, started, 'rmo', tags.join(','), JSON.stringify(tags), res.ok ? 1 : 0, res.durationMs, res.stdout.slice(0, 4000), res.stderr.slice(0, 4000), res.errorKind ?? null],
      )
      if (res.ok) {
        for (const it of outbounds) {
          this.db.run('UPDATE pending_retire SET done_at = ?, error = NULL WHERE id = ?', [Date.now(), it.id])
          done++
        }
      } else if (this.alreadyGone(res.stderr)) {
        // 数据面已经不存在这些 tag（例如外部重启/被手动清理），视为完成。
        for (const it of outbounds) {
          this.db.run('UPDATE pending_retire SET done_at = ?, error = ? WHERE id = ?', [Date.now(), res.stderr.slice(0, 500), it.id])
          done++
        }
      } else {
        // 面板重启后数据面通常已经用「启动骨架配置 + 期望状态重放」重建，
        // 待退休的旧 tag 根本不存在了。此时 xray 的报错文案不一定包含 not found，
        // 必须用 lso 实际确认：不在数据面的直接视为完成，避免 pending 永久卡住。
        const present = await this.currentOutboundTags()
        const gone = present ? outbounds.filter((it) => !present.has(it.tag)) : []
        const remaining = present ? outbounds.filter((it) => present.has(it.tag)) : outbounds
        for (const it of gone) {
          this.db.run('UPDATE pending_retire SET done_at = ?, error = ? WHERE id = ?', [
            Date.now(),
            'rmo 时 tag 已不在数据面（视为已完成）',
            it.id,
          ])
          done++
        }
        for (const it of remaining) {
          this.db.run('UPDATE pending_retire SET error = ?, retire_after = ? WHERE id = ?', [
            res.stderr.slice(0, 500),
            Date.now() + RETRY_MS,
            it.id,
          ])
        }
        if (remaining.length > 0) {
          this.events.warn('xray.retire_retry', `延迟退休 rmo 失败，60 秒后重试：${res.stderr.slice(0, 200)}`, {
            detail: { tags: remaining.map((it) => it.tag) },
          })
        }
      }
    }
    for (const it of others) {
      const res = it.kind === 'inbound' ? await this.cli.rmi([it.tag]) : await this.cli.rmrules([it.tag])
      if (res.ok || this.alreadyGone(res.stderr)) {
        this.db.run('UPDATE pending_retire SET done_at = ?, error = ? WHERE id = ?', [Date.now(), res.ok ? null : res.stderr.slice(0, 500), it.id])
        done++
      } else {
        this.db.run('UPDATE pending_retire SET error = ?, retire_after = ? WHERE id = ?', [res.stderr.slice(0, 500), Date.now() + RETRY_MS, it.id])
      }
    }
    return done
  }

  /** all-time ado+rmo 计数（D5：热操作泄漏阈值） */
  hotOpsTotal(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM xray_apply_ops WHERE op IN ('ado','rmo') AND ok = 1",
    )
    return row?.n ?? 0
  }
}
