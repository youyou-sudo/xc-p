import { Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import { fmtDuration } from "@/lib/format"
import { useNow } from "@/lib/hooks"
import { cn } from "@/lib/utils"

export interface RetireItem {
  tag: string
  kind: string
  retireAfter?: number
  remainMs: number
}

/** 待退休 tag 队列：每秒刷新倒计时，给在途连接收尾窗口。 */
export function RetireQueue({ items, loading }: { items: RetireItem[]; loading?: boolean }) {
  const now = useNow(1000)

  if (loading && items.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="当前没有待退休的 tag"
        description="发布移除或变更节点后，旧 tag 会先进入延迟删除队列，这里按倒计时展示；到期后自动执行 rmo。"
        compact
      />
    )
  }

  return (
    <div className="space-y-2">
      <div className="scrollbar-thin overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead>类型</TableHead>
              <TableHead>tag</TableHead>
              <TableHead className="text-right">倒计时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const remain = item.retireAfter ? Math.max(0, item.retireAfter - now) : Math.max(0, item.remainMs)
              const due = remain <= 0
              return (
                <TableRow key={item.kind + ":" + item.tag}>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[11px] font-normal">
                      {item.kind || "outbound"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-70">
                    <span className="block truncate font-mono text-xs" title={item.tag}>
                      {item.tag}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "text-xs tabular-nums",
                        due ? "text-warning" : remain < 30_000 ? "text-warning" : "text-muted-foreground",
                      )}
                    >
                      {due ? "到期（即将执行 rmo）" : fmtDuration(Math.ceil(remain / 1000))}
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Xray 无法枚举已建立连接，因此这里只显示「延迟删除的估算窗口」，不代表精确的在途连接数。
      </p>
    </div>
  )
}
