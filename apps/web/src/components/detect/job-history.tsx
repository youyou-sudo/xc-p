import { History, ListChecks, Play, Radar, RefreshCw, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { fmtDuration, fmtMs, jobStatusMeta } from "@/lib/format"
import { jobDepth, jobResultSummary } from "./format"
import type { DetectJob } from "./types"

export function RunningDetectJobsCard({
  jobs,
  loading,
  cancelingId,
  onCancel,
}: {
  jobs: DetectJob[]
  loading: boolean
  cancelingId: string | null
  onCancel: (job: DetectJob) => void
}) {
  const active = jobs.filter((job) => job.status === "running" || job.status === "queued")
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="size-4 text-primary" />
          进行中的检测
        </CardTitle>
        <CardDescription>{active.length ? active.length + " 个任务排队或进行中" : "任务进度会通过 SSE / 轮询实时更新"}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && !jobs.length ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState icon={Radar} title="没有进行中的检测" description="点击「开始批量检测」后，进度与取消入口会出现在这里。" compact />
        ) : (
          <ul className="space-y-2">
            {active.map((job) => {
              const meta = jobStatusMeta(job.status)
              const percent = job.total > 0 ? Math.min(100, Math.round((job.progress / job.total) * 100)) : job.status === "running" ? 5 : 0
              return (
                <li key={job.id} className="rounded-lg border px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge state={job.status} label={meta.label} tone={meta.tone} />
                    <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                      {jobDepth(job) ?? "detect"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      <RelativeTime ts={job.started_at ?? job.created_at} />
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Progress value={percent} className="h-1.5 flex-1" />
                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{percent}%</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={job.message ?? ""}>
                      {job.message || job.id}
                    </p>
                    <LoadingButton
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      loading={cancelingId === job.id}
                      loadingText="取消中…"
                      onClick={() => onCancel(job)}
                    >
                      <X data-icon="inline-start" />
                      取消
                    </LoadingButton>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function DetectJobHistoryCard({
  jobs,
  loading,
  error,
  onRetry,
  onStartLite,
}: {
  jobs: DetectJob[]
  loading: boolean
  error: unknown
  onRetry: () => void
  onStartLite: () => void
}) {
  const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued")
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-4 text-primary" />
          检测任务历史
        </CardTitle>
        <CardDescription>GET /api/jobs?kind=detect · 最近 20 个任务（含单节点检测与批量检测）</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={onRetry} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading && !jobs.length ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : error && !jobs.length ? (
          <ErrorState error={error} title="加载检测任务失败" onRetry={onRetry} compact />
        ) : finished.length === 0 ? (
          <EmptyState
            icon={History}
            title="暂无检测任务记录"
            description="执行一次检测后，任务状态、结果计数与错误会保留在这里。"
            action={
              <Button size="sm" onClick={onStartLite}>
                <Play data-icon="inline-start" />
                轻量检测全部
              </Button>
            }
            compact
          />
        ) : (
          <ul className="divide-y">
            {finished.map((job) => {
              const meta = jobStatusMeta(job.status)
              const duration =
                job.started_at && job.finished_at ? fmtDuration((job.finished_at - job.started_at) / 1000) : job.message || "—"
              return (
                <li key={job.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 text-sm">
                  <StatusBadge state={job.status} label={meta.label} tone={meta.tone} />
                  <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                    {jobDepth(job) ?? "detect"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-muted-foreground" title={jobResultSummary(job)}>
                      {jobResultSummary(job)}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {job.id}
                      {job.created_by ? " · " + job.created_by : ""}
                    </p>
                    {job.error ? <p className="mt-0.5 line-clamp-2 break-all text-xs text-destructive">{job.error}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-muted-foreground">
                    <RelativeTime ts={job.finished_at ?? job.created_at} />
                    <span className="tabular-nums">{duration}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function DetectPressureCard({
  concurrency,
  activeConns,
  checked,
  total,
  quarantined,
  averageDelay,
}: {
  concurrency: number
  activeConns: number
  checked: number
  total: number
  quarantined: number
  averageDelay: number
}) {
  const ratio = activeConns > 0 ? concurrency / activeConns : 0
  const high = ratio > 0.5
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="size-4 text-primary" />
          检测压力
        </CardTitle>
        <CardDescription>检测流量经过数据面，并发必须显著低于网关承载能力（§8.4）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <PressureMetric label="检测并发上限" value={String(concurrency)} />
          <PressureMetric label="网关当前连接" value={String(activeConns)} />
          <PressureMetric label="并发占比" value={activeConns ? (ratio * 100).toFixed(1) + "%" : "—"} tone={high ? "down" : "ok"} />
          <PressureMetric label="已检测节点" value={checked + " / " + total} />
          <PressureMetric label="隔离节点" value={String(quarantined)} tone={quarantined ? "degraded" : "ok"} />
          <PressureMetric label="平均延迟" value={averageDelay ? fmtMs(averageDelay) : "—"} />
        </div>
        {high ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <Radar className="mt-0.5 size-3.5 shrink-0" />
            检测并发相对网关连接数偏高，建议下调 detect.concurrency，避免挤占用户带宽。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">并发上限会同时约束定时检测与手动批量检测。</p>
        )}
      </CardContent>
    </Card>
  )
}

function PressureMetric({ label, value, tone = "idle" }: { label: string; value: string; tone?: "ok" | "degraded" | "down" | "idle" }) {
  const color = tone === "down" ? "text-destructive" : tone === "degraded" ? "text-warning" : tone === "ok" ? "text-success" : ""
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={"mt-0.5 text-sm font-semibold tabular-nums " + color}>{value}</p>
    </div>
  )
}
