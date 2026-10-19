import type { ReactNode } from "react"
import { Link } from "@teyik0/furin/link"
import { Radar, Search, Server } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { DataTable, type DataTableColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { fmtMs } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { NodeRow } from "./types"

interface NodesTableProps {
  nodes: NodeRow[]
  loading: boolean
  selected: Set<string>
  checkingId: string | null
  togglingId: string | null
  empty: ReactNode
  onToggleAll: (checked: boolean) => void
  onToggleSelect: (id: string, checked: boolean) => void
  onOpen: (node: NodeRow) => void
  onCheck: (node: NodeRow) => void
  onToggleEnabled: (node: NodeRow, enabled: boolean) => void
}

/** 节点表格：服务端分页数据只做展示；所有交互通过回调交给页面统一处理。 */
export function NodesTable({
  nodes,
  loading,
  selected,
  checkingId,
  togglingId,
  empty,
  onToggleAll,
  onToggleSelect,
  onOpen,
  onCheck,
  onToggleEnabled,
}: NodesTableProps) {
  const allSelected = nodes.length > 0 && nodes.every((node) => selected.has(node.id))
  const someSelected = nodes.some((node) => selected.has(node.id))

  const columns: DataTableColumn<NodeRow>[] = [
    {
      key: "select",
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(checked) => onToggleAll(checked === true)}
          aria-label="全选当前页节点"
        />
      ),
      className: "w-8 pr-0",
      headClassName: "w-8",
      cell: (node) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected.has(node.id)}
            onCheckedChange={(checked) => onToggleSelect(node.id, checked === true)}
            aria-label={"选择节点 " + node.id}
          />
        </span>
      ),
    },
    {
      key: "name",
      header: "名称 / ID",
      className: "max-w-64",
      cell: (node) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{node.displayName || node.id}</span>
            {node.missingSince ? (
              <Badge variant="outline" className="text-warning">
                已消失
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={node.username ?? node.id}>
            {node.id}
          </p>
        </div>
      ),
    },
    {
      key: "protocol",
      header: "协议",
      cell: (node) => (
        <Badge variant="secondary" className="font-mono text-[11px] uppercase">
          {node.protocol || "—"}
        </Badge>
      ),
    },
    {
      key: "country",
      header: "国家 / 地区",
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (node) => (
        <span className="text-sm">
          {node.countryCode ? <span className="font-mono font-medium">{node.countryCode}</span> : null}
          {node.region ? <span className={cn("text-muted-foreground", node.countryCode && "ml-1.5")}>{node.region}</span> : null}
          {!node.countryCode && !node.region ? <span className="text-muted-foreground">—</span> : null}
        </span>
      ),
    },
    {
      key: "delay",
      header: "延迟",
      cell: (node) => <DelayCell node={node} />,
    },
    {
      key: "exitIp",
      header: "出口 IP",
      className: "hidden lg:table-cell",
      headClassName: "hidden lg:table-cell",
      cell: (node) =>
        node.exitIp ? (
          <div className="min-w-0">
            <p className="font-mono text-xs">{node.exitIp}</p>
            {node.exitCountry ? <p className="text-[11px] text-muted-foreground">{node.exitCountry}</p> : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "state",
      header: "状态",
      cell: (node) => (
        <span title={node.errorMsg || undefined}>
          <StatusBadge state={node.state} />
        </span>
      ),
    },
    {
      key: "failStreak",
      header: "失败次数",
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (node) => (
        <span
          className={cn("tabular-nums", node.failStreak > 0 ? "font-medium text-destructive" : "text-muted-foreground")}
          title={node.failStreak > 0 ? "连续失败 " + node.failStreak + " 次" : "无连续失败"}
        >
          {node.failStreak}
        </span>
      ),
    },
    {
      key: "sources",
      header: "来源订阅",
      className: "hidden xl:table-cell max-w-40",
      headClassName: "hidden xl:table-cell",
      cell: (node) => {
        const names = node.sourceNames.filter(Boolean)
        if (names.length === 0) return <span className="text-muted-foreground">—</span>
        return (
          <span className="block max-w-40 truncate text-xs" title={names.join("、")}>
            {names.slice(0, 2).join("、")}
            {names.length > 2 ? " +" + (names.length - 2) : ""}
          </span>
        )
      },
    },
    {
      key: "publishable",
      header: "可发布",
      className: "hidden lg:table-cell",
      headClassName: "hidden lg:table-cell",
      cell: (node) =>
        node.protocolSupported ? (
          <Badge variant="outline" className="text-success">
            可发布
          </Badge>
        ) : (
          <Badge variant="outline" className="text-warning" title={node.publishError ?? "协议不受支持，无法进入发布快照"}>
            不支持
          </Badge>
        ),
    },
    {
      key: "lastCheckAt",
      header: "最后检测",
      className: "hidden lg:table-cell",
      headClassName: "hidden lg:table-cell",
      cell: (node) => <RelativeTime ts={node.lastCheckAt} className="text-xs text-muted-foreground" />,
    },
    {
      key: "enabled",
      header: "启用",
      cell: (node) => (
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={node.enabled}
            disabled={togglingId === node.id}
            onCheckedChange={(checked) => onToggleEnabled(node, checked === true)}
            aria-label={(node.enabled ? "停用节点 " : "启用节点 ") + node.id}
          />
          {togglingId === node.id ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : (
            <span className="hidden text-xs text-muted-foreground xl:inline">{node.enabled ? "已启用" : "已停用"}</span>
          )}
        </div>
      ),
    },
    {
      key: "ops",
      header: <span className="sr-only">操作</span>,
      className: "text-right",
      cell: (node) => (
        <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="xs" onClick={() => onOpen(node)}>
            详情
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={"立即检测 " + node.id}
            title="立即检测"
            disabled={checkingId === node.id}
            onClick={() => onCheck(node)}
          >
            {checkingId === node.id ? <Spinner className="size-4" /> : <Radar className="size-4" />}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={nodes}
      rowKey={(node) => node.id}
      loading={loading}
      loadingRows={8}
      onRowClick={onOpen}
      empty={empty}
      dense
      rowClassName={(node) => (node.enabled ? "" : "opacity-70")}
    />
  )
}

function DelayCell({ node }: { node: NodeRow }) {
  const ms = node.delayMs || node.totalMs || 0
  if (!ms) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Search className="size-3" />—
      </span>
    )
  }
  return (
    <span
      className={cn(
        "tabular-nums text-sm font-medium",
        ms < 800 ? "text-success" : ms < 2000 ? "text-warning" : "text-destructive",
      )}
      title={"连接 " + fmtMs(node.connectMs) + " · 总计 " + fmtMs(ms)}
    >
      {fmtMs(ms)}
    </span>
  )
}

/** 节点为空时的统一空态（页面复用，避免两处文案漂移） */
export function NodesEmpty({ filtered, onReset }: { filtered: boolean; onReset: () => void }) {
  return (
    <EmptyState
      icon={filtered ? Search : Server}
      title={filtered ? "没有匹配的节点" : "还没有节点"}
      description={
        filtered
          ? "当前搜索或筛选条件下没有节点。可以重置筛选后重试。"
          : "先在「订阅」页添加订阅并同步，节点会自动进入节点池；同步完成后这里会展示检测状态与凭据。"
      }
      action={
        filtered ? (
          <Button variant="outline" size="sm" onClick={onReset}>
            重置筛选
          </Button>
        ) : (
          <Button size="sm" asChild>
            <Link to="/subscriptions">添加订阅</Link>
          </Button>
        )
      }
    />
  )
}
