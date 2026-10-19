import { useState, type ReactNode } from "react"
import { BellOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeBlock } from "@/components/common/code-block"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { ExpandableTable } from "@/components/events/expandable-table"
import { fmtTime, jsonPretty, type Tone } from "@/lib/format"

export interface EventItem {
  id: number
  at: number
  level: string
  kind: string
  node_id?: string | null
  subscription_id?: string | null
  revision_id?: string | null
  message: string
  detail?: unknown
  detail_json?: string | null
}

const LEVEL_META: Record<string, { label: string; tone: Tone }> = {
  info: { label: "信息", tone: "info" },
  warn: { label: "警告", tone: "degraded" },
  warning: { label: "警告", tone: "degraded" },
  error: { label: "错误", tone: "down" },
  ok: { label: "成功", tone: "ok" },
  success: { label: "成功", tone: "ok" },
}

function levelMeta(level?: string | null) {
  if (!level) return { label: "—", tone: "idle" as Tone }
  return LEVEL_META[level.toLowerCase()] ?? { label: level, tone: "idle" as Tone }
}

function detailOf(event: EventItem): unknown {
  if (event.detail !== undefined && event.detail !== null) return event.detail
  if (event.detail_json) {
    try {
      return JSON.parse(event.detail_json)
    } catch {
      return event.detail_json
    }
  }
  return null
}

export function EventsTable({
  items,
  loading,
  empty,
}: {
  items: EventItem[]
  loading?: boolean
  empty: ReactNode
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <ExpandableTable
      rows={items}
      rowKey={(event) => String(event.id)}
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
          cell: (event) => (
            <span className="text-xs text-muted-foreground" title={fmtTime(event.at)}>
              <RelativeTime ts={event.at} />
            </span>
          ),
        },
        {
          key: "level",
          header: "等级",
          cell: (event) => {
            const meta = levelMeta(event.level)
            return <StatusBadge state={event.level} label={meta.label} tone={meta.tone} />
          },
        },
        {
          key: "kind",
          header: "类型",
          className: "hidden md:table-cell",
          cell: (event) => (
            <span className="font-mono text-[11px] text-muted-foreground" title={event.kind}>
              {event.kind}
            </span>
          ),
        },
        {
          key: "message",
          header: "消息",
          className: "min-w-56 max-w-100 whitespace-normal md:min-w-80",
          cell: (event) => <span className="line-clamp-2 break-words text-xs leading-relaxed">{event.message}</span>,
        },
        {
          key: "node",
          header: "节点",
          className: "hidden lg:table-cell",
          cell: (event) => (
            <span className="font-mono text-[11px] text-muted-foreground" title={event.node_id ?? ""}>
              {event.node_id || "—"}
            </span>
          ),
        },
        {
          key: "detail",
          header: "详情",
          className: "w-14 text-right",
          cell: () => <span className="text-[11px] text-muted-foreground">展开</span>,
        },
      ]}
      renderExpanded={(event) => {
        const detail = detailOf(event)
        return (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed break-words">{event.message}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">等级</dt>
                <dd>{levelMeta(event.level).label}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">类型</dt>
                <dd className="font-mono">{event.kind}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">节点</dt>
                <dd className="font-mono">{event.node_id || "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">revision</dt>
                <dd className="font-mono">{event.revision_id || "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">时间</dt>
                <dd>
                  <TimeText ts={event.at} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">订阅</dt>
                <dd className="font-mono">{event.subscription_id || "—"}</dd>
              </div>
            </dl>
            {detail === null ? (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">该事件没有结构化详情字段。</p>
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

export function EventsEmpty({ onClear, filtered }: { onClear: () => void; filtered: boolean }) {
  return (
    <EmptyState
      icon={BellOff}
      title={filtered ? "当前过滤条件下没有事件" : "还没有任何事件"}
      description={
        filtered
          ? "尝试放宽等级、类型、节点或时间范围，或清除全部过滤条件。"
          : "同步、检测、发布、对账等操作都会写入事件总线，第一次操作后就会出现在这里。"
      }
      action={
        filtered ? (
          <Button variant="link" size="sm" onClick={onClear}>
            清除全部过滤
          </Button>
        ) : null
      }
    />
  )
}
