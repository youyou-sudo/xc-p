import { useState } from "react"
import { CheckCircle2, ChevronDown, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { Dot } from "@/components/common/status-badge"
import { eventTone, fmtNumber, fmtPercent, stateMeta, toneBgClass } from "@/lib/format"
import { cn } from "@/lib/utils"
import { aggregateJobResults } from "./format"
import { ERROR_KINDS } from "@/lib/domain"
import type { DetectEvent, DetectJob, DetectNode } from "./types"

const STATUS_ROWS = ["up", "degraded", "down", "quarantined", "unknown"] as const

export function StatusDistributionCard({ nodes, total }: { nodes: DetectNode[]; total: number }) {
  const counts: Record<string, number> = { up: 0, degraded: 0, down: 0, quarantined: 0, unknown: 0 }
  for (const node of nodes) {
    const state = String(node.state ?? "unknown")
    counts[state] = (counts[state] ?? 0) + 1
  }
  const known = nodes.length
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-primary" />
          状态分布
        </CardTitle>
        <CardDescription>最近一次检测结果（共 {fmtNumber(total)} 个节点）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2.5">
          {STATUS_ROWS.map((state) => {
            const meta = stateMeta(state)
            const count = counts[state] ?? 0
            const percent = known ? Math.round((count / known) * 100) : 0
            return (
              <div key={state} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <Dot tone={meta.tone} />
                    {meta.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {count} · {percent}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full transition-all", toneBgClass(meta.tone))} style={{ width: percent + "%" }} />
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          已检测 {known - (counts.unknown ?? 0)} / {known} 个节点；隔离节点会在连续成功达到恢复阈值后自动恢复。
        </p>
      </CardContent>
    </Card>
  )
}

export function ErrorDistributionCard({ nodes, jobs }: { nodes: DetectNode[]; jobs: DetectJob[] }) {
  const [enumOpen, setEnumOpen] = useState(false)
  const failedNodes = nodes.filter((node) => !!node.errorKind)
  const byError = new Map<string, number>()
  for (const node of failedNodes) {
    const kind = String(node.errorKind)
    byError.set(kind, (byError.get(kind) ?? 0) + 1)
  }
  const errorRows = [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const recentJobs = jobs.filter((job) => job.finished_at && job.status !== "running" && job.status !== "queued").slice(0, 10)
  const aggregate = aggregateJobResults(recentJobs)
  const totalFailed = Math.max(aggregate.failed, failedNodes.length)
  const successPercent = aggregate.checked ? Math.round((aggregate.ok / aggregate.checked) * 100) : 0
  const failedPercent = aggregate.checked ? 100 - successPercent : 0

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-primary" />
          错误与结果分布
        </CardTitle>
        <CardDescription>按 error_kind 聚合失败节点；成功率来自最近 10 次检测任务</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {aggregate.checked ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">最近 {recentJobs.length} 次任务</span>
              <span className="tabular-nums text-muted-foreground">共 {aggregate.checked} 个节点</span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-success transition-all" style={{ width: successPercent + "%" }} />
              <div className="h-full bg-destructive transition-all" style={{ width: failedPercent + "%" }} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-success">
                <Dot tone="ok" /> 成功 {aggregate.ok}
              </span>
              <span className="flex items-center gap-1.5 text-destructive">
                <Dot tone="down" /> 失败 {aggregate.failed}
              </span>
              <span className="font-medium tabular-nums">成功率 {successPercent}%</span>
            </div>
          </div>
        ) : (
          <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">还没有已完成的检测任务，成功率会在任务结束后统计。</p>
        )}

        <Separator />

        {errorRows.length ? (
          <div className="space-y-2.5">
            {errorRows.map(([kind, count]) => {
              const percent = totalFailed ? Math.round((count / totalFailed) * 100) : 0
              return (
                <div key={kind} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono text-[11px] text-destructive" title={kind}>
                      {kind}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {count} · {fmtPercent(percent / 100, 0)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-destructive/80 transition-all" style={{ width: percent + "%" }} />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={CheckCircle2}
            title="当前没有失败节点"
            description="检测失败时会按 error_kind 聚合，便于定位网关、TLS 或出口问题。"
            compact
          />
        )}

        <Collapsible open={enumOpen} onOpenChange={setEnumOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-between px-1 text-xs">
              <span className="text-muted-foreground">全部错误枚举（§8.3）</span>
              <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", enumOpen && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {ERROR_KINDS.map((kind) => (
                <Badge key={kind} variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground">
                  {kind}
                </Badge>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

export function DetectEventsCard({
  events,
  loading,
  error,
  onRetry,
}: {
  events: DetectEvent[]
  loading: boolean
  error: unknown
  onRetry: () => void
}) {
  const filtered = events.filter((event) => /\.(quarantined|recovered)$/.test(event.kind))
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-primary" />
          隔离与恢复事件
        </CardTitle>
        <CardDescription>来自事件流（GET /api/events?kind=node）</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" onClick={onRetry} title="刷新事件" aria-label="刷新隔离与恢复事件">
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading && !events.length ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : error && !events.length ? (
          <ErrorState error={error} title="加载事件失败" onRetry={onRetry} compact />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="暂无隔离或恢复事件"
            description="节点连续失败达到隔离阈值，或隔离后连续成功达到恢复阈值时，这里会出现记录。"
            compact
          />
        ) : (
          <ul className="divide-y">
            {filtered.slice(0, 12).map((event) => (
              <li key={event.id} className="flex items-start gap-2.5 py-2.5 text-sm">
                <Dot tone={eventTone(event.level)} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2">{event.message}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {event.kind}
                    {event.node_id ? " · " + event.node_id : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime ts={event.at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
