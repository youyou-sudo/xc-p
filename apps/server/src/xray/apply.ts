import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import type { RoutingTable } from '../core/routing'
import type { XrayCli, XrayApiResult } from './cli'
 import {
  renderInbound,
  validateInbound,
  validateOutbound,
  validateRule,
} from './render'
import type { AppliedNode, ApplyPlan, DesiredNode } from './plan'
import type { RetireQueue } from './retire'
import { eq } from 'drizzle-orm'
import { appliedNodes, nodes, revisionNodes, xrayApplyOps } from '../core/schema'

export interface ApplyOpRecord {
  op: 'ado' | 'rmo' | 'adi' | 'rmi' | 'adrules' | 'rmrules' | 'replay'
  tag: string
  ok: boolean
  durationMs: number
  stdout?: string
  stderr?: string
  errorKind?: string
}

export interface ApplyResult {
  ok: boolean
  ops: ApplyOpRecord[]
  error?: { kind: string; message: string; step: number }
  rolledBack: boolean
}

export interface ApplyEngineDeps {
  db: Db
  cli: XrayCli
  settings: SettingsStore
  events: EventBus
  routing: RoutingTable
  retire: RetireQueue
  batchSize?: number
}

/**
 * apply engine（PANEL.md §9.2）。
 * 硬性纪律：
 *  1. adrules 必须 --append（由 XrayCli.adrules 强制）；
 *  2. tag 冲突报错 → 用新 tag，绝不原地覆盖；
 *  3. 顺序固定：先出站、再入站、再规则；删除反序；
 *  4. 所有调用串行（调用方保证，applyQueue）；
 *  5. 调用前做 JSON schema 校验。
 */
export class ApplyEngine {
  constructor(private deps: ApplyEngineDeps) {}

  private get batchSize(): number {
    return this.deps.batchSize ?? 16
  }

  private record(revisionId: string | null, rec: ApplyOpRecord, payload?: unknown): void {
    this.deps.db
      .insert(xrayApplyOps)
      .values({
        revision_id: revisionId,
        at: Date.now(),
        op: rec.op,
        tag: rec.tag,
        payload_json: payload === undefined ? null : JSON.stringify(payload),
        ok: rec.ok ? 1 : 0,
        duration_ms: rec.durationMs,
        stdout: rec.stdout?.slice(0, 4000) ?? null,
        stderr: rec.stderr?.slice(0, 4000) ?? null,
        error_kind: rec.errorKind ?? null,
      })
      .run()
  }

  private toRecord(op: ApplyOpRecord['op'], tag: string, res: XrayApiResult): ApplyOpRecord {
    return { op, tag, ok: res.ok, durationMs: res.durationMs, stdout: res.stdout, stderr: res.stderr, errorKind: res.errorKind }
  }

  private upsertApplied(node: DesiredNode, now = Date.now()): void {
    const values = {
      node_id: node.nodeId,
      outbound_tag: node.outboundTag,
      inbound_tag: node.inboundTag,
      rule_tag: node.ruleTag,
      port: node.inboundPort,
      outbound_json: JSON.stringify(node.outbound),
      content_hash: node.contentHash,
      applied_at: now,
    }
    this.deps.db
      .insert(appliedNodes)
      .values(values)
      .onConflictDoUpdate({
        target: appliedNodes.node_id,
        set: {
          outbound_tag: values.outbound_tag,
          inbound_tag: values.inbound_tag,
          rule_tag: values.rule_tag,
          port: values.port,
          outbound_json: values.outbound_json,
          content_hash: values.content_hash,
          applied_at: values.applied_at,
        },
      })
      .run()
  }

  private dropApplied(nodeId: string): void {
    this.deps.db.delete(appliedNodes).where(eq(appliedNodes.node_id, nodeId)).run()
  }

  async applyPlan(plan: ApplyPlan, revisionId: string | null): Promise<ApplyResult> {
    const ops: ApplyOpRecord[] = []
    const undo: (() => Promise<void>)[] = []

    const fail = async (kind: string, message: string, step: number, rolledBack: boolean, stepOps: ApplyOpRecord[]): Promise<ApplyResult> => {
      return { ok: false, ops: stepOps, error: { kind, message, step }, rolledBack }
    }

    // ---------- 阶段 0：先清理孤儿 tag ----------
    // 必须放在新增之前：孤儿 inbound 可能占着期望节点要用的 24000+ 端口，
    // 先 add 会 bind 失败（INADDRINUSE），对账就永远修不回来。
    // cleanup 是 best-effort：失败只告警，不阻断新增。
    const cleanup = plan.cleanup ?? []
    if (cleanup.length) {
      for (const group of chunk(cleanup, this.batchSize)) {
        const ruleTags = group.map((r) => r.ruleTag).filter(Boolean)
        if (ruleTags.length) {
          const res = await this.deps.cli.rmrules(ruleTags)
          const rec = this.toRecord('rmrules', ruleTags.join(','), res)
          ops.push(rec)
          this.record(revisionId, rec, ruleTags)
          if (!res.ok) {
            this.deps.events.warn('xray.cleanup_rmrules_partial', `清理孤儿规则未完全成功：${res.stderr.slice(0, 200)}`, { revisionId })
          }
        }
        const inTags = group.map((r) => r.inboundTag).filter(Boolean)
        if (inTags.length) {
          const res = await this.deps.cli.rmi(inTags)
          const rec = this.toRecord('rmi', inTags.join(','), res)
          ops.push(rec)
          this.record(revisionId, rec, inTags)
          if (!res.ok) {
            this.deps.events.warn('xray.cleanup_rmi_partial', `清理孤儿入站未完全成功：${res.stderr.slice(0, 200)}`, { revisionId })
          }
        }
        const outItems = group.filter((r) => r.outboundTag)
        if (outItems.length) {
          this.deps.retire.enqueue(
            outItems.map((r) => ({ kind: 'outbound' as const, tag: r.outboundTag, nodeId: r.nodeId, revisionId })),
          )
        }
      }
    }

    // ---------- 阶段 A：新增（含参数变化的「新 tag」） ----------
    const toAdd: DesiredNode[] = [...plan.add, ...plan.change.map((c) => c.next)]
    for (const node of toAdd) {
      try {
        validateOutbound(node.outbound)
        validateInbound(renderInbound(node.nodeId, node.inboundPort, node.inboundTag))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.deps.events.error('xray.build_failed', `节点 ${node.nodeId} 构建校验失败：${msg}`, { nodeId: node.nodeId, revisionId })
        this.deps.db.update(nodes).set({ publish_error: msg, updated_at: Date.now() }).where(eq(nodes.id, node.nodeId)).run()
      }
    }

    const validNodes = toAdd.filter((n) => {
      try {
        validateOutbound(n.outbound)
        validateInbound(renderInbound(n.nodeId, n.inboundPort, n.inboundTag))
        return true
      } catch {
        return false
      }
    })
    const skipped = toAdd.length - validNodes.length

    // §9.2 纪律：每一步都幂等（已存在则跳过）。
    // 对账场景下可能只有 outbound 被外部删除、inbound 仍在（或反之），此时若还整组 ado+adi 会撞 tag。
    const [lsoNow, lsiNow] = await Promise.all([this.deps.cli.lso(), this.deps.cli.lsi()])
    const haveOut = new Set(lsoNow.outbounds.map((o) => o.tag))
    const haveIn = new Set(lsiNow.inbounds.map((i) => i.tag))

    const chunks = chunk(validNodes, this.batchSize)

    for (const group of chunks) {
      for (const n of group) {
        if (haveOut.has(n.outboundTag)) {
          this.deps.events.info('xray.op_skipped', `outbound ${n.outboundTag} 已存在，跳过 ado（幂等）`, { nodeId: n.nodeId, revisionId })
        }
        if (haveIn.has(n.inboundTag)) {
          this.deps.events.info('xray.op_skipped', `inbound ${n.inboundTag} 已存在，跳过 adi（幂等）`, { nodeId: n.nodeId, revisionId })
        }
      }
      const needAdo = group.filter((n) => !haveOut.has(n.outboundTag))

      // 1) ado —— 新 tag，绝不覆盖
      const adoRes = needAdo.length
        ? await this.deps.cli.ado(needAdo.map((n) => n.outbound))
        : { ok: true, code: 0, stdout: '', stderr: '', durationMs: 0 }
      const adoRec = this.toRecord('ado', needAdo.map((n) => n.outboundTag).join(','), adoRes)
      if (needAdo.length) {
        ops.push(adoRec)
        this.record(revisionId, adoRec, needAdo.map((n) => ({ tag: n.outboundTag, nodeId: n.nodeId })))
      }
      if (!adoRes.ok) {
        this.deps.events.error('xray.apply_failed', `ado 失败：${adoRes.stderr.slice(0, 200)}`, { revisionId })
        const rolledBack = await this.rollback(undo)
        return fail(adoRes.errorKind ?? 'xray_build_failed', adoRes.stderr || adoRes.stdout, ops.length, rolledBack, ops)
      }
      if (needAdo.length) {
        undo.push(async () => {
          await this.deps.cli.rmo(needAdo.map((n) => n.outboundTag))
        })
      }

      // 2) adi
      // 入站 tag 必须与出站 tag 使用同一个内容派生后缀（D2「修改 = 新 tag」），
      // 否则对账会因为 in-<id> 与 in-<id>.<hash> 不一致而永远报告漂移。
      const needAdi = group.filter((n) => !haveIn.has(n.inboundTag))
      const inboundPayload = needAdi.map((n) => renderInbound(n.nodeId, n.inboundPort, n.inboundTag))
      const adiRes = needAdi.length
        ? await this.deps.cli.adi(inboundPayload)
        : { ok: true, code: 0, stdout: '', stderr: '', durationMs: 0 }
      const adiRec = this.toRecord('adi', needAdi.map((n) => n.inboundTag).join(','), adiRes)
      if (needAdi.length) {
        ops.push(adiRec)
        this.record(revisionId, adiRec, needAdi.map((n) => ({ tag: n.inboundTag, port: n.inboundPort })))
      }
      if (!adiRes.ok) {
        this.deps.events.error('xray.apply_failed', `adi 失败：${adiRes.stderr.slice(0, 200)}`, { revisionId })
        const rolledBack = await this.rollback(undo)
        return fail(adiRes.errorKind ?? 'xray_build_failed', adiRes.stderr || adiRes.stdout, ops.length, rolledBack, ops)
      }
      if (needAdi.length) {
        undo.push(async () => {
          await this.deps.cli.rmi(needAdi.map((n) => n.inboundTag))
        })
      }

      // 3) adrules --append（强制）
      const rules = group.map((n) => ({ type: 'field', ruleTag: n.ruleTag, inboundTag: [n.inboundTag], outboundTag: n.outboundTag }))
      rules.forEach(validateRule)
      const adRulesRes = await this.deps.cli.adrules(rules)
      const ruleRec = this.toRecord('adrules', group.map((n) => n.ruleTag).join(','), adRulesRes)
      ops.push(ruleRec)
      this.record(revisionId, ruleRec, rules)
      if (!adRulesRes.ok) {
        // 规则已存在（duplicate/existing）说明这条 in→out 映射本来就在，属于幂等场景，不致命
        if (/existing|duplicate|already/i.test(adRulesRes.stderr)) {
          this.deps.events.warn('xray.adrules_existing', `规则已存在，跳过：${adRulesRes.stderr.slice(0, 160)}`, { revisionId })
        } else {
          this.deps.events.error('xray.apply_failed', `adrules 失败：${adRulesRes.stderr.slice(0, 200)}`, { revisionId })
          const rolledBack = await this.rollback(undo)
          return fail(adRulesRes.errorKind ?? 'xray_build_failed', adRulesRes.stderr || adRulesRes.stdout, ops.length, rolledBack, ops)
        }
      }
      undo.push(async () => {
        await this.deps.cli.rmrules(group.map((n) => n.ruleTag))
      })

      // 4) 网关路由表加入该节点（进程内一次对象替换，无 IO）
      for (const n of group) {
        this.deps.routing.put({ nodeId: n.nodeId, username: n.username, port: n.inboundPort, tag: n.outboundTag })
        this.upsertApplied(n)
      }
      this.deps.routing.persist()
    }

    // ---------- 阶段 B：删除（旧 tag 延迟退休） ----------
    // 注意：plan.remove 里既有「彻底删除的节点」，也有「参数变化的旧 tag」。
    // 后者对应的 nodeId 仍然在期望状态里（新 tag 已在阶段 A 上线），因此不能摘路由、不能删 applied_nodes。
    const changedNodeIds = new Set(plan.change.map((c) => c.next.nodeId))
    const pureRemoveNodeIds = new Set(
      plan.remove.filter((r) => r.nodeId && !changedNodeIds.has(r.nodeId)).map((r) => r.nodeId!),
    )
    const removals = plan.remove
    if (removals.length) {
      for (const nodeId of pureRemoveNodeIds) this.deps.routing.delete(nodeId)
      this.deps.routing.persist()

      for (const group of chunk(removals, this.batchSize)) {
        // 漂移清理项可能只有 outbound / inbound / rule 中的一种，空字段表示该类型不存在，
        // 不能把空字符串传给 xray api（会变成一次无效的批量调用）。
        const ruleTags = group.map((r) => r.ruleTag).filter(Boolean)
        if (ruleTags.length) {
          const rmrulesRes = await this.deps.cli.rmrules(ruleTags)
          const r1 = this.toRecord('rmrules', ruleTags.join(','), rmrulesRes)
          ops.push(r1)
          this.record(revisionId, r1, ruleTags)
          if (!rmrulesRes.ok) {
            // 规则可能本就不存在（例如 lsrules 不可用导致信念漂移）：记录告警但继续删入站
            this.deps.events.warn('xray.rmrules_partial', `rmrules 未完全成功：${rmrulesRes.stderr.slice(0, 200)}`, { revisionId })
          }
        }

        const inTags = group.map((r) => r.inboundTag).filter(Boolean)
        if (inTags.length) {
          const rmiRes = await this.deps.cli.rmi(inTags)
          const r2 = this.toRecord('rmi', inTags.join(','), rmiRes)
          ops.push(r2)
          this.record(revisionId, r2, inTags)
          if (!rmiRes.ok) {
            this.deps.events.warn('xray.rmi_partial', `rmi 未完全成功：${rmiRes.stderr.slice(0, 200)}`, { revisionId })
          }
        }

        // rmo 延后到退休队列（给在途连接收尾窗口）
        const outItems = group.filter((r) => r.outboundTag)
        if (outItems.length) {
          this.deps.retire.enqueue(
            outItems.map((r) => ({ kind: 'outbound' as const, tag: r.outboundTag, nodeId: r.nodeId, revisionId })),
          )
        }
        for (const r of group) {
          if (r.nodeId && pureRemoveNodeIds.has(r.nodeId)) {
            this.dropApplied(r.nodeId)
            this.deps.db.delete(revisionNodes).where(eq(revisionNodes.node_id, r.nodeId)).run()
          }
        }
      }
    }

    // ---------- 阶段 C：对账 ----------
    if (skipped > 0) {
      this.deps.events.warn('xray.apply_skipped', `本次发布跳过 ${skipped} 个构建失败的节点`, { revisionId })
    }

    return { ok: true, ops, rolledBack: false }
  }

  /** 逆序回滚本次已成功的步骤（PANEL.md §9.3） */
  private async rollback(undo: (() => Promise<void>)[]): Promise<boolean> {
    let ok = true
    for (const fn of [...undo].reverse()) {
      try {
        await fn()
      } catch {
        ok = false
      }
    }
    return ok
  }
 
  loadedApplied(): AppliedNode[] {
    return this.deps.db.select().from(appliedNodes).all().map((r) => ({
      nodeId: r.node_id,
      outboundTag: r.outbound_tag,
      inboundTag: r.inbound_tag,
      ruleTag: r.rule_tag,
      port: r.port,
      outboundJson: r.outbound_json,
      contentHash: r.content_hash,
      appliedAt: r.applied_at,
    }))
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** 供对账使用：把 applied_nodes 与 lso/lsi 的差异显式暴露出来 */
export function diffTags(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const e = new Set(expected)
  const a = new Set(actual)
  return {
    missing: expected.filter((t) => !a.has(t)),
    extra: actual.filter((t) => !e.has(t) && !['out-direct', 'api', 'metrics'].includes(t)),
  }
}
 
