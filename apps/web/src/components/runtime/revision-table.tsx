import { Fragment, useState } from "react"
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LoadingButton } from "@/components/common/loading-button"
import { CodeBlock } from "@/components/common/code-block"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { ValidationChecks, type RevisionValidation } from "@/components/runtime/validation-checks"
import { fmtNumber, jsonPretty, stateMeta, type Tone } from "@/lib/format"

export interface RevisionNode {
  node_id: string
  username?: string | null
  outbound_tag?: string | null
  inbound_tag?: string | null
  inbound_port?: number | null
}

export interface RevisionItem {
  id: string
  status: string
  reason: string
  createdAt: number
  appliedAt?: number | null
  nodeCount: number
  added: number
  removed: number
  changed: number
  skipped: number
  plan?: unknown
  validation?: RevisionValidation | null
  error?: string | null
  /** GET /api/runtime/revisions 的节点明细来自数据库行（字段与 RevisionNode 一致） */
  nodes?: RevisionNode[] | Record<string, any>[]
}

const REVISION_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "生效中", tone: "ok" },
  applying: { label: "应用中", tone: "info" },
  validated: { label: "已校验", tone: "info" },
  draft: { label: "草稿", tone: "idle" },
  failed: { label: "失败", tone: "down" },
  rolled_back: { label: "已回滚", tone: "degraded" },
  retired: { label: "已退休", tone: "idle" },
}

const REASON_LABEL: Record<string, string> = {
  manual: "手动",
  cron: "定时",
  api: "服务 API",
  post_sync: "同步后",
  rollback: "回滚",
  recover: "恢复",
  restart: "重启",
}

export function revisionMeta(status?: string | null) {
  if (!status) return { label: "未知", tone: "idle" as Tone }
  const known = REVISION_STATUS[status]
  if (known) return known
  const meta = stateMeta(status)
  return { label: meta.label, tone: meta.tone }
}

function revisionReason(reason?: string | null): string {
  if (!reason) return "—"
  return REASON_LABEL[reason] ?? reason
}

interface RevisionTableProps {
  revisions: RevisionItem[]
  loading: boolean
  currentRevision: string | null
  rollingBackId: string | null
  onRollback: (revision: RevisionItem) => void
  onRebuildNode: (nodeId: string) => void
  rebuildingNodeId: string | null
}

/** revision 历史表：行可展开查看 plan / validation JSON 以及本次发布的节点。 */
export function RevisionTable({
  revisions,
  loading,
  currentRevision,
  rollingBackId,
  onRollback,
  onRebuildNode,
  rebuildingNodeId,
}: RevisionTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading && revisions.length === 0) {
    return (
      <div className="space-y-2 rounded-lg border p-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-9 w-full animate-pulse rounded bg-muted/60" />
        ))}
      </div>
    )
  }

  if (revisions.length === 0) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="还没有发布记录"
        description="点击顶部「发布」把当前期望状态推到数据面，成功后会在这里生成一条 revision，可随时查看计划或回滚。"
        compact
      />
    )
  }

  return (
    <div className="scrollbar-thin overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader className="bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-8" />
            <TableHead>revision</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="hidden md:table-cell">原因</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead className="hidden lg:table-cell">应用时间</TableHead>
            <TableHead className="text-right">节点</TableHead>
            <TableHead className="hidden sm:table-cell">增 / 删 / 改 / 跳过</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {revisions.map((revision) => {
            const open = expanded === revision.id
            const meta = revisionMeta(revision.status)
            const isCurrent = revision.id === currentRevision || revision.status === "active"
            return (
              <Fragment key={revision.id}>
                <TableRow
                  className="cursor-pointer"
                  data-state={open ? "selected" : undefined}
                  onClick={() => setExpanded(open ? null : revision.id)}
                >
                  <TableCell className="pr-0 text-muted-foreground">
                    {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </TableCell>
                  <TableCell className="max-w-45">
                    <span className="block truncate font-mono text-xs" title={revision.id}>
                      {revision.id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge state={revision.status} label={meta.label} tone={meta.tone} />
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{revisionReason(revision.reason)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span title={new Date(revision.createdAt).toLocaleString("zh-CN")}>
                      <RelativeTime ts={revision.createdAt} />
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {revision.appliedAt ? <RelativeTime ts={revision.appliedAt} /> : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{fmtNumber(revision.nodeCount)}</TableCell>
                  <TableCell className="hidden text-xs tabular-nums sm:table-cell">
                    <span className="text-success">+{revision.added}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span className="text-destructive">−{revision.removed}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span className="text-warning">~{revision.changed}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span className="text-muted-foreground">⊘{revision.skipped}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {isCurrent ? (
                      <Badge variant="secondary" className="font-normal">
                        当前生效
                      </Badge>
                    ) : (
                      <span onClick={(event) => event.stopPropagation()}>
                        <LoadingButton
                          variant="outline"
                          size="sm"
                          loading={rollingBackId === revision.id}
                          loadingText="回滚中…"
                          onClick={() => onRollback(revision)}
                        >
                          <RotateCcw data-icon="inline-start" />
                          回滚
                        </LoadingButton>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                {open ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={9} className="whitespace-normal bg-muted/20 p-0">
                      <RevisionDetail
                        revision={revision}
                        rebuildingNodeId={rebuildingNodeId}
                        onRebuildNode={onRebuildNode}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function RevisionDetail({
  revision,
  rebuildingNodeId,
  onRebuildNode,
}: {
  revision: RevisionItem
  rebuildingNodeId: string | null
  onRebuildNode: (nodeId: string) => void
}) {
  const validation = revision.validation ?? null
  const nodes = revision.nodes ?? []
  return (
    <div className="space-y-4 p-3">
      {revision.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">{revision.error}</p>
      ) : null}

      <ValidationChecks validation={validation} title="发布校验" />

      <div className="grid gap-3 lg:grid-cols-2">
        <CodeBlock code={jsonPretty(revision.plan)} title="plan.json" maxHeight={240} />
        <CodeBlock code={jsonPretty(validation)} title="validation.json" maxHeight={240} />
      </div>

      {nodes.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            本次发布的节点（{nodes.length}）
          </p>
          <div className="scrollbar-thin max-h-56 overflow-auto rounded-md border bg-card">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8">nodeId</TableHead>
                  <TableHead className="h-8">用户名</TableHead>
                  <TableHead className="hidden h-8 md:table-cell">outbound tag</TableHead>
                  <TableHead className="hidden h-8 sm:table-cell">端口</TableHead>
                  <TableHead className="h-8 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((node) => (
                  <TableRow key={node.node_id}>
                    <TableCell className="max-w-55 py-1.5">
                      <span className="block truncate font-mono text-[11px]" title={node.node_id}>
                        {node.node_id}
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5 text-[11px]">{node.username || "—"}</TableCell>
                    <TableCell className="hidden max-w-55 py-1.5 md:table-cell">
                      <span className="block truncate font-mono text-[11px]" title={node.outbound_tag ?? ""}>
                        {node.outbound_tag || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden py-1.5 text-[11px] tabular-nums sm:table-cell">{node.inbound_port ?? "—"}</TableCell>
                    <TableCell className="py-1.5 text-right">
                      <LoadingButton
                        variant="ghost"
                        size="sm"
                        loading={rebuildingNodeId === node.node_id}
                        loadingText="重建中…"
                        onClick={() => onRebuildNode(node.node_id)}
                      >
                        重建
                      </LoadingButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">该 revision 没有记录节点明细（失败或被安全阀拦下的发布不会写 revision_nodes）。</p>
      )}

      <p className="text-[11px] text-muted-foreground">
        创建于 <TimeText ts={revision.createdAt} /> · 应用时间 {revision.appliedAt ? <TimeText ts={revision.appliedAt} /> : "—"}
      </p>
    </div>
  )
}
