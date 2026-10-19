import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { defineRoute } from "@teyik0/furin"
import { useNavigate } from "@teyik0/furin/link"
import { Bell, Filter, ListChecks, RotateCcw, ScrollText, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/common/confirm-dialog"
import { CodeBlock } from "@/components/common/code-block"
import { ErrorState } from "@/components/common/error-state"
import { PageHeader } from "@/components/common/page-header"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { StatCard } from "@/components/common/stat-card"
import {
  ApplyOpsEmpty,
  ApplyOpsTable,
  AuditEmpty,
  AuditLogTable,
  type ApplyOpItem,
  type AuditItem,
} from "@/components/events/audit-table"
import { EventsEmpty, EventsTable, type EventItem } from "@/components/events/events-table"
import { jobKindLabel, JobsTable, type JobItem } from "@/components/events/jobs-table"
import { describeError, eden, unwrap } from "@/lib/api"
import { JOB_STATUS_META, jobStatusMeta, jsonPretty } from "@/lib/format"
import { useAction, useDebounced, useResource } from "@/lib/hooks"
import { subscribeStream, useStreamState } from "@/lib/stream"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "事件与审计 · xc-p" }] }))
  .page(() => <EventsPage />)

type TabKey = "events" | "jobs" | "audit"
type AuditTabKey = "audit" | "ops"

interface JobDetailState {
  id: string
  data: JobItem | null
  loading: boolean
  error: unknown
}

const JOB_KIND_OPTIONS = ["sync", "sync_all", "detect", "publish", "rollback", "reconcile", "restart"]
const JOB_STATUS_OPTIONS = Object.entries(JOB_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))

function toTimestamp(value: string): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

function payloadOf(job: JobItem): unknown {
  const raw = job.payload_json
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function EventsPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const stream = useStreamState()

  const [tab, setTab] = useState<TabKey>("events")
  const [auditTab, setAuditTab] = useState<AuditTabKey>("audit")

  // ---------------- 事件过滤
  const [level, setLevel] = useState("")
  const [kind, setKind] = useState("")
  const [nodeIdInput, setNodeIdInput] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const debouncedNodeId = useDebounced(nodeIdInput, 400)

  const events = useResource<{ items: EventItem[] }>(
    "events:" + level + ":" + kind + ":" + debouncedNodeId + ":" + page + ":" + pageSize,
    (signal) =>
      unwrap(
        eden.api.events.get({
          query: {
            level: level || undefined,
            kind: kind || undefined,
            nodeId: debouncedNodeId || undefined,
            limit: pageSize,
            offset: page * pageSize,
          },
          fetch: { signal },
        }),
      ),
    { pollMs: 15_000 },
  )

  const kinds = useResource<{ items: EventItem[] }>(
    "events:kinds",
    (signal) => unwrap(eden.api.events.get({ query: { limit: 300 }, fetch: { signal } })),
    { pollMs: 60_000 },
  )

  // ---------------- 任务
  const [jobStatus, setJobStatus] = useState("")
  const [jobKind, setJobKind] = useState("")
  const jobs = useResource<{ items: JobItem[]; total?: number }>(
    "jobs:" + jobStatus + ":" + jobKind,
    (signal) =>
      unwrap(
        eden.api.jobs.get({
          query: { status: jobStatus || undefined, kind: jobKind || undefined, limit: 100 },
          fetch: { signal },
        }),
      ),
    { pollMs: 10_000 },
  )

  // ---------------- 审计
  const auditLog = useResource<{ items: AuditItem[] }>(
    "audit:log",
    (signal) => unwrap(eden.api.audit.get({ query: { limit: 200 }, fetch: { signal } })),
    { pollMs: 30_000, enabled: tab === "audit" && auditTab === "audit" },
  )
  const applyOps = useResource<{ items: ApplyOpItem[] }>(
    "audit:ops",
    (signal) => unwrap(eden.api.audit.get({ query: { kind: "xray_apply_ops", limit: 200 }, fetch: { signal } })),
    { pollMs: 30_000, enabled: tab === "audit" && auditTab === "ops" },
  )

  // ---------------- 任务详情 / 取消
  const [detail, setDetail] = useState<JobDetailState | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const cancelAction = useAction(async (id: string) => {
    await unwrap(eden.api.jobs({ id }).cancel.post())
  })

  const loadDetail = async (id: string, initial?: JobItem) => {
    setDetail({ id, data: initial ?? null, loading: true, error: null })
    try {
      const data = await unwrap(eden.api.jobs({ id }).get())
      setDetail({ id, data, loading: false, error: null })
    } catch (error) {
      setDetail({ id, data: null, loading: false, error })
    }
  }

  const onCancel = async (job: JobItem) => {
    const ok = await confirm({
      title: "取消任务？",
      description:
        job.status === "running"
          ? "运行中的任务会在阶段边界检查取消标志后停止；已写入数据面的发布步骤不可撤销。"
          : "排队中的任务会立即取消，不会执行任何数据面操作。",
      details: (
        <ul className="space-y-1">
          <li>
            任务号：<span className="font-mono">{job.id}</span>
          </li>
          <li>
            类型：{jobKindLabel(job.kind)} · 状态：{jobStatusMeta(job.status).label}
          </li>
        </ul>
      ),
      destructive: true,
      confirmText: "取消任务",
    })
    if (!ok) return
    setCancellingId(job.id)
    try {
      await cancelAction.run(job.id)
      toast.success("已请求取消任务", { description: job.id })
      jobs.refresh()
    } catch (error) {
      toast.error("取消失败", { description: describeError(error) })
    } finally {
      setCancellingId(null)
    }
  }

  // ---------------- 实时刷新（节流）
  const refreshRef = useRef({ events: events.refresh, jobs: jobs.refresh, audit: auditLog.refresh, ops: applyOps.refresh })
  refreshRef.current = { events: events.refresh, jobs: jobs.refresh, audit: auditLog.refresh, ops: applyOps.refresh }
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = subscribeStream((message) => {
      if (!message.kind) return
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        refreshRef.current.events()
        refreshRef.current.jobs()
        refreshRef.current.audit()
        refreshRef.current.ops()
      }, 2500)
    })
    return () => {
      off()
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [])

  // ---------------- 派生数据
  const fromTs = toTimestamp(from)
  const toTs = toTimestamp(to)
  const filteredEvents = useMemo(() => {
    const items = events.data?.items ?? []
    if (fromTs === null && toTs === null) return items
    return items.filter((event) => (fromTs === null || event.at >= fromTs) && (toTs === null || event.at <= toTs))
  }, [events.data, fromTs, toTs])

  const kindOptions = useMemo(() => {
    const set = new Set<string>()
    for (const item of kinds.data?.items ?? []) {
      if (item.kind) set.add(item.kind)
    }
    if (kind) set.add(kind)
    return Array.from(set).sort()
  }, [kinds.data, kind])

  const levelCounts = { info: 0, warn: 0, error: 0, ok: 0 }
  for (const event of filteredEvents) {
    const key = event.level === "warning" ? "warn" : event.level === "success" ? "ok" : event.level
    if (key === "info" || key === "warn" || key === "error" || key === "ok") levelCounts[key] += 1
  }
  const jobItems = jobs.data?.items ?? []
  const runningJobs = jobItems.filter((job) => job.status === "running").length
  const queuedJobs = jobItems.filter((job) => job.status === "queued").length
  const failedJobs = jobItems.filter((job) => job.status === "failed").length
  const auditItems = auditLog.data?.items ?? []
  const opsItems = applyOps.data?.items ?? []
  const auditCount = auditLog.data || applyOps.data ? auditItems.length + opsItems.length : null
  const filtersActive = Boolean(level || kind || debouncedNodeId || from || to)
  const hasNextPage = (events.data?.items.length ?? 0) >= pageSize
  const detailPayload = detail?.data ? payloadOf(detail.data) : null

  const clearFilters = () => {
    setLevel("")
    setKind("")
    setNodeIdInput("")
    setFrom("")
    setTo("")
    setPage(0)
  }

  const refreshAll = () => {
    events.refresh()
    jobs.refresh()
    kinds.refresh()
    if (tab === "audit") {
      auditLog.refresh()
      applyOps.refresh()
    }
  }

  const updatedAt = Math.max(events.updatedAt, jobs.updatedAt, auditLog.updatedAt, applyOps.updatedAt)
  const refreshing = events.refreshing || jobs.refreshing || auditLog.refreshing || applyOps.refreshing

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="事件与审计"
        description="事件流记录控制面的每一次状态变化；任务队列展示长任务进度与结果；审计保留操作与每次数据面调用。"
        updatedAt={updatedAt || undefined}
        onRefresh={refreshAll}
        refreshing={refreshing}
        actions={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={stream.connected ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-muted-foreground/40"} />
            {stream.connected ? "实时已连接" : "实时未连接"}
            {stream.lastEventAt ? (
              <span className="hidden sm:inline">
                · 最近 <RelativeTime ts={stream.lastEventAt} />
              </span>
            ) : null}
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="信息事件"
          value={levelCounts.info}
          hint="同步 / 检测 / 发布正常、对账一致"
          icon={Bell}
          tone="info"
          loading={events.loading && !events.data}
        />
        <StatCard
          label="警告事件"
          value={levelCounts.warn}
          hint="隔离、连续失败、对账不一致、待退休积压"
          icon={Filter}
          tone="degraded"
          loading={events.loading && !events.data}
        />
        <StatCard
          label="错误事件"
          value={levelCounts.error}
          hint="发布失败、Xray 崩溃、API 不可达、端口池耗尽"
          icon={ScrollText}
          tone="down"
          loading={events.loading && !events.data}
        />
        <StatCard
          label="任务队列"
          value={runningJobs + " / " + queuedJobs}
          hint={failedJobs ? failedJobs + " 个失败任务待查看（运行 / 排队）" : "运行 / 排队"}
          icon={ListChecks}
          tone={failedJobs ? "down" : runningJobs + queuedJobs > 0 ? "info" : "idle"}
          loading={jobs.loading && !jobs.data}
        />
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <TabsList className="w-full justify-start sm:w-fit">
          <TabsTrigger value="events">
            事件流
            <span className="text-[11px] text-muted-foreground">{filteredEvents.length}</span>
          </TabsTrigger>
          <TabsTrigger value="jobs">
            任务队列
            <span className="text-[11px] text-muted-foreground">{jobItems.length}</span>
          </TabsTrigger>
          <TabsTrigger value="audit">
            审计
            {auditCount !== null ? <span className="text-[11px] text-muted-foreground">{auditCount}</span> : null}
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------------ 事件流 */}
        <TabsContent value="events" className="mt-4 space-y-4">
          <Card className="gap-0 py-0">
            <CardContent className="space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1.5">
                  <Label htmlFor="filter-level" className="text-xs text-muted-foreground">
                    等级
                  </Label>
                  <Select
                    value={level || "all"}
                    onValueChange={(value) => {
                      setLevel(value === "all" ? "" : value)
                      setPage(0)
                    }}
                  >
                    <SelectTrigger id="filter-level" size="sm" className="w-full">
                      <SelectValue placeholder="全部等级" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部等级</SelectItem>
                      <SelectItem value="info">信息</SelectItem>
                      <SelectItem value="warn">警告</SelectItem>
                      <SelectItem value="error">错误</SelectItem>
                      <SelectItem value="ok">成功</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-kind" className="text-xs text-muted-foreground">
                    类型
                  </Label>
                  <Select
                    value={kind || "all"}
                    onValueChange={(value) => {
                      setKind(value === "all" ? "" : value)
                      setPage(0)
                    }}
                  >
                    <SelectTrigger id="filter-kind" size="sm" className="w-full">
                      <SelectValue placeholder="全部类型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部类型</SelectItem>
                      {kindOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-node" className="text-xs text-muted-foreground">
                    节点 ID
                  </Label>
                  <Input
                    id="filter-node"
                    value={nodeIdInput}
                    placeholder="精确匹配，可留空"
                    autoComplete="off"
                    className="h-8 font-mono text-xs"
                    onChange={(event) => {
                      setNodeIdInput(event.target.value)
                      setPage(0)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-from" className="text-xs text-muted-foreground">
                    起始时间
                  </Label>
                  <Input
                    id="filter-from"
                    type="datetime-local"
                    value={from}
                    className="h-8 text-xs"
                    onChange={(event) => {
                      setFrom(event.target.value)
                      setPage(0)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-to" className="text-xs text-muted-foreground">
                    结束时间
                  </Label>
                  <Input
                    id="filter-to"
                    type="datetime-local"
                    value={to}
                    className="h-8 text-xs"
                    onChange={(event) => {
                      setTo(event.target.value)
                      setPage(0)
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={clearFilters} disabled={!filtersActive}>
                  <RotateCcw data-icon="inline-start" />
                  清除筛选
                </Button>
                <Button variant="ghost" size="sm" onClick={events.refresh} disabled={events.refreshing}>
                  {events.refreshing ? "刷新中…" : "刷新事件"}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  等级 / 类型 / 节点由服务端过滤；时间范围在已加载的本页数据内过滤，需要更早记录请翻页。
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              第 {page + 1} 页 · 当前显示 {filteredEvents.length} 条
              {from || to ? "（已按时间范围过滤）" : ""}
            </p>
            <div className="flex items-center gap-2">
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value))
                  setPage(0)
                }}
              >
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">每页 50 条</SelectItem>
                  <SelectItem value="100">每页 100 条</SelectItem>
                  <SelectItem value="200">每页 200 条</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" disabled={page === 0 || events.refreshing} onClick={() => setPage((prev) => Math.max(0, prev - 1))}>
                上一页
              </Button>
              <Button variant="outline" size="sm" disabled={!hasNextPage || events.refreshing} onClick={() => setPage((prev) => prev + 1)}>
                下一页
              </Button>
            </div>
          </div>

          {events.error ? (
            <ErrorState
              error={events.error}
              title={events.data ? "刷新失败，展示的是上次数据" : "事件加载失败"}
              compact={!!events.data}
              onRetry={events.refresh}
            />
          ) : null}

          {events.data || !events.error ? (
            <EventsTable
              items={filteredEvents}
              loading={events.loading}
              empty={<EventsEmpty filtered={filtersActive} onClear={clearFilters} />}
            />
          ) : null}
        </TabsContent>

        {/* ------------------------------------------------------------ 任务队列 */}
        <TabsContent value="jobs" className="mt-4 space-y-4">
          <Card className="gap-0 py-0">
            <CardContent className="flex flex-wrap items-end gap-3 p-4">
              <div className="w-full space-y-1.5 sm:w-40">
                <Label htmlFor="job-status" className="text-xs text-muted-foreground">
                  状态
                </Label>
                <Select value={jobStatus || "all"} onValueChange={(value) => setJobStatus(value === "all" ? "" : value)}>
                  <SelectTrigger id="job-status" size="sm" className="w-full">
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    {JOB_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-full space-y-1.5 sm:w-44">
                <Label htmlFor="job-kind" className="text-xs text-muted-foreground">
                  类型
                </Label>
                <Select value={jobKind || "all"} onValueChange={(value) => setJobKind(value === "all" ? "" : value)}>
                  <SelectTrigger id="job-kind" size="sm" className="w-full">
                    <SelectValue placeholder="全部类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部类型</SelectItem>
                    {JOB_KIND_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {jobKindLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" size="sm" onClick={jobs.refresh} disabled={jobs.refreshing}>
                {jobs.refreshing ? "刷新中…" : "刷新任务"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                共 {jobs.data?.total ?? jobItems.length} 条 · 进行中 {runningJobs} · 排队 {queuedJobs}
                {failedJobs ? " · 失败 " + failedJobs : ""}
              </span>
            </CardContent>
          </Card>

          {jobStatus || jobKind ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                已过滤：{jobStatus ? jobStatusMeta(jobStatus).label : "全部状态"} · {jobKind ? jobKindLabel(jobKind) : "全部类型"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setJobStatus("")
                  setJobKind("")
                }}
              >
                清除
              </Button>
            </div>
          ) : null}

          {jobs.error ? (
            <ErrorState
              error={jobs.error}
              title={jobs.data ? "刷新失败，展示的是上次数据" : "任务加载失败"}
              compact={!!jobs.data}
              onRetry={jobs.refresh}
            />
          ) : null}

          {jobs.data || !jobs.error ? (
            <JobsTable
              items={jobItems}
              loading={jobs.loading}
              cancellingId={cancellingId}
              onDetail={(job) => void loadDetail(job.id, job)}
              onCancel={(job) => void onCancel(job)}
              onGoRuntime={() => void navigate({ to: "/runtime" })}
            />
          ) : null}
        </TabsContent>

        {/* ------------------------------------------------------------ 审计 */}
        <TabsContent value="audit" className="mt-4 space-y-4">
          <Tabs value={auditTab} onValueChange={(value) => setAuditTab(value as AuditTabKey)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="audit">
                  <ScrollText className="size-3.5" />
                  操作审计
                </TabsTrigger>
                <TabsTrigger value="ops">
                  <Terminal className="size-3.5" />
                  数据面调用
                </TabsTrigger>
              </TabsList>
              <Button
                variant="outline"
                size="sm"
                onClick={() => (auditTab === "audit" ? auditLog.refresh() : applyOps.refresh())}
                disabled={auditTab === "audit" ? auditLog.refreshing : applyOps.refreshing}
              >
                {auditTab === "audit" ? (auditLog.refreshing ? "刷新中…" : "刷新审计") : applyOps.refreshing ? "刷新中…" : "刷新调用记录"}
              </Button>
            </div>

            <TabsContent value="audit" className="mt-4 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                audit_log 记录控制面的关键操作（登录、发布、回滚、重启、网关踢线……），用于事后追责与变更核对。
              </p>
              {auditLog.error && !auditLog.data ? (
                <ErrorState error={auditLog.error} title="审计加载失败" onRetry={auditLog.refresh} />
              ) : (
                <AuditLogTable
                  items={auditItems}
                  loading={auditLog.loading}
                  empty={<AuditEmpty description="登录、发布、回滚、重启等关键操作都会写入审计；执行一次操作后即可看到。" />}
                />
              )}
            </TabsContent>

            <TabsContent value="ops" className="mt-4 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                每次数据面调用（ado / rmo / adi / rmi / adrules / rmrules / replay）一条记录，既是审计也是热操作累计次数的来源。
              </p>
              {applyOps.error && !applyOps.data ? (
                <ErrorState error={applyOps.error} title="数据面调用记录加载失败" onRetry={applyOps.refresh} />
              ) : (
                <ApplyOpsTable items={opsItems} loading={applyOps.loading} empty={<ApplyOpsEmpty />} />
              )}
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      <Dialog open={!!detail} onOpenChange={(open) => (!open ? setDetail(null) : undefined)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>任务详情</DialogTitle>
            <DialogDescription className="font-mono text-xs">{detail?.id}</DialogDescription>
          </DialogHeader>

          {detail?.loading && !detail.data ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-6 w-full" />
              ))}
            </div>
          ) : detail?.error ? (
            <ErrorState error={detail.error} title="任务详情加载失败" onRetry={() => (detail ? void loadDetail(detail.id) : undefined)} />
          ) : detail?.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                <DetailField label="类型" value={jobKindLabel(detail.data.kind)} />
                <DetailField
                  label="状态"
                  value={
                    <StatusBadge
                      state={detail.data.status}
                      label={jobStatusMeta(detail.data.status).label}
                      tone={jobStatusMeta(detail.data.status).tone}
                    />
                  }
                />
                <DetailField
                  label="进度"
                  value={
                    detail.data.total
                      ? (detail.data.progress ?? 0) + " / " + detail.data.total
                      : detail.data.status === "ok"
                        ? "已完成"
                        : detail.data.status === "queued"
                          ? "排队中"
                          : detail.data.status === "running"
                            ? "进行中"
                            : "—"
                  }
                />
                <DetailField label="创建者" value={detail.data.created_by || "—"} />
                <DetailField label="开始" value={detail.data.started_at ? <TimeText ts={detail.data.started_at} /> : "—"} />
                <DetailField label="结束" value={detail.data.finished_at ? <TimeText ts={detail.data.finished_at} /> : "—"} />
              </div>

              {detail.data.message ? (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs break-all">{detail.data.message}</p>
              ) : null}

              {detail.data.error ? (
                <Alert variant="destructive">
                  <AlertTitle>任务失败</AlertTitle>
                  <AlertDescription className="break-all text-xs">{detail.data.error}</AlertDescription>
                </Alert>
              ) : null}

              {detail.data.result !== undefined && detail.data.result !== null ? (
                <CodeBlock code={jsonPretty(detail.data.result)} title="result.json" language="json" maxHeight={280} />
              ) : !detail.data.error ? (
                <p className="text-xs text-muted-foreground">任务尚未产生结果（排队或进行中）。</p>
              ) : null}

              {detailPayload !== null ? (
                <CodeBlock code={jsonPretty(detailPayload)} title="payload.json" maxHeight={160} />
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="truncate font-medium">{value}</div>
    </div>
  )
}
