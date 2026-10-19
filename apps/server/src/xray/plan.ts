import { digestOf } from '../core/ids'
import { outboundTag, inboundTag, ruleTag, VARIANT_SEP } from './render'

/** 期望状态里的一个可发布节点 */
export interface DesiredNode {
  nodeId: string
  username: string
  outboundTag: string
  inboundTag: string
  ruleTag: string
  inboundPort: number
  /** 含 tag 的完整 outbound */
  outbound: Record<string, unknown>
  /** outbound 内容指纹（含 tag），用于判断「参数是否变化」 */
  contentHash: string
}

/** 数据面里实际生效的节点（我们对数据面的信念，来自成功执行的 apply 操作） */
export interface AppliedNode {
  nodeId: string
  outboundTag: string
  inboundTag: string
  ruleTag: string
  port: number
  outboundJson: string
  contentHash: string
  appliedAt: number
}

export interface DataplaneSnapshot {
  at: number
  outbounds: string[]
  inbounds: { tag: string; port?: number }[]
  rules: { ruleTag: string }[]
  rulesSupported: boolean
  digest: string
}

export interface PlanRemove {
  nodeId: string | null
  outboundTag: string
  inboundTag: string
  ruleTag: string
  port?: number
}

export interface ApplyPlan {
  /** 全新节点 */
  add: DesiredNode[]
  /** 参数变化：新 tag 上，旧 tag 下（D2「修改」路径） */
  change: { next: DesiredNode; prev: AppliedNode }[]
  /** 纯删除 */
  remove: PlanRemove[]
  /** 完全不动（「未变化的节点连接不受任何影响」的实现） */
  keep: DesiredNode[]
  /** 数据面里存在、但既不在期望也不在 applied 里的 tag（外部干扰/漂移） */
  drift: { outboundTags: string[]; inboundTags: string[]; ruleTags: string[] }
  /**
   * 对账清理：漂移 tag 的删除项（nodeId 为 null）。
   * 与 remove 分开，避免把「清理孤儿 tag」算进发布安全阀的移除比例。
   */
  cleanup: PlanRemove[]
  /** 期望里存在、但 applied 有、数据面却没有（外部被删） */
  missingInDataplane: string[]
}

export interface DesiredBuildInput {
  nodeId: string
  username: string
  port: number
  outbound: Record<string, unknown>
  /** 变化时使用的 tag 后缀（通常是 revision 短号） */
  variant?: string
}

export function buildDesiredNode(input: DesiredBuildInput): DesiredNode {
  const variant = input.variant ? `${VARIANT_SEP}${input.variant}` : ''
  const outTag = outboundTag(input.nodeId) + variant
  const inTag = inboundTag(input.nodeId) + variant
  const rTag = ruleTag(input.nodeId) + variant
  const outbound = { ...structuredClone(input.outbound), tag: outTag }
  return {
    nodeId: input.nodeId,
    username: input.username,
    outboundTag: outTag,
    inboundTag: inTag,
    ruleTag: rTag,
    inboundPort: input.port,
    outbound,
    contentHash: digestOf(outbound),
  }
}

/**
 * 算 ApplyPlan（PANEL.md §9.1#4）：只对 add / remove / change 动手，keep 完全不碰。
 * 输入三方：期望状态、我们对数据面的信念（applied_nodes）、数据面实测（lso/lsi/lsrules）。
 */
export interface ComputePlanOptions {
  /**
   * 已在延迟退休队列里的 tag。它们暂时还会出现在数据面，
   * 属于「已知的过渡态」，不能算漂移，也不能重复安排删除。
   */
  pendingRetire?: Iterable<string>
}

export function computePlan(
  desired: DesiredNode[],
  applied: AppliedNode[],
  dataplane: DataplaneSnapshot,
  options: ComputePlanOptions = {},
): ApplyPlan {
  const dpOut = new Set(dataplane.outbounds)
  const dpIn = new Set(dataplane.inbounds.map((i) => i.tag))
  const dpRules = new Set(dataplane.rules.map((r) => r.ruleTag))
  const appliedByNode = new Map(applied.map((a) => [a.nodeId, a]))
  const desiredByNode = new Map(desired.map((d) => [d.nodeId, d]))
  const pending = new Set(options.pendingRetire ?? [])

  const add: DesiredNode[] = []
  const change: { next: DesiredNode; prev: AppliedNode }[] = []
  const keep: DesiredNode[] = []
  const excluded = new Set<string>()

  for (const d of desired) {
    const prev = appliedByNode.get(d.nodeId)
    if (!prev) {
      add.push(d)
      continue
    }
    // 数据面里已经没有这个 tag 了（外部删除 / 崩溃 / 只丢了 rule）→ 视为需要重新添加。
    // rule 丢失也必须补：否则 outbound/inbound 都在、但路由规则缺失，节点实际不可用，
    // 而对账会误判为 keep。lsrules 不可用时跳过这一项。
    const ruleGone = dataplane.rulesSupported && !dpRules.has(prev.ruleTag)
    const tagGone = !dpOut.has(prev.outboundTag) || !dpIn.has(prev.inboundTag) || ruleGone
    if (tagGone) {
      add.push(d)
      excluded.add(prev.outboundTag)
      continue
    }
    if (prev.contentHash !== d.contentHash || prev.port !== d.inboundPort) {
      change.push({ next: d, prev })
      excluded.add(prev.outboundTag)
      continue
    }
    keep.push(d)
    excluded.add(prev.outboundTag)
  }

  const remove: PlanRemove[] = []
  for (const a of applied) {
    if (desiredByNode.has(a.nodeId)) continue
    remove.push({ nodeId: a.nodeId, outboundTag: a.outboundTag, inboundTag: a.inboundTag, ruleTag: a.ruleTag, port: a.port })
    excluded.add(a.outboundTag)
  }
  // 参数变化的旧 tag 也要下线
  for (const c of change) {
    remove.push({ nodeId: c.prev.nodeId, outboundTag: c.prev.outboundTag, inboundTag: c.prev.inboundTag, ruleTag: c.prev.ruleTag, port: c.prev.port })
    excluded.add(c.prev.outboundTag)
  }

  // 数据面孤儿：既不在期望状态、也不在 applied 信念里。
  // - 排除 desired 的 outboundTag：add/change 的「新 tag」可能已经因为幂等重放出现在数据面；
  // - 排除 pending_retire：删除已经排队，outbound 还在数据面是正常的过渡态。
  const desiredOutTags = new Set(desired.map((d) => d.outboundTag))
  const driftOut = dataplane.outbounds.filter(
    (t) =>
      t.startsWith('out-') &&
      !excluded.has(t) &&
      !desiredOutTags.has(t) &&
      !t.startsWith('out-direct') &&
      !pending.has(t),
  )
  const knownIn = new Set<string>()
  for (const d of desired) {
    knownIn.add(d.inboundTag)
    knownIn.add(d.outboundTag)
  }
  for (const a of applied) {
    knownIn.add(a.inboundTag)
    knownIn.add(a.outboundTag)
  }
  const driftIn = dataplane.inbounds
    .map((i) => i.tag)
    .filter((t) => t.startsWith('in-') && !knownIn.has(t) && t !== 'in-direct' && t !== 'in-direct-socks' && !pending.has(t))

  const missingInDataplane: string[] = []
  for (const a of applied) {
    if (!desiredByNode.has(a.nodeId)) continue
    if (!dpOut.has(a.outboundTag)) missingInDataplane.push(a.outboundTag)
  }

  const driftRules = dataplane.rulesSupported
    ? dataplane.rules
        .map((r) => r.ruleTag)
        .filter(
          (rt) =>
            rt.startsWith('node-') &&
            !desired.some((d) => d.ruleTag === rt) &&
            !applied.some((a) => a.ruleTag === rt) &&
            !pending.has(rt),
        )
    : []

  // 清理项：孤儿 outbound / inbound / rule。apply engine 会按标签类型分别删除，
  // 空字段表示这一类不存在；nodeId 为 null 表示它不对应任何节点记录。
  const cleanup: PlanRemove[] = [
    ...driftOut.map((tag) => ({ nodeId: null, outboundTag: tag, inboundTag: '', ruleTag: '' })),
    ...driftIn.map((tag) => ({ nodeId: null, outboundTag: '', inboundTag: tag, ruleTag: '' })),
    ...driftRules.map((tag) => ({ nodeId: null, outboundTag: '', inboundTag: '', ruleTag: tag })),
  ]

  return {
    add,
    change,
    remove,
    keep,
    drift: { outboundTags: driftOut, inboundTags: driftIn, ruleTags: driftRules },
    cleanup,
    missingInDataplane,
  }
}

export function planDigest(plan: ApplyPlan): string {
  return digestOf({
    add: plan.add.map((a) => a.nodeId).sort(),
    change: plan.change.map((c) => c.next.nodeId).sort(),
    remove: plan.remove.map((r) => r.outboundTag).sort(),
    keep: plan.keep.map((k) => k.nodeId).sort(),
    cleanup: [...plan.cleanup.map((c) => c.outboundTag), ...plan.cleanup.map((c) => c.inboundTag), ...plan.cleanup.map((c) => c.ruleTag)]
      .filter(Boolean)
      .sort(),
  })
}

export function planSummary(plan: ApplyPlan) {
  return {
    add: plan.add.length,
    change: plan.change.length,
    remove: plan.remove.length,
    keep: plan.keep.length,
    drift: plan.drift.outboundTags.length + plan.drift.inboundTags.length + plan.drift.ruleTags.length,
    cleanup: plan.cleanup.length,
  }
}
