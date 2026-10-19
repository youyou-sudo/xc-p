import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { digestOf } from '../core/ids'
import { logger } from '../core/log'
import type { XrayCli } from './cli'
import type { ApplyEngine } from './apply'
import { diffTags } from './apply'
import type { AppliedNode, ApplyPlan, DataplaneSnapshot, DesiredNode } from './plan'
import { computePlan, planDigest, planSummary } from './plan'
import { dataplaneState } from '../core/schema'

export interface ReconcileDeps {
  db: Db
  cli: XrayCli
  settings: SettingsStore
  events: EventBus
  engine: () => ApplyEngine
  /** 延迟退休队列：pending 的 outbound 还在数据面是正常过渡态，不算漂移 */
  retire?: { pendingTags(): Set<string> }
}

export interface ReconcileResult {
  snapshot: DataplaneSnapshot
  plan: ApplyPlan
  consistent: boolean
  drift: { missing: string[]; extra: string[]; rulesUnverifiable: boolean }
  applied?: { ok: boolean; error?: string }
}

/**
 * 对账（PANEL.md §9.4 / §13 对账巡检 / AC-15）：
 * 读数据面现状（lso/lsi/lsrules）→ 与期望状态比对 → 可选地执行最小操作集。
 */
export class Reconciler {
  constructor(private deps: ReconcileDeps) {}

  async readDataplane(source: 'publish' | 'reconcile' | 'startup' | 'health'): Promise<DataplaneSnapshot> {
    const [lso, lsi, lsr] = await Promise.all([this.deps.cli.lso(), this.deps.cli.lsi(), this.deps.cli.lsrules()])
    const snapshot: DataplaneSnapshot = {
      at: Date.now(),
      outbounds: lso.outbounds.map((o) => o.tag),
      inbounds: lsi.inbounds.map((i) => ({ tag: i.tag, port: i.port })),
      rules: lsr.rules.map((r) => ({ ruleTag: r.ruleTag })),
      rulesSupported: lsr.supported,
      digest: '',
    }
    snapshot.digest = digestOf({ outbounds: snapshot.outbounds, inbounds: snapshot.inbounds, rules: snapshot.rules })
    if (!lso.result.ok) {
      this.deps.events.warn('xray.api_unreachable', 'lso 失败：' + lso.result.stderr.slice(0, 200))
    }
    if (!lsr.supported) {
      logger.warn('lsrules 在当前 xray 构建中不可用：规则集合退化为「按已成功执行的 apply 审计推导」，仅校验 outbound/inbound')
    }
    try {
      this.deps.db
        .insert(dataplaneState)
        .values({
          at: snapshot.at,
          source: source,
          outbounds_json: JSON.stringify(snapshot.outbounds),
          inbounds_json: JSON.stringify(snapshot.inbounds),
          rules_json: JSON.stringify(snapshot.rules),
          digest: snapshot.digest,
        })
        .run()
    } catch {
      /* 快照落库失败不阻断对账 */
    }
    return snapshot
  }

  /** 只读比对：不写数据面 */
  async check(
    desired: DesiredNode[],
    applied: AppliedNode[],
    source: 'publish' | 'reconcile' | 'startup' | 'health' = 'reconcile',
  ): Promise<ReconcileResult> {
    const snapshot = await this.readDataplane(source)
    const pending = this.deps.retire?.pendingTags() ?? new Set<string>()
    const plan = computePlan(desired, applied, snapshot, { pendingRetire: pending })
    const d1 = diffTags(desired.map((d) => d.outboundTag), snapshot.outbounds)
    const d2 = diffTags(desired.map((d) => d.inboundTag), snapshot.inbounds.map((i) => i.tag))
    const missing = [...d1.missing, ...d2.missing]
    // 延迟退休中的 tag 仍在数据面是预期行为，不能当成漂移反复告警。
    const extra = d1.extra.filter((t) => !pending.has(t))
    // 只比较 out/in 会漏掉「out/in 都在但 rule 丢了」的场景；用 plan 的 add/change/remove 一起判定。
    const consistent =
      missing.length === 0 &&
      extra.length === 0 &&
      plan.cleanup.length === 0 &&
      plan.add.length === 0 &&
      plan.change.length === 0 &&
      plan.remove.length === 0
    return { snapshot, plan, consistent, drift: { missing, extra, rulesUnverifiable: !snapshot.rulesSupported } }
  }

  /** 应用对账结果（AC-15：点击「重新对账」后恢复一致） */
  async reconcile(
    desired: DesiredNode[],
    applied: AppliedNode[],
    opts: { apply: boolean; revisionId?: string | null } = { apply: false },
  ): Promise<ReconcileResult> {
    const result = await this.check(desired, applied, 'reconcile')
    if (!opts.apply) return result
    const summary = planSummary(result.plan)
    if (
      result.consistent &&
      summary.add === 0 &&
      summary.remove === 0 &&
      summary.change === 0 &&
      summary.cleanup === 0
    ) {
      this.deps.events.info('reconcile.clean', '对账一致，数据面无需改动')
      return result
    }
    const engine = this.deps.engine()
    const appliedResult = await engine.applyPlan(result.plan, opts.revisionId ?? null)
    result.applied = { ok: appliedResult.ok, error: appliedResult.error?.message }
    if (appliedResult.ok) {
      const after = await this.readDataplane('reconcile')
      result.snapshot = after
      const pendingAfter = this.deps.retire?.pendingTags() ?? new Set<string>()
      // 用 apply 后的 applied_nodes 重新算，避免拿旧信念误报残留
      const appliedAfter = this.deps.engine().loadedApplied()
      const afterPlan = computePlan(desired, appliedAfter, after, { pendingRetire: pendingAfter })
      result.plan = afterPlan
      const afterDiff = diffTags(desired.map((d) => d.outboundTag), after.outbounds)
      const stillMissing = afterDiff.missing
      const stillExtra = afterDiff.extra.filter((t) => !pendingAfter.has(t))
      result.drift = { ...result.drift, missing: stillMissing, extra: stillExtra }
      result.consistent =
        stillMissing.length === 0 &&
        stillExtra.length === 0 &&
        afterPlan.cleanup.length === 0 &&
        afterPlan.add.length === 0 &&
        afterPlan.change.length === 0 &&
        afterPlan.remove.length === 0
      this.deps.events.info(
        'reconcile.done',
        '重新对账完成：新增 ' +
          summary.add +
          '，移除 ' +
          summary.remove +
          '，修改 ' +
          summary.change +
          '，清理漂移 ' +
          summary.cleanup,
      )
    } else {
      this.deps.events.error('reconcile.failed', '对账执行失败：' + (appliedResult.error?.message ?? 'unknown'))
    }
    return result
  }

  /** 发布后校验（§9.2 阶段 C） */
  async verifyAfterPublish(
    desired: DesiredNode[],
    revisionId: string,
  ): Promise<{ ok: boolean; snapshot: DataplaneSnapshot; drift: { missing: string[]; extra: string[] } }> {
    const snapshot = await this.readDataplane('publish')
    const pending = this.deps.retire?.pendingTags() ?? new Set<string>()
    const d1 = diffTags(desired.map((d) => d.outboundTag), snapshot.outbounds)
    const d2 = diffTags(desired.map((d) => d.inboundTag), snapshot.inbounds.map((i) => i.tag))
    const missing = [...d1.missing, ...d2.missing]
    const extra = d1.extra.filter((t) => !pending.has(t))
    const plan = computePlan(desired, this.deps.engine().loadedApplied(), snapshot, { pendingRetire: pending })
    const planClean = plan.add.length === 0 && plan.change.length === 0 && plan.remove.length === 0 && plan.cleanup.length === 0
    const ok = missing.length === 0 && extra.length === 0 && planClean
    if (!ok) {
      this.deps.events.warn(
        'xray.drift_after_publish',
        '发布后对账不一致：缺少 ' + missing.length + ' 个 tag，多余 ' + extra.length + ' 个 tag，待处理计划 ' + (plan.add.length + plan.change.length + plan.remove.length + plan.cleanup.length) + ' 项',
        { revisionId },
      )
    }
    return { ok, snapshot, drift: { missing, extra } }
  }

  planDigest(plan: ApplyPlan): string {
    return planDigest(plan)
  }
}
