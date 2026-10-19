import { and, asc, count, eq } from 'drizzle-orm'
import type { Db } from '../core/db'
import { nodeCredentials, nodeStatus, nodes } from '../core/schema'
import type { SettingsStore } from '../core/settings'
import { sha1Hex } from '../core/crypto'
import { stableStringify } from '../core/ids'
import type { PortPool } from '../xray/ports'
import { buildDesiredNode, type DesiredNode } from '../xray/plan'

export interface NodeRow {
  id: string
  display_name: string
  protocol: string
  protocol_supported: number
  enabled: number
  outbound_json: string
  missing_since: number | null
  stale_until: number | null
  state: string | null
  username: string | null
  publish_policy_override: string | null
}

export interface DesiredResult {
  desired: DesiredNode[]
  included: number
  skippedUnsupported: number
  skippedQuarantined: number
  skippedExpired: number
  skippedNoCredential: number
  totalCandidates: number
  errors: { nodeId: string; message: string }[]
}

/** 内容派生后缀：outbound 内容不变 → tag 不变（这是 keep 完全不碰的前提） */
export function contentVariant(outbound: Record<string, unknown>): string {
  const copy = { ...outbound }
  delete (copy as any).tag
  return sha1Hex(stableStringify(copy)).slice(0, 6)
}

/**
 * PANEL.md §9.1 步骤 1：读取快照。
 * 关于 stale：§7.5 明确「消失的节点不立即动数据面，到达 stale_until 才 enabled=0 并在下一次发布移除」，
 * 因此这里只排除**已过期**的 stale 节点，而不是 §9.1 SQL 里写的 stale_until IS NULL（两者冲突时以 §7.5 为准）。
 */
export function buildDesiredNodes(
  db: Db,
  settings: SettingsStore,
  ports: PortPool,
  opts: { now?: number; nodeIds?: string[]; includeQuarantined?: boolean } = {},
): DesiredResult {
  const now = opts.now ?? Date.now()
  const s = settings.get()
  const policy = s.publish.policy

  const rows: NodeRow[] = db
    .select({
      id: nodes.id,
      display_name: nodes.display_name,
      protocol: nodes.protocol,
      protocol_supported: nodes.protocol_supported,
      enabled: nodes.enabled,
      outbound_json: nodes.outbound_json,
      missing_since: nodes.missing_since,
      stale_until: nodes.stale_until,
      publish_policy_override: nodes.publish_policy_override,
      state: nodeStatus.state,
      username: nodeCredentials.username,
    })
    .from(nodes)
    .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodes.id))
    .leftJoin(nodeCredentials, eq(nodeCredentials.node_id, nodes.id))
    .where(and(eq(nodes.enabled, 1), eq(nodes.protocol_supported, 1), eq(nodes.is_virtual, 0)))
    .orderBy(asc(nodes.id))
    .all()

  const desired: DesiredNode[] = []
  const errors: { nodeId: string; message: string }[] = []
  let skippedQuarantined = 0
  let skippedExpired = 0
  let skippedNoCredential = 0

  for (const row of rows) {
    if (!row.username) {
      skippedNoCredential++
      errors.push({ nodeId: row.id, message: '缺少节点凭据，无法发布' })
      continue
    }
    const expired = row.missing_since !== null && row.stale_until !== null && row.stale_until <= now
    const effectivePolicy = row.publish_policy_override || policy
    const quarantined = row.state === 'quarantined'
    if (quarantined && effectivePolicy !== 'all_enabled' && !opts.includeQuarantined) {
      skippedQuarantined++
      continue
    }
    if (expired) {
      skippedExpired++
      continue
    }
    let template: Record<string, unknown>
    try {
      template = JSON.parse(row.outbound_json) as Record<string, unknown>
    } catch (e) {
      errors.push({ nodeId: row.id, message: 'outbound_json 解析失败: ' + (e as Error).message })
      continue
    }
    let port: number
    try {
      port = ports.ensure(row.id, now)
    } catch (e) {
      errors.push({ nodeId: row.id, message: (e as Error).message })
      continue
    }
    desired.push(
      buildDesiredNode({
        nodeId: row.id,
        username: row.username,
        port,
        outbound: template,
        variant: contentVariant(template),
      }),
    )
  }

  const unsupported = db.select({ n: count() }).from(nodes).where(eq(nodes.protocol_supported, 0)).get()?.n ?? 0
  return {
    desired,
    included: desired.length,
    skippedUnsupported: unsupported,
    skippedQuarantined,
    skippedExpired,
    skippedNoCredential,
    totalCandidates: rows.length + unsupported,
    errors,
  }
}
 
