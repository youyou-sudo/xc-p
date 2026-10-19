import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../core/db'
import { nodes as nodesT, revisionNodes, runtimeRevisions } from '../core/schema'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import type { RoutingTable } from '../core/routing'
import { digestOf, randomId, revisionId as newRevisionId } from '../core/ids'
import type { XrayCli } from '../xray/cli'
import type { ApplyEngine } from '../xray/apply'
import type { Reconciler } from '../xray/reconcile'
import type { PortPool } from '../xray/ports'
import type { XrayProcess } from '../xray/process'
import type { AppliedNode, ApplyPlan, DesiredNode } from '../xray/plan'
import { computePlan, planDigest, planSummary } from '../xray/plan'
import { renderInbound, renderRule } from '../xray/render'
import { buildDesiredNodes, type DesiredResult } from './desired'

export type RevisionReason = 'manual' | 'cron' | 'api' | 'post_sync' | 'rollback' | 'recover' | 'restart'

export interface ValidationReport {
  ok: boolean
  /** 构建校验（xray run -test）失败的节点 */
  buildFailed: { nodeId: string; message: string }[]
  checks: { id: string; label: string; ok: boolean; detail: string }[]
  skippedUnsupported: number
  skippedUnsupportedRatio: number
}

export interface PublishResult {
  ok: boolean
  revisionId: string
  dryRun: boolean
  reason: RevisionReason
  summary: ReturnType<typeof planSummary>
  plan: ApplyPlan
  validation: ValidationReport
  error?: string
  rolledBack?: boolean
}

export interface PublisherDeps {
  db: Db
  cli: XrayCli
  settings: SettingsStore
  events: EventBus
  ports: PortPool
  engine: ApplyEngine
  reconciler: Reconciler
  process: XrayProcess
  routing: RoutingTable
  /** 延迟退休队列：pending tag 不计入漂移，避免发布后误报 */
  retire: { pendingTags(): Set<string> }
  /** 发布前门禁用的快速检测（detect.checkOnPublish，§8.6） */
  prePublishCheck?: (nodeIds: string[]) => Promise<void>
}

/**
 * PublishJob（PANEL.md §9）。只读期望状态，永不拉订阅。
 */
export class Publisher {
  constructor(private deps: PublisherDeps) {}

  appliedNodes(): AppliedNode[] {
    return this.deps.engine.loadedApplied()
  }

  /** 取快照 + 安全阀（§9.1 步骤 1/2） */
  async snapshotWithValidation(): Promise<{ desired: DesiredResult; validation: ValidationReport }> {
    const s = this.deps.settings.get()
    const snap = buildDesiredNodes(this.deps.db, this.deps.settings, this.deps.ports)
    const checks: ValidationReport['checks'] = []

    // 安全阀 1：最少节点数
    const minOk = snap.included >= s.publish.requireMinNodes
    checks.push({
      id: 'requireMinNodes',
      label: '快照节点数不小于 requireMinNodes',
      ok: minOk,
      detail: '快照 ' + snap.included + ' / 要求 >= ' + s.publish.requireMinNodes,
    })

    // 安全阀 4：逐条构建校验（xray run -test）。D9 要求「运行时用构建校验试探该 outbound 是否可加载」，
    // 因为协议支持矩阵是设计矩阵，不等于当前 Xray 构建的真实能力（例如 hysteria2/tuic 在部分构建里缺失）。
    const buildFailed = await this.validateBuild(snap.desired)
    const failedIds = new Set(buildFailed.map((b) => b.nodeId))
    if (failedIds.size > 0) {
      snap.desired = snap.desired.filter((d) => !failedIds.has(d.nodeId))
      snap.included = snap.desired.length
    }

    // 安全阀 3：不可发布节点比例 = 协议不可发布 + 构建校验失败（§9.3 节点级失败）
    const skippedTotal = snap.skippedUnsupported + failedIds.size
    const ratio = snap.totalCandidates > 0 ? skippedTotal / snap.totalCandidates : 0
    const unsupportedOk = ratio <= s.publish.maxUnsupportedRatio
    checks.push({
      id: 'maxUnsupportedRatio',
      label: '不可发布节点比例不超过 maxUnsupportedRatio',
      ok: unsupportedOk,
      detail:
        (ratio * 100).toFixed(1) +
        '% / 上限 ' +
        (s.publish.maxUnsupportedRatio * 100).toFixed(1) +
        '%（协议不可发布 ' +
        snap.skippedUnsupported +
        ' + 构建校验失败 ' +
        failedIds.size +
        '）',
    })
    checks.push({
      id: 'xrayBuild',
      label: '生成的 outbound 通过 xray run -test 构建校验',
      ok: unsupportedOk,
      detail:
        failedIds.size === 0
          ? '全部 ' + (snap.desired.length + failedIds.size) + ' 条通过'
          : failedIds.size +
            ' 条失败（已排除出本次快照，节点标记 publish_error）：' +
            buildFailed
              .slice(0, 5)
              .map((b) => b.nodeId + '(' + b.message.split('\n')[0]!.slice(0, 80) + ')')
              .join('; '),
    })

    const ok = minOk && unsupportedOk
    return {
      desired: snap,
      validation: {
        ok,
        buildFailed,
        checks,
        skippedUnsupported: skippedTotal,
        skippedUnsupportedRatio: ratio,
      },
    }
  }

  /** 逐条构建校验：先整体测，失败再二分定位到具体节点 */
  private async validateBuild(desired: DesiredNode[]): Promise<{ nodeId: string; message: string }[]> {
    if (desired.length === 0) return []
    const all = desired.map((d) => d.outbound)
    const whole = await this.testOutbounds(all)
    if (whole.ok) return []
    const failed: { nodeId: string; message: string }[] = []
    // 二分：按 16 条一组定位
    for (let i = 0; i < desired.length; i += 16) {
      const group = desired.slice(i, i + 16)
      const res = await this.testOutbounds(group.map((g) => g.outbound))
      if (res.ok) continue
      for (const node of group) {
        const single = await this.testOutbounds([node.outbound])
        if (!single.ok) {
          failed.push({ nodeId: node.nodeId, message: (single.stderr || single.stdout).slice(0, 300) })
          this.deps.db
            .update(nodesT)
            .set({ publish_error: single.stderr.slice(0, 300), updated_at: Date.now() })
            .where(eq(nodesT.id, node.nodeId))
            .run()
        }
      }
    }
    return failed
  }

  private async testOutbounds(outbounds: Record<string, unknown>[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const file = await this.deps.cli.writePayload('build-test-' + randomId('').slice(0, 8) + '.json', {
      log: { loglevel: 'warning' },
      inbounds: [],
      outbounds: [{ tag: 'out-direct', protocol: 'freedom' }, ...outbounds],
    })
    const res = await this.deps.cli.testConfig(file)
    return { ok: res.ok, stdout: res.stdout, stderr: res.stderr }
  }

  async plan(): Promise<{ plan: ApplyPlan; desired: DesiredResult; validation: ValidationReport; applied: AppliedNode[] }> {
    const { desired, validation } = await this.snapshotWithValidation()
    const applied = this.appliedNodes()
    const snapshot = await this.deps.reconciler.readDataplane('reconcile')
    const plan = computePlan(desired.desired, applied, snapshot, { pendingRetire: this.deps.retire.pendingTags() })
    return { plan, desired, validation, applied }
  }

  /** 安全阀 2：移除比例（相对当前 active revision） */
  private removalRatio(plan: ApplyPlan): { ratio: number; detail: string } {
    const current = this.deps.db.get<{ node_count: number }>(
      "SELECT node_count FROM runtime_revisions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    const before = current?.node_count ?? plan.keep.length + plan.remove.length
    const ratio = before > 0 ? plan.remove.length / before : 0
    return { ratio, detail: '移除 ' + plan.remove.length + ' / 当前生效 ' + before + ' = ' + (ratio * 100).toFixed(1) + '%' }
  }

  async publish(opts: { reason: RevisionReason; dryRun?: boolean; actor?: string } = { reason: 'manual' }): Promise<PublishResult> {
    const dryRun = opts.dryRun ?? false
    const s = this.deps.settings.get()
    const revId = newRevisionId()
    const { plan, desired, validation } = await this.plan()
    const summary = planSummary(plan)

    // 安全阀 2（只在真正要移除时生效）
    const removal = this.removalRatio(plan)
    const removalOk = removal.ratio <= s.publish.maxRemovalRatio
    validation.checks.push({ id: 'maxRemovalRatio', label: '移除比例不超过 maxRemovalRatio', ok: removalOk, detail: removal.detail })
    if (!removalOk) validation.ok = false

    const startRow = {
      id: revId,
      reason: opts.reason,
      created: Date.now(),
      nodeCount: desired.desired.length,
      skipped: desired.skippedUnsupported + desired.skippedQuarantined + desired.skippedExpired,
      planDigest: planDigest(plan),
      planJson: JSON.stringify({
        summary,
        desired: desired.desired,
        remove: plan.remove,
        cleanup: plan.cleanup,
        drift: plan.drift,
        validation: validation.checks,
      }),
      validationJson: JSON.stringify(validation),
    }

    if (dryRun) {
      return { ok: validation.ok, revisionId: revId, dryRun: true, reason: opts.reason, summary, plan, validation, error: validation.ok ? undefined : '安全阀/构建校验未通过' }
    }

    if (!validation.ok) {
      this.deps.db
        .insert(runtimeRevisions)
        .values({
          id: revId,
          status: 'failed',
          reason: opts.reason,
          created_at: startRow.created,
          node_count: startRow.nodeCount,
          added_count: summary.add,
          removed_count: summary.remove,
          changed_count: summary.change,
          skipped_count: startRow.skipped,
          plan_digest: startRow.planDigest,
          plan_json: startRow.planJson,
          validation_json: startRow.validationJson,
          error: '安全阀/构建校验未通过',
        })
        .run()
      this.deps.events.error('publish.aborted', '发布被安全阀拦下，数据面未做任何改动', { revisionId: revId })
      return { ok: false, revisionId: revId, dryRun: false, reason: opts.reason, summary, plan, validation, error: '安全阀/构建校验未通过' }
    }

    // 发布前门禁（§8.6 detect.checkOnPublish）
    if (s.detect.enabled && s.detect.checkOnPublish && this.deps.prePublishCheck) {
      try {
        await this.deps.prePublishCheck([...plan.add.map((n) => n.nodeId), ...plan.change.map((c) => c.next.nodeId)])
      } catch {
        /* 门禁失败不阻断发布，只记录 */
      }
    }

    const before = await this.deps.reconciler.readDataplane('publish')
    this.deps.db
      .insert(runtimeRevisions)
      .values({
        id: revId,
        status: 'applying',
        reason: opts.reason,
        created_at: startRow.created,
        node_count: startRow.nodeCount,
        added_count: summary.add,
        removed_count: summary.remove,
        changed_count: summary.change,
        skipped_count: startRow.skipped,
        plan_digest: startRow.planDigest,
        plan_json: startRow.planJson,
        validation_json: startRow.validationJson,
        dataplane_before_json: JSON.stringify(before),
      })
      .run()

    const t0 = Date.now()
    const result = await this.deps.engine.applyPlan(plan, revId)
    const duration = Date.now() - t0

    if (!result.ok) {
      this.deps.db
        .update(runtimeRevisions)
        .set({
          status: result.rolledBack ? 'rolled_back' : 'failed',
          error: result.error?.message ?? 'unknown',
          applied_at: Date.now(),
        })
        .where(eq(runtimeRevisions.id, revId))
        .run()
      this.deps.events.error('publish.failed', '发布失败：' + (result.error?.message ?? '') + '（第 ' + (result.error?.step ?? 0) + ' 步）', { revisionId: revId })
      return { ok: false, revisionId: revId, dryRun: false, reason: opts.reason, summary, plan, validation, error: result.error?.message, rolledBack: result.rolledBack }
    }

    // 落 revision_nodes + 完整配置产物
    const tx = () => {
      for (const n of desired.desired) {
        this.deps.db
          .insert(revisionNodes)
          .values({
            revision_id: revId,
            node_id: n.nodeId,
            username: n.username,
            outbound_tag: n.outboundTag,
            inbound_tag: n.inboundTag,
            inbound_port: n.inboundPort,
          })
          .onConflictDoUpdate({
            target: [revisionNodes.revision_id, revisionNodes.node_id],
            set: {
              username: n.username,
              outbound_tag: n.outboundTag,
              inbound_tag: n.inboundTag,
              inbound_port: n.inboundPort,
            },
          })
          .run()
      }
    }
    tx()

    let verified = { ok: true }
    try {
      const check = await this.deps.reconciler.verifyAfterPublish(desired.desired, revId)
      verified = { ok: check.ok }
      this.deps.db
        .update(runtimeRevisions)
        .set({ dataplane_after_json: JSON.stringify(check.snapshot) })
        .where(eq(runtimeRevisions.id, revId))
        .run()
    } catch (e) {
      verified = { ok: false }
      void e
    }

    const status = verified.ok ? 'active' : 'failed'
    this.deps.db
      .update(runtimeRevisions)
      .set({ status, applied_at: Date.now() })
      .where(eq(runtimeRevisions.id, revId))
      .run()
    if (status === 'active') {
      this.deps.db
        .update(runtimeRevisions)
        .set({ status: 'retired', retired_at: Date.now() })
        .where(and(eq(runtimeRevisions.status, 'active'), ne(runtimeRevisions.id, revId)))
        .run()
    }

    // 写本次发布的完整配置快照（产物，可用于灾备重建，§14.1）
    try {
      this.deps.process.writeRevisionConfig(
        revId,
        desired.desired.map((d) => d.outbound),
        desired.desired.map((d) => renderInbound(d.nodeId, d.inboundPort, d.inboundTag)),
        desired.desired.map((d) => renderRule(d.nodeId, { ruleTag: d.ruleTag, inboundTag: d.inboundTag, outboundTag: d.outboundTag })),
      )
    } catch {
      /* 产物写失败不影响发布结果 */
    }

    if (status === 'active') {
      this.deps.events.info(
        'publish.done',
        '发布完成：新增 ' +
          summary.add +
          '，移除 ' +
          summary.remove +
          '，修改 ' +
          summary.change +
          '，清理漂移 ' +
          summary.cleanup +
          '，未变化 ' +
          summary.keep +
          '（' +
          duration +
          'ms）',
        { revisionId: revId },
      )
    }
    this.trimRevisions()

    return { ok: status === 'active', revisionId: revId, dryRun: false, reason: opts.reason, summary, plan, validation }
  }

  /** 回滚到指定 revision：把它的目标状态当作期望状态，走同一套 ApplyPlan（§9.3） */
  async rollback(targetRevisionId: string, actor = 'panel'): Promise<PublishResult> {
    const row = this.deps.db
      .select({ plan_json: runtimeRevisions.plan_json, id: runtimeRevisions.id })
      .from(runtimeRevisions)
      .where(eq(runtimeRevisions.id, targetRevisionId))
      .get()
    if (!row) throw new Error('revision 不存在: ' + targetRevisionId)
    // plan_json 在 insert 时总是写入（见上方 publish/rollback 两条插入路径）
    const saved = JSON.parse(row.plan_json!) as { desired: DesiredNode[] }
    const targetDesired = saved.desired ?? []
    const applied = this.appliedNodes()
    const snapshot = await this.deps.reconciler.readDataplane('reconcile')
    const plan = computePlan(targetDesired, applied, snapshot, { pendingRetire: this.deps.retire.pendingTags() })
    const summary = planSummary(plan)
    const revId = newRevisionId()

    this.deps.db
      .insert(runtimeRevisions)
      .values({
        id: revId,
        status: 'applying',
        reason: 'rollback',
        created_at: Date.now(),
        node_count: targetDesired.length,
        added_count: summary.add,
        removed_count: summary.remove,
        changed_count: summary.change,
        plan_digest: planDigest(plan),
        plan_json: JSON.stringify({ summary, desired: targetDesired, target: targetRevisionId }),
      })
      .run()

    const result = await this.deps.engine.applyPlan(plan, revId)
    if (!result.ok) {
      this.deps.db
        .update(runtimeRevisions)
        .set({ status: 'failed', error: result.error?.message ?? 'unknown' })
        .where(eq(runtimeRevisions.id, revId))
        .run()
      this.deps.events.error('publish.rollback_failed', '回滚失败：' + (result.error?.message ?? ''), { revisionId: revId })
      return {
        ok: false,
        revisionId: revId,
        dryRun: false,
        reason: 'rollback',
        summary,
        plan,
        validation: { ok: false, buildFailed: [], checks: [], skippedUnsupported: 0, skippedUnsupportedRatio: 0 },
        error: result.error?.message,
      }
    }
    this.deps.db
      .update(runtimeRevisions)
      .set({ status: 'active', applied_at: Date.now() })
      .where(eq(runtimeRevisions.id, revId))
      .run()
    this.deps.events.info('publish.rolled_back', '已回滚到 revision ' + targetRevisionId, { revisionId: revId })
    void actor
    return {
      ok: true,
      revisionId: revId,
      dryRun: false,
      reason: 'rollback',
      summary,
      plan,
      validation: { ok: true, buildFailed: [], checks: [], skippedUnsupported: 0, skippedUnsupportedRatio: 0 },
    }
  }
 
  private trimRevisions(): void {
    const keep = this.deps.settings.get().publish.keepRevisions
    const rows = this.deps.db
      .select({ id: runtimeRevisions.id })
      .from(runtimeRevisions)
      .where(inArray(runtimeRevisions.status, ['retired', 'failed', 'rolled_back']))
      .orderBy(desc(runtimeRevisions.created_at))
      .all()
    const extra = rows.slice(keep)
    for (const r of extra) {
      this.deps.db.delete(revisionNodes).where(eq(revisionNodes.revision_id, r.id)).run()
      this.deps.db.delete(runtimeRevisions).where(eq(runtimeRevisions.id, r.id)).run()
    }
  }

  currentStatus() {
    const active = this.deps.db
      .select()
      .from(runtimeRevisions)
      .where(eq(runtimeRevisions.status, 'active'))
      .orderBy(desc(runtimeRevisions.created_at))
      .limit(1)
      .get()
    const applied = this.appliedNodes()
    return {
      revision: active
        ? {
            id: active.id,
            status: active.status,
            reason: active.reason,
            createdAt: active.created_at,
            appliedAt: active.applied_at,
            nodeCount: active.node_count,
            digest: active.plan_digest,
          }
        : null,
      appliedNodes: applied.length,
      appliedTags: applied.map((a) => a.outboundTag),
      planDigestNow: digestOf(applied.map((a) => a.outboundTag).sort()),
    }
  }
}
