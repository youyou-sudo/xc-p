import { describe, expect, test } from 'bun:test'
import { computePlan, planDigest, planSummary, type AppliedNode, type DataplaneSnapshot, type DesiredNode } from '../src/xray/plan'

function desired(nodeId: string, variant = 'aaaaaa'): DesiredNode {
  const tag = 'out-' + nodeId + '.' + variant
  return {
    nodeId,
    username: nodeId,
    outboundTag: tag,
    inboundTag: 'in-' + nodeId + '.' + variant,
    ruleTag: 'node-' + nodeId + '.' + variant,
    inboundPort: 24000,
    outbound: { tag, protocol: 'freedom' },
    contentHash: 'hash-' + nodeId,
  }
}

function applied(nodeId: string, variant = 'aaaaaa'): AppliedNode {
  const tag = 'out-' + nodeId + '.' + variant
  return {
    nodeId,
    outboundTag: tag,
    inboundTag: 'in-' + nodeId + '.' + variant,
    ruleTag: 'node-' + nodeId + '.' + variant,
    port: 24000,
    outboundJson: '{}',
    contentHash: 'hash-' + nodeId,
    appliedAt: 1,
  }
}

function snapshot(outbounds: string[], inbounds: string[] = [], rules: string[] = []): DataplaneSnapshot {
  return {
    at: 1,
    outbounds: ['out-direct', ...outbounds],
    inbounds: inbounds.map((tag) => ({ tag })),
    rules: rules.map((ruleTag) => ({ ruleTag })),
    rulesSupported: true,
    digest: 'x',
  }
}

describe('computePlan 漂移与清理', () => {
  test('孤儿 tag 进入 cleanup，但不计入 remove（发布安全阀）', () => {
    const d = [desired('n1')]
    const a = [applied('n1')]
    const plan = computePlan(d, a, snapshot(['out-n1.aaaaaa', 'out-orphan1'], ['in-n1.aaaaaa', 'in-orphan1']))
    expect(plan.drift.outboundTags).toEqual(['out-orphan1'])
    expect(plan.drift.inboundTags).toEqual(['in-orphan1'])
    expect(plan.cleanup.map((c) => c.outboundTag).filter(Boolean)).toEqual(['out-orphan1'])
    expect(plan.cleanup.map((c) => c.inboundTag).filter(Boolean)).toEqual(['in-orphan1'])
    expect(plan.remove).toHaveLength(0)
    expect(planSummary(plan).remove).toBe(0)
    expect(planSummary(plan).cleanup).toBe(2)
  })

  test('pending_retire 中的 tag 不算漂移，也不重复清理', () => {
    const d = [desired('n1')]
    const a = [applied('n1')]
    const plan = computePlan(d, a, snapshot(['out-n1.aaaaaa', 'out-retiring'], ['in-n1.aaaaaa']), {
      pendingRetire: new Set(['out-retiring']),
    })
    expect(plan.drift.outboundTags).toEqual([])
    expect(plan.cleanup).toHaveLength(0)
  })

  test('新节点 tag 已经幂等存在时不误判为漂移', () => {
    const d = [desired('n1'), desired('n2')]
    const a = [applied('n1')]
    const plan = computePlan(
      d,
      a,
      snapshot(['out-n1.aaaaaa', 'out-n2.aaaaaa'], ['in-n1.aaaaaa', 'in-n2.aaaaaa'], ['node-n1.aaaaaa']),
    )
    expect(plan.add.map((x) => x.nodeId)).toEqual(['n2'])
    expect(plan.drift.outboundTags).toEqual([])
    expect(plan.cleanup).toHaveLength(0)
  })

  test('真正删除的节点仍在 remove，旧 tag 不进入 drift', () => {
    const d = [desired('n1')]
    const a = [applied('n1'), applied('n2')]
    const plan = computePlan(d, a, snapshot(['out-n1.aaaaaa', 'out-n2.aaaaaa'], ['in-n1.aaaaaa', 'in-n2.aaaaaa']))
    expect(plan.remove.map((r) => r.nodeId)).toEqual(['n2'])
    expect(plan.drift.outboundTags).toEqual([])
    expect(plan.cleanup).toHaveLength(0)
  })

  test('out/in 都在但路由规则丢失时，节点进入 add（对账应补规则）', () => {
    const d = [desired('n1')]
    const a = [applied('n1')]
    const plan = computePlan(d, a, snapshot(['out-n1.aaaaaa'], ['in-n1.aaaaaa'], []))
    expect(plan.add.map((x) => x.nodeId)).toEqual(['n1'])
    expect(plan.keep).toHaveLength(0)
  })

  test('lsrules 不可用时不因规则缺失误判 add', () => {
    const d = [desired('n1')]
    const a = [applied('n1')]
    const snap = { ...snapshot(['out-n1.aaaaaa'], ['in-n1.aaaaaa'], []), rulesSupported: false }
    const plan = computePlan(d, a, snap)
    expect(plan.add).toHaveLength(0)
    expect(plan.keep.map((x) => x.nodeId)).toEqual(['n1'])
  })

  test('planDigest 覆盖 cleanup，清理项变化会改变 digest', () => {
    const d = [desired('n1')]
    const a = [applied('n1')]
    const one = computePlan(d, a, snapshot(['out-n1.aaaaaa']))
    const two = computePlan(d, a, snapshot(['out-n1.aaaaaa', 'out-orphan1']))
    expect(planDigest(one)).not.toBe(planDigest(two))
  })
})
