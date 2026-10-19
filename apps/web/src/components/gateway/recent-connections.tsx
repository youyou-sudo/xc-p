import { useState } from "react"
import { History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/common/empty-state"
import { SectionCard } from "@/components/common/section-card"
import { StatusBadge } from "@/components/common/status-badge"
import { TimeText } from "@/components/common/relative-time"
import { fmtBytes } from "@/lib/format"
import { closeReasonLabel, type RecentConnection } from "./types"

/** 最近连接历史：来自 node_connections（活跃 + 已关闭）。 */
export function RecentConnections({ rows, loading }: { rows: RecentConnection[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const visible = rows.slice(0, expanded ? 50 : 10)

  return (
    <SectionCard
      title="最近连接"
      description="来自网关连接表的最近记录（活跃 + 已关闭），用于排查客户端行为"
      actions={
        rows.length > 10 ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : "显示更多"}
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={History}
          title="暂无连接历史"
          description="客户端第一次通过网关建立连接后，这里会出现记录。"
          compact
        />
      ) : (
        <div className="scrollbar-thin max-h-72 overflow-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead>开始时间</TableHead>
                <TableHead>节点</TableHead>
                <TableHead className="hidden md:table-cell">客户端 IP</TableHead>
                <TableHead className="hidden lg:table-cell">目标</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden text-right xl:table-cell">流量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const reason = closeReasonLabel(row.closed_at ? row.close_reason : null)
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      <TimeText ts={row.started_at} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.node_id || row.username || "—"}</TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{row.client_ip || "—"}</TableCell>
                    <TableCell className="hidden max-w-48 lg:table-cell">
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={row.target ?? undefined}>
                        {row.target || "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge state={row.closed_at ? "idle" : "up"} label={reason.label} tone={reason.tone} />
                    </TableCell>
                    <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums xl:table-cell">
                      ↑{fmtBytes(row.up_bytes)} ↓{fmtBytes(row.down_bytes)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  )
}
