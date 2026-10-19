import { useEffect, useRef, useState, type ReactNode } from "react"
import { defineRoute } from "@teyik0/furin"
import { Play, Radar, Server, ShieldAlert, TriangleAlert, Zap } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useConfirm } from "@/components/common/confirm-dialog"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { StatCard } from "@/components/common/stat-card"
import { DetectEventsCard, ErrorDistributionCard, StatusDistributionCard } from "@/components/detect/distributions"
import { DetectJobHistoryCard, DetectPressureCard, RunningDetectJobsCard } from "@/components/detect/job-history"
import { DetectPolicyForm } from "@/components/detect/policy-form"
import {
  DETECT_DEPTHS,
  DETECT_SCOPES,
  type DetectEvent,
  type DetectJob,
  type DetectNode,
  type DetectSettings,
} from "@/components/detect/types"
import { describeError, eden, normalizeNode, startJob, unwrap } from "@/lib/api"
import { useAction, useResource } from "@/lib/hooks"
import { refreshHealth, useHealth } from "@/lib/health"
import { cancelJob } from "@/lib/jobs"
import { subscribeStream } from "@/lib/stream"
import { useJobAction } from "@/lib/use-job"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "检测 · xc-p" }] }))
  .page(() => <DetectPage />)

type Depth = "full" | "lite"
type Scope = "all" | "unknown" | "abnormal"

interface SettingsResponse {
  settings: { detect: DetectSettings }
}

export function DetectPage() {
  const confirm = useConfirm()
  const health = useHealth()

  const settingsRes = useResource<SettingsResponse>("detect:settings", (signal) => unwrap(eden.api.settings.get({ fetch: { signal } })))
  const nodesRes = useResource<{ items: any[]; total: number }>(
    "detect:nodes",
    (signal) => unwrap(eden.api.nodes.get({ query: { limit: 500 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const jobsRes = useResource<{ items: DetectJob[]; total: number }>(
    "detect:jobs",
    (signal) => unwrap(eden.api.jobs.get({ query: { kind: "detect", limit: 20 }, fetch: { signal } })),
    { pollMs: 8_000 },
  )
  const eventsRes = useResource<{ items: DetectEvent[] }>(
    "detect:events",
    (signal) => unwrap(eden.api.events.get({ query: { kind: "node", limit: 50 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )

  const [depth, setDepth] = useState<Depth>("full")
  const [scope, setScope] = useState<Scope>("all")
  const payloadRef = useRef<Record<string, unknown>>({ depth: "full" })
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  const batch = useJobAction({
    label: "批量检测",
    start: () => startJob(eden.api.nodes["check-batch"].post(payloadRef.current)),
    onDone: () => {
      nodesRes.refresh()
      jobsRes.refresh()
      eventsRes.refresh()
    },
    onFail: () => {
      nodesRes.refresh()
      jobsRes.refresh()
    },
  })

  const cancel = useAction(cancelJob)

  const nodes = (nodesRes.data?.items ?? []).map((item) => normalizeNode(item) as unknown as DetectNode)
  const total = nodesRes.data?.total ?? nodes.length
  const jobs = jobsRes.data?.items ?? []
  const events = eventsRes.data?.items ?? []
  const detectSettings = settingsRes.data?.settings?.detect ?? null
  const savedConcurrency = detectSettings?.concurrency ?? 8

  const checkedCount = nodes.filter((node) => !!node.lastCheckAt).length
  const degradedCount = nodes.filter((node) => node.state === "degraded").length
  const downCount = nodes.filter((node) => node.state === "down").length
  const quarantinedCount = nodes.filter((node) => node.state === "quarantined").length
  const abnormalCount = degradedCount + downCount
  const enabledCount = nodes.filter((node) => node.enabled).length
  const upWithDelay = nodes.filter((node) => node.state === "up" && node.delayMs && node.delayMs > 0)
  const averageDelay = upWithDelay.length ? upWithDelay.reduce((sum, node) => sum + (node.delayMs ?? 0), 0) / upWithDelay.length : 0
  const activeConns = health?.gateway.activeConns ?? 0

  function resolveTargets(): string[] | null {
    if (scope === "all") return null
    if (scope === "unknown") return nodes.filter((node) => !node.lastCheckAt || node.state === "unknown").map((node) => node.id)
    return nodes.filter((node) => node.state === "degraded" || node.state === "down" || node.state === "quarantined").map((node) => node.id)
  }

  const targetCount = resolveTargets()?.length ?? nodes.length
  const scopeLabel = DETECT_SCOPES.find((option) => option.value === scope)?.label ?? "全部可检测节点"

  async function runBatch(nextDepth: Depth) {
    const ids = resolveTargets()
    if (ids && ids.length === 0) {
      toast.error("没有符合条件的节点", { description: "换一个检测范围，或先同步订阅把节点写入节点池。" })
      return
    }
    const count = ids ? ids.length : nodes.length
    if (nextDepth === "full") {
      const ok = await confirm({
        title: "开始全量检测？",
        description: "full = S1 网关可达 → S2 经节点真实请求 → S3 出口确认，会为每个节点产生真实请求与 IP 查询流量。",
        details: (
          <div className="space-y-1.5 text-xs">
            <DetailRow label="检测范围" value={scopeLabel} />
            <DetailRow label="目标节点" value={count + " 个"} />
            <DetailRow label="并发上限" value={savedConcurrency + "（settings.detect.concurrency）"} />
            <DetailRow label="预期影响" value="经过数据面的检测流量增加，不影响已发布配置" />
          </div>
        ),
        confirmText: "开始全量检测",
      })
      if (!ok) return
    }
    payloadRef.current = ids ? { depth: nextDepth, nodeIds: ids } : { depth: nextDepth }
    void batch.run().catch((caught) => toast.error("批量检测提交失败", { description: describeError(caught) }))
  }

  function onCancel(job: DetectJob) {
    setCancelingId(job.id)
    void cancel.run(job.id).finally(() => {
      setCancelingId(null)
      setTimeout(() => jobsRes.refresh(), 600)
    })
  }

  const refreshAll = () => {
    settingsRes.refresh()
    nodesRes.refresh()
    jobsRes.refresh()
    eventsRes.refresh()
    void refreshHealth(true)
  }

  useEffect(() => {
    return subscribeStream((message) => {
      const kind = message.kind ?? ""
      if (kind.startsWith("node.")) {
        nodesRes.refresh()
        eventsRes.refresh()
        return
      }
      if (kind === "job.ok" || kind === "job.failed" || kind === "job.cancelled") {
        jobsRes.refresh()
        nodesRes.refresh()
        eventsRes.refresh()
      }
    })
  }, [nodesRes.refresh, eventsRes.refresh, jobsRes.refresh])

  const updatedAt = Math.max(settingsRes.updatedAt, nodesRes.updatedAt, jobsRes.updatedAt, eventsRes.updatedAt)
  const refreshing = settingsRes.refreshing || nodesRes.refreshing || jobsRes.refreshing || eventsRes.refreshing
  const initialLoading = nodesRes.loading && !nodesRes.data

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="检测"
        description="三阶段：S1 网关可达 → S2 经节点真实请求 → S3 出口确认（§8.1）。检测流量经过数据面，并发必须显著低于网关承载能力。"
        updatedAt={updatedAt || undefined}
        onRefresh={refreshAll}
        refreshing={refreshing}
      />

      {batch.progress ? <JobProgress job={batch.progress} onCancel={batch.cancel} /> : null}
      {batch.error ? <ErrorState error={batch.error} title="批量检测提交失败" compact /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="节点总数"
          value={total}
          hint={enabledCount + " 个已启用 · " + (total - enabledCount) + " 个已禁用"}
          icon={Server}
          tone="info"
          loading={initialLoading}
        />
        <StatCard
          label="已检测"
          value={checkedCount}
          hint={nodes.length ? Math.round((checkedCount / Math.max(1, nodes.length)) * 100) + "% 的节点有检测结果" : "等待节点入池"}
          icon={Radar}
          tone={checkedCount ? "ok" : "idle"}
          loading={initialLoading}
        />
        <StatCard
          label="异常节点"
          value={abnormalCount}
          hint={abnormalCount ? "降级 " + degradedCount + " · 不可用 " + downCount : "所有已检测节点状态正常"}
          icon={TriangleAlert}
          tone={abnormalCount ? "down" : "ok"}
          loading={initialLoading}
        />
        <StatCard
          label="隔离节点"
          value={quarantinedCount}
          hint={"连续成功 " + (detectSettings?.recoverAfter ?? 2) + " 次后自动恢复"}
          icon={ShieldAlert}
          tone={quarantinedCount ? "degraded" : "ok"}
          loading={initialLoading}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          {detectSettings ? (
            <DetectPolicyForm
              settings={detectSettings}
              onSaved={() => {
                settingsRes.refresh()
                void refreshHealth(true)
              }}
            />
          ) : settingsRes.error && !settingsRes.data ? (
            <ErrorState error={settingsRes.error} title="加载检测策略失败" onRetry={settingsRes.refresh} />
          ) : (
            <Skeleton className="h-[720px] w-full rounded-xl" />
          )}
        </div>

        <div className="space-y-4">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="size-4 text-primary" />
                批量检测
              </CardTitle>
              <CardDescription>POST /api/nodes/check-batch · 长任务可在进度条取消</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field>
                <FieldLabel>检测深度</FieldLabel>
                <Select value={depth} onValueChange={(value) => setDepth(value as Depth)}>
                  <SelectTrigger className="w-full" aria-label="检测深度">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DETECT_DEPTHS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {depth === "full" ? "三阶段检测会产生真实流量与 IP 查询" : "仅 S1 握手与 S2 探测，速度快、开销小"}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>检测范围</FieldLabel>
                <Select value={scope} onValueChange={(value) => setScope(value as Scope)}>
                  <SelectTrigger className="w-full" aria-label="检测范围">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DETECT_SCOPES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  目标 {targetCount} 个节点{targetCount === 0 ? " · 当前范围为空，请切换范围" : ""}
                </FieldDescription>
              </Field>
              <LoadingButton
                className="w-full"
                loading={batch.pending}
                loadingText="检测中…"
                disabled={targetCount === 0}
                onClick={() => void runBatch(depth)}
              >
                <Play data-icon="inline-start" />
                开始批量检测
              </LoadingButton>
              <p className="text-xs text-muted-foreground">深度与范围在点击时生效；全量检测会先弹确认。</p>
            </CardContent>
          </Card>

          <RunningDetectJobsCard jobs={jobs} loading={jobsRes.loading} cancelingId={cancelingId} onCancel={onCancel} />

          {detectSettings ? (
            <DetectPressureCard
              concurrency={detectSettings.concurrency}
              activeConns={activeConns}
              checked={checkedCount}
              total={total}
              quarantined={quarantinedCount}
              averageDelay={averageDelay}
            />
          ) : (
            <Skeleton className="h-56 w-full rounded-xl" />
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <StatusDistributionCard nodes={nodes} total={total} />
        <ErrorDistributionCard nodes={nodes} jobs={jobs} />
        <DetectEventsCard events={events} loading={eventsRes.loading} error={eventsRes.error} onRetry={eventsRes.refresh} />
      </div>

      <DetectJobHistoryCard
        jobs={jobs}
        loading={jobsRes.loading}
        error={jobsRes.error}
        onRetry={jobsRes.refresh}
        onStartLite={() => void runBatch("lite")}
      />

    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-64 text-right font-medium">{value}</span>
    </div>
  )
}
