import { useState, type ReactNode } from "react"
import { ScrollText, Terminal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/common/code-block"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { ExpandableTable } from "@/components/events/expandable-table"
import { fmtMs, fmtTime, jsonPretty } from "@/lib/format"

export interface AuditItem {
  id: number
  at: number
  actor_type: string
  actor_id?: string | null
  action: string
  target?: string | null
  ip?: string | null
  request_id?: string | null
  detail?: unknown
  detail_json?: string | null
}

export interface ApplyOpItem {
  id: number
  revision_id?: string | null
  at: number
  op: string
  tag?: string | null
  payload_json?: string | null
  ok: number | boolean
  duration_ms?: number | null
  stdout?: string | null
  stderr?: string | null
  error_kind?: string | null
}

function safeJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function auditDetail(item: AuditItem): unknown {
  if (item.detail !== undefined && item.detail !== null) return item.detail
  return safeJson(item.detail_json)
}

/** audit_log：谁在什么时候做了什么（登录、发布、回滚、网关踢线……）。 */
export function AuditLogTable({ items, loading, empty }: { items: AuditItem[]; loading?: boolean; empty: ReactNode }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <ExpandableTable
      rows={items}
      rowKey={(item) => String(item.id)}
      loading={loading}
      loadingRows={10}
      expandedKey={expanded}
      onToggle={(key) => setExpanded((prev) => (prev === key ? null : key))}
      empty={empty}
      columns={[
        {
          key: "at",
          header: "时间",
          headClassName: "w-24",
          cell: (item) => (
            <span className="text-xs text-muted-foreground" title={fmtTime(item.at)}>
              <RelativeTime ts={item.at} />
            </span>
          ),
        },
        {
          key: "action",
          header: "操作",
          cell: (item) => (
            <Badge variant="outline" className="max-w-55 font-mono text-[11px] font-normal">
              <span className="truncate" title={item.action}>
                {item.action}
              </span>
            </Badge>
          ),
        },
        {
          key: "actor",
          header: "执行者",
          cell: (item) => (
            <span className="text-xs">
              <span className="text-muted-foreground">{item.actor_type}</span>
              {item.actor_id ? <span className="ml-1.5 font-mono text-[11px]">{item.actor_id}</span> : null}
            </span>
          ),
        },
        {
          key: "target",
          header: "目标",
          className: "hidden md:table-cell",
          cell: (item) => (
            <span className="block max-w-50 truncate font-mono text-[11px] text-muted-foreground" title={item.target ?? ""}>
              {item.target || "—"}
            </span>
          ),
        },
        {
          key: "ip",
          header: "来源 IP",
          className: "hidden lg:table-cell",
          cell: (item) => <span className="font-mono text-[11px] text-muted-foreground">{item.ip || "—"}</span>,
        },
        {
          key: "detail",
          header: "详情",
          className: "w-14 text-right",
          cell: () => <span className="text-[11px] text-muted-foreground">展开</span>,
        },
      ]}
      renderExpanded={(item) => {
        const detail = auditDetail(item)
        return (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">操作</dt>
                <dd className="font-mono">{item.action}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">执行者</dt>
                <dd>
                  {item.actor_type} / {item.actor_id || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">目标</dt>
                <dd className="font-mono">{item.target || "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">requestId</dt>
                <dd className="font-mono">{item.request_id || "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">时间</dt>
                <dd>
                  <TimeText ts={item.at} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">来源 IP</dt>
                <dd className="font-mono">{item.ip || "—"}</dd>
              </div>
            </dl>
            {detail === null ? (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">该审计记录没有附加详情。</p>
            ) : typeof detail === "string" ? (
              <CodeBlock code={detail} title="detail" maxHeight={220} wrap />
            ) : (
              <CodeBlock code={jsonPretty(detail)} title="detail.json" language="json" maxHeight={220} />
            )}
          </div>
        )
      }}
    />
  )
}

/** xray_apply_ops：每次数据面调用一条，既是审计也是热操作计数的来源。 */
export function ApplyOpsTable({ items, loading, empty }: { items: ApplyOpItem[]; loading?: boolean; empty: ReactNode }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <ExpandableTable
      rows={items}
      rowKey={(item) => String(item.id)}
      loading={loading}
      loadingRows={10}
      expandedKey={expanded}
      onToggle={(key) => setExpanded((prev) => (prev === key ? null : key))}
      empty={empty}
      columns={[
        {
          key: "at",
          header: "时间",
          headClassName: "w-24",
          cell: (item) => (
            <span className="text-xs text-muted-foreground" title={fmtTime(item.at)}>
              <RelativeTime ts={item.at} />
            </span>
          ),
        },
        {
          key: "op",
          header: "数据面调用",
          cell: (item) => (
            <Badge variant="secondary" className="font-mono text-[11px] font-normal">
              {item.op}
            </Badge>
          ),
        },
        {
          key: "tag",
          header: "tag",
          className: "hidden md:table-cell",
          cell: (item) => (
            <span className="block max-w-50 truncate font-mono text-[11px]" title={item.tag ?? ""}>
              {item.tag || "—"}
            </span>
          ),
        },
        {
          key: "revision",
          header: "revision",
          className: "hidden lg:table-cell",
          cell: (item) => (
            <span className="block max-w-40 truncate font-mono text-[11px] text-muted-foreground" title={item.revision_id ?? ""}>
              {item.revision_id || "—"}
            </span>
          ),
        },
        {
          key: "ok",
          header: "结果",
          cell: (item) => (
            <StatusBadge
              state={item.ok ? "ok" : "failed"}
              label={item.ok ? "成功" : "失败"}
              tone={item.ok ? "ok" : "down"}
            />
          ),
        },
        {
          key: "duration",
          header: "耗时",
          cell: (item) => <span className="text-xs tabular-nums text-muted-foreground">{fmtMs(item.duration_ms)}</span>,
        },
        {
          key: "error",
          header: "错误类型",
          className: "hidden xl:table-cell",
          cell: (item) => (
            <span className="font-mono text-[11px] text-muted-foreground">{item.error_kind || "—"}</span>
          ),
        },
        {
          key: "detail",
          header: "输出",
          className: "w-14 text-right",
          cell: () => <span className="text-[11px] text-muted-foreground">展开</span>,
        },
      ]}
      renderExpanded={(item) => {
        const payload = safeJson(item.payload_json)
        return (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono">{item.op}</span> · tag <span className="font-mono">{item.tag || "—"}</span> · revision{" "}
              <span className="font-mono">{item.revision_id || "—"}</span> · 耗时 {fmtMs(item.duration_ms)}
              {item.error_kind ? " · 错误类型 " + item.error_kind : ""}
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              <CodeBlock code={jsonPretty(payload)} title="payload.json" maxHeight={220} />
              <div className="space-y-3">
                <CodeBlock code={item.stdout || "（空）"} title="stdout" maxHeight={100} wrap />
                <CodeBlock code={item.stderr || "（空）"} title="stderr" maxHeight={100} wrap />
              </div>
            </div>
          </div>
        )
      }}
    />
  )
}

export function AuditEmpty({ description }: { description: string }) {
  return <EmptyState icon={ScrollText} title="暂无审计记录" description={description} />
}

export function ApplyOpsEmpty() {
  return (
    <EmptyState
      icon={Terminal}
      title="暂无 xray_apply_ops 审计"
      description="每次数据面调用（ado / rmo / adi / rmi / adrules / rmrules / replay）都会写一条记录，发布或对账后即可看到。"
    />
  )
}
