import { useNavigate } from "@teyik0/furin/link"
import {
  Activity,
  ArrowRight,
  CircleAlert,
  Clock,
  GitBranch,
  Layers,
  ListChecks,
  Radio,
  Rss,
  Server,
  Timer,
  TriangleAlert,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { RelativeTime } from "@/components/common/relative-time"
import { StatCard } from "@/components/common/stat-card"
import { Dot, StatusBadge } from "@/components/common/status-badge"
import { eden, normalizeNode, startJob, unwrap } from "@/lib/api"
import { eventTone, fmtMs, fmtNumber, fmtUptime, stateMeta, toneBgClass } from "@/lib/format"
import { useResource } from "@/lib/hooks"
import { refreshHealth, useHealth } from "@/lib/health"
import { useJobAction } from "@/lib/use-job"
import { defineRoute } from "@teyik0/furin"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "概览 · xc-p" }] }))
  .page(() => <OverviewPage />)

interface NodeItem {
  id: string
  displayName?: string
  protocol: string
  countryCode?: string
  enabled: boolean
  state: string
  delayMs?: number
  totalMs?: number
  exitIp?: string
  exitCountry?: string
  lastCheckAt?: number
  missingSince?: number | null
}

interface SubscriptionItem {
  id: string
  name: string
  enabled: boolean
  lastStatus?: string | null
  lastSyncAt?: number | null
  lastError?: string | null
  nodeCount: number
  intervalSec: number
}

interface EventItem {
  id: string
  at: number
  level: string
  kind: string
  message: string
  node_id?: string | null
}

interface RevisionItem {
  id: string
  status: string
  reason: string
  createdAt: number
  appliedAt?: number | null
  nodeCount: number
  added: number
  removed: number
  changed: number
  skipped: number
  error?: string | null
}

export function OverviewPage() {
  const navigate = useNavigate()
  const health = useHealth()

  const nodes = useResource<{ items: NodeItem[]; total: number }>(
    "overview:nodes",
    (signal) => unwrap(eden.api.nodes.get({ query: { limit: 500 }, fetch: { signal } })),
    { pollMs: 20_000 },
  )
  const subscriptions = useResource<{ items: SubscriptionItem[] }>(
    "overview:subscriptions",
    (signal) => unwrap(eden.api.subscriptions.get({ fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const runtime = useResource("overview:runtime", (signal) => unwrap(eden.api.runtime.status.get({ fetch: { signal } })), {
    pollMs: 25_000,
  })
  const revisions = useResource<{ items: RevisionItem[] }>(
    "overview:revisions",
    (signal) => unwrap(eden.api.runtime.revisions.get({ query: { limit: 5 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const gateway = useResource(
    "overview:gateway",
    (signal) => unwrap(eden.api.gateway.connections.get({ fetch: { signal } })),
    { pollMs: 20_000 },
  )
  const events = useResource<{ items: EventItem[] }>(
    "overview:events",
    (signal) => unwrap(eden.api.events.get({ query: { limit: 10 }, fetch: { signal } })),
    { pollMs: 20_000 },
  )
  const jobs = useResource("overview:jobs", (signal) => unwrap(eden.api.jobs.get({ query: { limit: 8 }, fetch: { signal } })), {
    pollMs: 15_000,
  })

  const refreshAll = () => {
    nodes.refresh()
    subscriptions.refresh()
    runtime.refresh()
    revisions.refresh()
    gateway.refresh()
    events.refresh()
    jobs.refresh()
    void refreshHealth(true)
  }

  const syncAll = useJobAction({ label: "同步全部订阅", start: () => startJob(eden.api.subscriptions["sync-all"].post()), onDone: refreshAll })
  const checkAll = useJobAction({
    label: "检测全部节点",
    start: () => startJob(eden.api.nodes["check-batch"].post({ depth: "full" })),
    onDone: refreshAll,
  })
  const publish = useJobAction({
    label: "发布运行配置",
    start: () => startJob(eden.api.runtime.publish.post({ dryRun: false })),
    onDone: refreshAll,
  })
  const reconcile = useJobAction({
    label: "数据面对账",
    start: () => startJob(eden.api.runtime.reconcile.post({ dryRun: false })),
    onDone: refreshAll,
  })
  const jobActions = [syncAll, checkAll, publish, reconcile]
  const activeJob = jobActions.find((action) => action.progress)?.progress

  const nodeItems = (nodes.data?.items ?? []).map((item) => normalizeNode(item))
  const total = nodes.data?.total ?? nodeItems.length
  const counts: Record<string, number> = { up: 0, degraded: 0, down: 0, quarantined: 0, unknown: 0 }
  for (const node of nodeItems) {
    const state = String(node.state ?? "unknown")
    counts[state] = (counts[state] ?? 0) + 1
  }
  const up = counts.up ?? 0
  const healthyPct = total ? Math.round((up / total) * 1000) / 10 : 0
  const upNodes = nodeItems.filter((node) => node.state === "up" && node.delayMs && node.delayMs > 0)
  const avgDelay = upNodes.length ? upNodes.reduce((sum, node) => sum + (node.delayMs ?? 0), 0) / upNodes.length : 0
  const subscriptionItems = subscriptions.data?.items ?? []
  const enabledSubs = subscriptionItems.filter((item) => item.enabled)
  const failingSubs = subscriptionItems.filter((item) => item.lastStatus === "failed" || item.lastStatus === "error")
  const activeConns = gateway.data?.active?.length ?? health?.gateway.activeConns ?? 0
  const updatedAt = Math.max(
    nodes.updatedAt,
    subscriptions.updatedAt,
    runtime.updatedAt,
    revisions.updatedAt,
    gateway.updatedAt,
    events.updatedAt,
    jobs.updatedAt,
  )
  const refreshing = nodes.refreshing || subscriptions.refreshing || runtime.refreshing || events.refreshing
  const latestRevision = revisions.data?.items?.[0]
  const driftCount =
    (runtime.data?.diff.drift?.outboundTags?.length ?? 0) +
    (runtime.data?.diff.drift?.inboundTags?.length ?? 0) +
    (runtime.data?.diff.drift?.ruleTags?.length ?? 0)
  const recentEvents = events.data?.items ?? []
  const runningJobs = (jobs.data?.items ?? []).filter((job) => job.status === "running" || job.status === "queued")
  const finishedJobs = (jobs.data?.items ?? []).filter((job) => job.status !== "running" && job.status !== "queued")

  return (
    <div className="space-y-6">
      <PageHeader
        title="概览"
        description="节点健康、订阅状态、数据面版本与网关负载一屏掌握。"
        updatedAt={updatedAt || undefined}
        onRefresh={refreshAll}
        refreshing={refreshing}
        actions={
          <>
            <LoadingButton variant="outline" size="sm" loading={syncAll.pending} loadingText="同步中…" onClick={() => void syncAll.run()}>
              <Rss data-icon="inline-start" />
              同步全部
            </LoadingButton>
            <LoadingButton variant="outline" size="sm" loading={checkAll.pending} loadingText="检测中…" onClick={() => void checkAll.run()}>
              <Zap data-icon="inline-start" />
              检测全部
            </LoadingButton>
            <LoadingButton variant="outline" size="sm" loading={reconcile.pending} loadingText="对账中…" onClick={() => void reconcile.run()}>
              <ListChecks data-icon="inline-start" />
              对账
            </LoadingButton>
            <LoadingButton size="sm" loading={publish.pending} loadingText="发布中…" onClick={() => void publish.run()}>
              <GitBranch data-icon="inline-start" />
              发布
            </LoadingButton>
          </>
        }
      />

      {activeJob ? <JobProgress job={activeJob} onCancel={() => jobActions.find((action) => action.progress)?.cancel()} /> : null}

      {(syncAll.error || checkAll.error || publish.error || reconcile.error) ? (
        <ErrorState error={syncAll.error ?? checkAll.error ?? publish.error ?? reconcile.error} title="任务提交失败" />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="节点总数"
          value={fmtNumber(total)}
          hint={total ? up + " 个正常 · " + ((counts.degraded ?? 0) + (counts.down ?? 0)) + " 个异常" : "还没有节点"}
          icon={Server}
          loading={nodes.loading && !nodes.data}
          onClick={() => void navigate({ to: "/nodes" })}
        />
        <StatCard
          label="健康率"
          value={healthyPct + "%"}
          hint={up + " / " + total + " 个节点状态为 up"}
          icon={Activity}
          tone={healthyPct >= 90 ? "ok" : healthyPct >= 60 ? "degraded" : "down"}
          loading={nodes.loading && !nodes.data}
        />
        <StatCard
          label="平均延迟"
          value={avgDelay ? fmtMs(avgDelay) : "—"}
          hint={upNodes.length + " 个节点参与统计"}
          icon={Timer}
          tone={!avgDelay ? "idle" : avgDelay < 800 ? "ok" : avgDelay < 2000 ? "degraded" : "down"}
          loading={nodes.loading && !nodes.data}
        />
        <StatCard
          label="网关连接"
          value={fmtNumber(activeConns)}
          hint={health ? health.gateway.listen + (health.gateway.enabled ? "" : " · 未启用") : "等待健康检查"}
          icon={Radio}
          tone={activeConns > 0 ? "info" : "idle"}
          loading={gateway.loading && !gateway.data && !health}
          onClick={() => void navigate({ to: "/gateway" })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="gap-4 xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              数据面健康
            </CardTitle>
            <CardDescription>
              {health ? "Xray " + (health.xray.version || "未知版本") + " · " + health.xray.mode + " 模式" : "自检需要 1–4 秒，正在获取…"}
            </CardDescription>
            <CardAction>
              <StatusBadge state={health ? (health.overall === "ok" ? "up" : "degraded") : "unknown"} pulse={health?.overall === "ok"} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            {!health ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  <Metric label="进程 PID" value={health.xray.pid ?? "未运行"} />
                  <Metric label="API 延迟" value={fmtMs(health.xray.apiLatencyMs)} tone={health.xray.apiLatencyMs > 1500 ? "degraded" : "ok"} />
                  <Metric label="Outbound tag" value={fmtNumber(health.xray.tagCount)} />
                  <Metric label="Rule" value={fmtNumber(health.xray.ruleCount)} />
                  <Metric label="热操作" value={fmtNumber(health.xray.hotOpsTotal)} />
                  <Metric label="待退休" value={fmtNumber(health.xray.pendingRetire)} />
                  <Metric label="运行时长" value={fmtUptime(health.xray.runtimeSec)} />
                  <Metric label="端口" value={health.ports.used + " / " + health.ports.pool} />
                </div>
                <Separator />
                <div className="grid gap-2 sm:grid-cols-2">
                  {health.checks.map((check) => (
                    <div key={check.id} className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
                      <Dot tone={check.level === "ok" ? "ok" : check.level === "degraded" ? "degraded" : "down"} className="mt-1" />
                      <div className="min-w-0">
                        <p className="font-medium">{check.label}</p>
                        <p className="truncate text-muted-foreground" title={check.detail}>
                          {check.detail}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="size-4 text-primary" />
              发布与对账
            </CardTitle>
            <CardDescription>当前 revision 与期望配置的差异</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/runtime" })}>
                详情
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {runtime.loading && !runtime.data ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : runtime.error && !runtime.data ? (
              <ErrorState error={runtime.error} compact onRetry={runtime.refresh} />
            ) : runtime.data ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">当前 revision</span>
                  <span className="font-mono text-sm font-semibold">
                    {runtime.data.revision?.id ? "#" + runtime.data.revision.id : "未发布"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <DiffStat label="新增" value={runtime.data.diff.add.length} tone="ok" />
                  <DiffStat label="变更" value={runtime.data.diff.change.length} tone="degraded" />
                  <DiffStat label="删除" value={runtime.data.diff.remove.length} tone="down" />
                  <DiffStat label="一致" value={runtime.data.diff.keep.length} tone="idle" />
                </div>
                {driftCount > 0 ? (
                  <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    数据面与期望配置存在漂移，建议立即对账。
                  </p>
                ) : null}
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span>期望节点</span>
                    <span className="tabular-nums">{runtime.data.desired.count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>热操作 / 阈值</span>
                    <span className="tabular-nums">
                      {runtime.data.hotOpsTotal} / {runtime.data.hotOpsThreshold}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>待退休 tag</span>
                    <span className="tabular-nums">{runtime.data.pendingRetire.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>端口池</span>
                    <span className="tabular-nums">
                      {runtime.data.ports.used} / {runtime.data.ports.pool}
                    </span>
                  </div>
                </div>
                {latestRevision ? (
                  <>
                    <Separator />
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">最近一次</span>
                        <StatusBadge state={latestRevision.status} />
                      </div>
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span className="font-mono">{latestRevision.id}</span>
                        <RelativeTime ts={latestRevision.createdAt} />
                      </div>
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              节点状态分布
            </CardTitle>
            <CardDescription>按检测状态统计（共 {fmtNumber(total)} 个节点）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {nodes.loading && !nodes.data ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              (
                [
                  ["up", "正常"],
                  ["degraded", "降级"],
                  ["down", "不可用"],
                  ["quarantined", "隔离"],
                  ["unknown", "未检测"],
                ] as const
              ).map(([state, label]) => {
                const count = counts[state] ?? 0
                const percent = total ? Math.round((count / total) * 100) : 0
                return (
                  <div key={state} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2">
                        <Dot tone={stateMeta(state).tone} />
                        {label}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {count} · {percent}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={"h-full rounded-full " + toneBgClass(stateMeta(state).tone)} style={{ width: percent + "%" }} />
                    </div>
                  </div>
                )
              })
            )}
            <Separator />
            <Button variant="outline" size="sm" className="w-full" onClick={() => void navigate({ to: "/nodes" })}>
              查看全部节点
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardContent>
        </Card>

        <Card className="gap-4 xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rss className="size-4 text-primary" />
              订阅状态
            </CardTitle>
            <CardDescription>
              {enabledSubs.length} / {subscriptionItems.length} 个订阅已启用
              {failingSubs.length ? " · " + failingSubs.length + " 个最近同步失败" : ""}
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/subscriptions" })}>
                管理订阅
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {subscriptions.loading && !subscriptions.data ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </div>
            ) : subscriptionItems.length === 0 ? (
              <EmptyState
                icon={Rss}
                title="还没有订阅"
                description="添加第一个订阅源后，节点会自动同步进池。"
                compact
                action={
                  <Button size="sm" onClick={() => void navigate({ to: "/subscriptions" })}>
                    添加订阅
                  </Button>
                }
              />
            ) : (
              <div className="divide-y">
                {subscriptionItems.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <Dot tone={item.enabled ? (item.lastStatus === "ok" ? "ok" : item.lastStatus ? "down" : "idle") : "idle"} />
                    <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                    <Badge variant="secondary" className="font-normal">
                      {item.nodeCount} 节点
                    </Badge>
                    <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">
                      <RelativeTime ts={item.lastSyncAt} />
                    </span>
                    <StatusBadge state={item.enabled ? item.lastStatus ?? "pending" : "disabled"} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="gap-4 xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-4 text-primary" />
              最近事件
            </CardTitle>
            <CardDescription>来自事件总线的最新动态</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/events" })}>
                全部事件
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {events.loading && !events.data ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : recentEvents.length === 0 ? (
              <EmptyState icon={Clock} title="暂无事件" description="同步、检测、发布等操作都会在这里留下记录。" compact />
            ) : (
              <ul className="divide-y">
                {recentEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 py-2.5 text-sm">
                    <Dot tone={eventTone(event.level, "info")} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{event.message}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{event.kind}</span>
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

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleAlert className="size-4 text-primary" />
              任务队列
            </CardTitle>
            <CardDescription>{runningJobs.length ? runningJobs.length + " 个任务进行中" : "当前没有进行中的任务"}</CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.loading && !jobs.data ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : runningJobs.length === 0 && finishedJobs.length === 0 ? (
              <EmptyState icon={ListChecks} title="队列为空" description="长任务会在这里展示进度与结果。" compact />
            ) : (
              <ul className="space-y-2 text-sm">
                {[...runningJobs, ...finishedJobs].slice(0, 6).map((job) => (
                  <li key={job.id} className="rounded-md border px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{job.kind}</span>
                      <StatusBadge state={job.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{job.message || job.id}</span>
                      <RelativeTime ts={job.created_at} />
                    </div>
                    {job.status === "running" && job.total ? (
                      <Progress className="mt-1.5 h-1" value={Math.round(((job.progress ?? 0) / job.total) * 100)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "degraded" }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={"truncate text-sm font-medium tabular-nums " + (tone === "degraded" ? "text-warning" : "")}>{value}</p>
    </div>
  )
}

function DiffStat({ label, value, tone }: { label: string; value: number; tone: "ok" | "degraded" | "down" | "idle" }) {
  return (
    <div className="rounded-md border px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Dot tone={tone} />
        {label}
      </div>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

// I have nothing but my burger and I want nothing more
