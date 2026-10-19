import { useState } from "react"
import { ChevronDown, History, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { eden, unwrap } from "@/lib/api"
import { fmtBytes, fmtMs, toneTextClass } from "@/lib/format"
import { useResource } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import { formatHintLabel, formatInterval, maskUrl, runStatusMeta, triggerLabel } from "./format"
import type { SubscriptionItem, SubscriptionRun } from "./types"

interface RunsSheetProps {
  item: SubscriptionItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onSync: () => void
}

/** 单订阅的同步历史（GET /api/subscriptions/:id/runs），展示五个计数与解析错误样本。 */
export function SubscriptionRunsSheet({ item, open, onOpenChange, onSync }: RunsSheetProps) {
  const runs = useResource<{ items: SubscriptionRun[] }>(
    "subscription-runs:" + item.id,
    async (signal) =>
      (await unwrap(eden.api.subscriptions({ id: item.id }).runs.get({ query: { limit: 100 }, fetch: { signal } }))) as {
        items: SubscriptionRun[]
      },
    { enabled: open },
  )
  const items = runs.data?.items ?? []
  const counts = {
    ok: items.filter((run) => run.status === "ok").length,
    failed: items.filter((run) => run.status === "failed").length,
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-3 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            同步历史 · {item.name}
          </SheetTitle>
          <SheetDescription className="space-y-1">
            <span className="block truncate font-mono text-[11px]" title={maskUrl(item.url)}>
              {item.inline ? "内联文本订阅" : maskUrl(item.url)}
            </span>
            <span className="block">
              格式 {formatHintLabel(item.formatHint)} · 间隔 {formatInterval(item.intervalSec, item.cron)} · 近 100 次记录
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap items-center gap-2 px-4">
          <LoadingButton variant="outline" size="sm" loading={runs.refreshing} loadingText="刷新中…" onClick={runs.refresh}>
            <RefreshCw data-icon="inline-start" />
            刷新
          </LoadingButton>
          <Button variant="outline" size="sm" onClick={onSync}>
            <History data-icon="inline-start" />
            立即同步
          </Button>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal text-success">
              成功 {counts.ok}
            </Badge>
            <Badge variant="outline" className="font-normal text-destructive">
              失败 {counts.failed}
            </Badge>
          </span>
        </div>

        <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {runs.loading && !runs.data ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-28 w-full rounded-lg" />
              ))}
            </div>
          ) : runs.error && !runs.data ? (
            <ErrorState error={runs.error} title="加载同步历史失败" onRetry={runs.refresh} compact />
          ) : items.length === 0 ? (
            <EmptyState
              icon={History}
              title="暂无同步记录"
              description="该订阅还没有同步过。点击「立即同步」或等待下次定时任务触发，结果会记录在这里。"
              action={
                <Button size="sm" onClick={onSync}>
                  立即同步
                </Button>
              }
              compact
            />
          ) : (
            <>
              {items.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
              <p className="px-1 pt-1 text-xs text-muted-foreground">
                新增 / 修改 / 消失 / 恢复 / 不支持 是每次同步的五个计数；解析错误行不会阻塞其余行入库。
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RunCard({ run }: { run: SubscriptionRun }) {
  const [expanded, setExpanded] = useState(false)
  const meta = runStatusMeta(run.status)
  const errors = run.errors ?? []
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge state={run.status} label={meta.label} tone={meta.tone} />
        <Badge variant="secondary" className="font-normal">
          {triggerLabel(run.trigger)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          <TimeText ts={run.startedAt} />
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          耗时 {fmtMs(run.durationMs ?? undefined)}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <RunCounter label="总数" value={run.totalFound} />
        <RunCounter label="新增" value={run.added} tone="ok" prefix="+" />
        <RunCounter label="修改" value={run.changed} tone="degraded" prefix="~" />
        <RunCounter label="消失" value={run.removed} tone="down" prefix="−" />
        <RunCounter label="恢复" value={run.restored} tone="ok" />
        <RunCounter label="不支持" value={run.unsupported} tone={run.unsupported ? "degraded" : "idle"} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>HTTP {run.httpStatus ?? "—"}</span>
        <span>解析错误 {run.parseErrors}</span>
        <span>{run.bytes != null ? fmtBytes(run.bytes) : "字节 —"}</span>
        <span>
          完成于 <RelativeTime ts={run.finishedAt} />
        </span>
        {run.errorKind ? <span className="font-mono text-destructive">{run.errorKind}</span> : null}
      </div>

      {run.errorMsg ? (
        <p className="mt-2 break-all rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{run.errorMsg}</p>
      ) : null}

      {errors.length ? (
        <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
              <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} data-icon="inline-start" />
              解析错误样本（{errors.length}）
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="scrollbar-thin mt-1 max-h-56 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-14">行号</TableHead>
                    <TableHead className="w-32">类型</TableHead>
                    <TableHead>说明</TableHead>
                    <TableHead className="hidden sm:table-cell">片段</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((error, index) => (
                    <TableRow key={index}>
                      <TableCell className="tabular-nums text-xs text-muted-foreground">{error.line_no ?? "—"}</TableCell>
                      <TableCell className="font-mono text-[11px] text-destructive">{error.error_kind || "—"}</TableCell>
                      <TableCell className="max-w-56 truncate text-xs" title={error.error_msg ?? ""}>
                        {error.error_msg || "—"}
                      </TableCell>
                      <TableCell className="hidden max-w-44 truncate font-mono text-[11px] text-muted-foreground sm:table-cell" title={error.raw_snippet ?? ""}>
                        {error.raw_snippet || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

function RunCounter({
  label,
  value,
  tone = "idle",
  prefix = "",
}: {
  label: string
  value: number
  tone?: "ok" | "degraded" | "down" | "idle"
  prefix?: string
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-2 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-semibold tabular-nums", toneTextClass(tone))}>
        {prefix}
        {value ?? 0}
      </p>
    </div>
  )
}
