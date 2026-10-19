import { ShieldOff, Unplug } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/common/empty-state"
import { SectionCard } from "@/components/common/section-card"
import { fmtNumber } from "@/lib/format"
import type { KickPayload } from "./types"

interface BannedListProps {
  ips: string[]
  activeByIp: Record<string, number>
  loading: boolean
  banCount: number
  banSeconds: number
  onKick: (payload: KickPayload, what: string, affected: number) => void
}

/** 当前封禁 IP：达到认证失败阈值后自动加入，到期自动解除。 */
export function BannedList({ ips, activeByIp, loading, banCount, banSeconds, onKick }: BannedListProps) {
  return (
    <SectionCard
      title="封禁 IP"
      description={
        banCount > 0
          ? "同 IP 连续认证失败 " + banCount + " 次后封禁 " + banSeconds + " 秒（settings.gateway）"
          : "当前未启用认证失败封禁（authFailBanCount = 0）"
      }
      actions={<Badge variant={ips.length ? "destructive" : "secondary"}>{ips.length} 个</Badge>}
    >
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : ips.length === 0 ? (
        <EmptyState
          icon={ShieldOff}
          title="当前没有封禁 IP"
          description="客户端认证失败达到阈值后会自动进入封禁列表；列表在封禁到期后自动清空。"
          compact
        />
      ) : (
        <div className="scrollbar-thin max-h-64 overflow-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead>IP</TableHead>
                <TableHead>当前连接</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ips.map((ip) => {
                const count = activeByIp[ip] ?? 0
                return (
                  <TableRow key={ip}>
                    <TableCell className="font-mono text-xs">{ip}</TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">{fmtNumber(count)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={count === 0}
                        onClick={() => onKick({ ip }, "IP " + ip, count)}
                      >
                        <Unplug data-icon="inline-start" />
                        断开其连接
                      </Button>
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
