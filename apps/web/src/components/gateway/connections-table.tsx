import { useMemo, useState, type ReactNode } from "react"
import { Search, Unplug } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable, type DataTableColumn } from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"
import { fmtBytes, fmtDuration, fmtNumber } from "@/lib/format"
import { useNow } from "@/lib/hooks"
import type { ActiveConnection, KickPayload } from "./types"

interface ConnectionsTableProps {
  rows: ActiveConnection[]
  loading: boolean
  empty: ReactNode
  onKick: (payload: KickPayload, what: string, affected: number) => void
}

/** 连接明细：搜索 + 逐条踢线（网关独有的能力）。 */
export function ConnectionsTable({ rows, loading, empty, onKick }: ConnectionsTableProps) {
  const [query, setQuery] = useState("")
  const now = useNow(5_000)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) =>
      [row.nodeId, row.username, row.clientIp, row.target, row.protocol]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [rows, query])

  const columns: DataTableColumn<ActiveConnection>[] = [
    {
      key: "id",
      header: "连接",
      cell: (row) => <span className="font-mono text-xs text-muted-foreground">#{row.id}</span>,
    },
    {
      key: "nodeId",
      header: "节点",
      cell: (row) => <span className="font-mono text-xs font-medium">{row.nodeId || "—"}</span>,
    },
    {
      key: "username",
      header: "用户名",
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (row) => <span className="font-mono text-xs">{row.username || "—"}</span>,
    },
    {
      key: "clientIp",
      header: "客户端 IP",
      cell: (row) => <span className="font-mono text-xs">{row.clientIp || "—"}</span>,
    },
    {
      key: "protocol",
      header: "协议",
      className: "hidden sm:table-cell",
      headClassName: "hidden sm:table-cell",
      cell: (row) => (
        <Badge variant="secondary" className="font-mono text-[11px] uppercase">
          {row.protocol || "—"}
        </Badge>
      ),
    },
    {
      key: "target",
      header: "目标",
      className: "hidden max-w-56 lg:table-cell",
      headClassName: "hidden lg:table-cell",
      cell: (row) => (
        <span className="block max-w-56 truncate font-mono text-xs text-muted-foreground" title={row.target}>
          {row.target || "—"}
        </span>
      ),
    },
    {
      key: "startedAt",
      header: "建立时间",
      cell: (row) => <RelativeTime ts={row.startedAt} className="text-xs text-muted-foreground" />,
    },
    {
      key: "duration",
      header: "持续",
      cell: (row) => (
        <span className="text-xs tabular-nums">{fmtDuration(Math.max(0, Math.round((now - row.startedAt) / 1000)))}</span>
      ),
    },
    {
      key: "bytes",
      header: "上行 / 下行",
      className: "hidden text-xs xl:table-cell",
      headClassName: "hidden xl:table-cell",
      cell: (row) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          ↑{fmtBytes(row.upBytes)} ↓{fmtBytes(row.downBytes)}
        </span>
      ),
    },
    {
      key: "ops",
      header: <span className="sr-only">操作</span>,
      className: "text-right",
      cell: (row) => (
        <Button
          variant="outline"
          size="xs"
          className="text-destructive hover:text-destructive"
          onClick={() => onKick({ connId: row.id }, "连接 #" + row.id, 1)}
        >
          <Unplug data-icon="inline-start" />
          踢线
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点 / 用户名 / IP / 目标"
            className="h-8 pl-8"
            aria-label="搜索连接"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          共 {fmtNumber(rows.length)} 条活跃连接{query.trim() ? " · 匹配 " + filtered.length + " 条" : ""}
        </span>
      </div>
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(row) => String(row.id)}
        loading={loading}
        loadingRows={6}
        empty={empty}
        dense
      />
    </div>
  )
}
