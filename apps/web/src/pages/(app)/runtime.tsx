import { useRef, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import {
  Activity,
  AlertTriangle,
  Clock,
  Database,
  Eye,
  GitBranch,
  Layers,
  ListChecks,
  Power,
  ServerCog,
  Upload,
  Wrench,
  Zap,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useConfirm } from "@/components/common/confirm-dialog"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { RelativeTime } from "@/components/common/relative-time"
import { InfoGrid, SectionCard } from "@/components/common/section-card"
import { StatCard } from "@/components/common/stat-card"
import { StatusBadge } from "@/components/common/status-badge"
import { DiffView, type DiffColumn } from "@/components/runtime/diff-view"
import { NodeRebuild } from "@/components/runtime/node-rebuild"
import { PublishPreviewCard, type PublishPreviewResult } from "@/components/runtime/publish-preview"
import { RetireQueue, type RetireItem } from "@/components/runtime/retire-queue"
import { RevisionTable, revisionMeta, type RevisionItem } from "@/components/runtime/revision-table"
import {
  HotOpsMeter,
  PortWaterline,
  SchedulerList,
  type PortsStat,
  type SchedulerTask,
} from "@/components/runtime/status-cards"
import { eden, startJob, unwrap } from "@/lib/api"
import { fmtNumber } from "@/lib/format"
import { useAction, useResource } from "@/lib/hooks"
import { refreshHealth, useHealth } from "@/lib/health"
import { useJobAction } from "@/lib/use-job"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "运行配置 · xc-p" }] }))
  .page(() => <RuntimePage />)

interface RuntimeDataplane {
  outbounds?: string[] | number
  inbounds?: { tag: string; port?: number }[] | number
  ruleCount?: number
  rulesSupported?: boolean
  digest?: string
  at?: number
}

interface RuntimeDrift {
  outboundTags?: string[]
  inboundTags?: string[]
  ruleTags?: string[]
}

interface RuntimeRevisionInfo {
  id: string
  status: string
  reason?: string
  createdAt?: number
  appliedAt?: number | null
  nodeCount?: number
  digest?: string
}

interface RuntimeStatus {
  // 后端 currentStatus().revision 是对象（含 id/status/reason/createdAt/digest），不是字符串。
  revision: RuntimeRevisionInfo | null
  dataplane: RuntimeDataplane
  desired: { count: number }
  diff: {
    add: string[]
    change: string[]
    remove: string[]
    keep: string[]
    drift?: RuntimeDrift | boolean | null
  }
  pendingRetire: RetireItem[]
  hotOpsTotal: number
  hotOpsThreshold: number
  ports: PortsStat
  lastRevision: { id: string; status: string; error?: string | null } | null
  scheduler: SchedulerTask[]
}

const PUBLISH_STEPS = ["ado 新增 outbound", "adi 新增 inbound", "adrules --append 追加规则", "网关路由表原子替换", "对账校验"]

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (typeof value === "number" && Number.isFinite(value)) return value
  return 0
}

function driftTags(drift: RuntimeStatus["diff"]["drift"]): string[] {
  if (!drift || typeof drift !== "object") return []
  const outbound = Array.isArray(drift.outboundTags) ? drift.outboundTags : []
  const inbound = Array.isArray(drift.inboundTags) ? drift.inboundTags : []
  const rules = Array.isArray(drift.ruleTags) ? drift.ruleTags : []
  return [...outbound, ...inbound, ...rules]
}

function CardTitle({ icon: Icon, children }: { icon: typeof Activity; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-primary" />
      {children}
    </span>
  )
}

export function RuntimePage() {
  const confirm = useConfirm()
  const health = useHealth()

  const status = useResource<RuntimeStatus>(
    "runtime:status",
    (signal) => unwrap(eden.api.runtime.status.get({ fetch: { signal } })),
    { pollMs: 12_000 },
  )
  const revisions = useResource<{ items: RevisionItem[] }>(
    "runtime:revisions",
    (signal) => unwrap(eden.api.runtime.revisions.get({ query: { limit: 20 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )

  const refreshAll = () => {
    status.refresh()
    revisions.refresh()
    void refreshHealth(true)
  }

  const [preview, setPreview] = useState<PublishPreviewResult | null>(null)
  const [rollingBackId, setRollingBackId] = useState<string | null>(null)
  const [rebuildingNodeId, setRebuildingNodeId] = useState<string | null>(null)
  const rollbackTarget = useRef<string | null>(null)
  const rebuildTarget = useRef<string | null>(null)

  const publishDry = useJobAction({
    label: "发布预演",
    start: () => startJob(eden.api.runtime.publish.post({ dryRun: true })),
    onDone: (outcome) => {
      void resolvePreview(outcome.result)
      refreshAll()
    },
    onFail: () => refreshAll(),
  })

  const resolvePreview = async (result: unknown) => {
    if (result && typeof result === "object") {
      setPreview(result as PublishPreviewResult)
      return
    }
    try {
      const jobs = await unwrap(eden.api.jobs.get({ query: { kind: "publish", limit: 1 } }))
      const latest = jobs.items?.[0]?.result
      setPreview(latest && typeof latest === "object" ? latest : null)
    } catch {
      setPreview(null)
    }
  }

  const publish = useJobAction({
    label: "发布运行配置",
    start: () => startJob(eden.api.runtime.publish.post({ dryRun: false })),
    onDone: () => {
      setPreview(null)
      refreshAll()
    },
    onFail: () => refreshAll(),
  })

  const reconcile = useJobAction({
    label: "对账并修复",
    start: () => startJob(eden.api.runtime.reconcile.post({ dryRun: false })),
    onDone: () => refreshAll(),
    onFail: () => refreshAll(),
  })

  const reconcileDry = useJobAction({
    label: "对账预演",
    start: () => startJob(eden.api.runtime.reconcile.post({ dryRun: true })),
    onDone: () => refreshAll(),
    onFail: () => refreshAll(),
  })

  const restart = useJobAction({
    label: "重启数据面",
    start: () => startJob(eden.api.runtime.restart.post()),
    onDone: () => refreshAll(),
    onFail: () => refreshAll(),
  })

  const rollback = useJobAction({
    label: "回滚 revision",
    start: () => startJob(eden.api.runtime.rollback.post({ revisionId: rollbackTarget.current ?? "" })),
    onDone: () => {
      rollbackTarget.current = null
      setRollingBackId(null)
      refreshAll()
    },
    onFail: () => {
      rollbackTarget.current = null
      setRollingBackId(null)
      refreshAll()
    },
  })

  const rebuild = useJobAction({
    label: "重建节点",
    start: () => startJob(eden.api.runtime.node({ id: rebuildTarget.current ?? "" }).rebuild.post()),
    onDone: () => {
      rebuildTarget.current = null
      setRebuildingNodeId(null)
      refreshAll()
    },
    onFail: () => {
      rebuildTarget.current = null
      setRebuildingNodeId(null)
      refreshAll()
    },
  })

  const readConns = useAction(async () => {
    try {
      const connections = await unwrap(eden.api.gateway.connections.get())
      return connections.active?.length ?? 0
    } catch {
      return health?.gateway.activeConns ?? 0
    }
  })

  const onPublish = async () => {
    const diff = status.data?.diff
    const ok = await confirm({
      title: "发布到数据面？",
      description: "按 ApplyPlan 只处理新增、变更与移除；一致（keep）的节点完全不动，已建立连接不受影响。",
      details: (
        <div className="space-y-2">
          <p>
            新增 <span className="font-semibold text-success">{diff?.add.length ?? 0}</span> · 变更{" "}
            <span className="font-semibold text-warning">{diff?.change.length ?? 0}</span> · 移除{" "}
            <span className="font-semibold text-destructive">{diff?.remove.length ?? 0}</span> · 一致{" "}
            <span className="font-semibold">{diff?.keep.length ?? 0}</span>
          </p>
          <p className="text-muted-foreground">执行顺序：{PUBLISH_STEPS.join(" → ")}。</p>
        </div>
      ),
      confirmText: "发布",
    })
    if (ok) void publish.run()
  }

  const onReconcile = async () => {
    const diff = status.data?.diff
    const ok = await confirm({
      title: "对账并修复数据面？",
      description: "只补齐差异：新增缺失节点、移除多余节点、重建变更节点；一致的节点不触碰。",
      details: (
        <p>
          新增 {diff?.add.length ?? 0} · 变更 {diff?.change.length ?? 0} · 移除 {diff?.remove.length ?? 0} · 一致{" "}
          {diff?.keep.length ?? 0}
        </p>
      ),
      confirmText: "开始对账",
    })
    if (ok) void reconcile.run()
  }

  const onRestart = async () => {
    // readConns 内部已兜底：读取失败时返回健康快照里的连接数。
    const conns = await readConns.run()
    const ok = await confirm({
      title: "重启数据面？",
      description: "立即重启 Xray 并重放当前 revision 的期望状态。这是唯一会断开已建立连接的场景。",
      details: (
        <ul className="space-y-1">
          <li>
            将断开 <span className="font-semibold text-destructive">{conns}</span> 条已建立连接（立即全部断开）
          </li>
          <li>恢复方式：重渲染启动配置 → 重启进程 → 重放期望状态</li>
          <li>客户端影响：需要重新建立连接，通常 1 分钟内恢复</li>
          <li className="text-muted-foreground">建议时机：维护窗口内，或热操作计数接近阈值时</li>
        </ul>
      ),
      destructive: true,
      requireText: "RESTART",
      confirmText: "重启数据面",
    })
    if (ok) void restart.run()
  }

  const onRollback = async (revision: RevisionItem) => {
    const ok = await confirm({
      title: "回滚到该 revision？",
      description: "把该 revision 的目标状态当作期望状态，走同一套 ApplyPlan，只改有差异的部分（不重新拉订阅）。",
      details: (
        <ul className="space-y-1">
          <li>
            目标 revision：<span className="font-mono">{revision.id}</span>
          </li>
          <li>
            节点数 {revision.nodeCount} · 增 {revision.added} / 删 {revision.removed} / 改 {revision.changed}
          </li>
          <li>
            当前生效 revision：<span className="font-mono">{status.data?.revision?.id ?? "未发布"}</span>
          </li>
        </ul>
      ),
      confirmText: "回滚",
    })
    if (!ok) return
    rollbackTarget.current = revision.id
    setRollingBackId(revision.id)
    void rollback.run()
  }

  const onRebuildNode = (nodeId: string) => {
    const value = nodeId.trim()
    if (!value) return
    rebuildTarget.current = value
    setRebuildingNodeId(value)
    void rebuild.run()
  }

  const data = status.data
  const dp = data?.dataplane
  const diff = data?.diff
  const drift = driftTags(diff?.drift)
  const currentRevisionInfo = data?.revision ?? null
  const currentRevision = currentRevisionInfo?.id ?? null
  const lastRevision = data?.lastRevision ?? null
  const lastMeta = revisionMeta(lastRevision?.status ?? null)
  const outboundCount = countOf(dp?.outbounds)
  const inboundCount = countOf(dp?.inbounds)
  const hot = data?.hotOpsTotal ?? 0
  const threshold = data?.hotOpsThreshold ?? 0
  const hotPercent = threshold > 0 ? Math.min(100, Math.round((hot / threshold) * 100)) : 0
  const ports = data?.ports ?? { pool: 0, used: 0, cooling: 0 }
  const portsExhausted = ports.pool > 0 && ports.used + ports.cooling >= ports.pool
  const retireItems = data?.pendingRetire ?? []
  const revisionItems = revisions.data?.items ?? []
  const rebuildSuggestions = (revisionItems.find((item) => (item.nodes?.length ?? 0) > 0)?.nodes ?? [])
    .map((node) => node.node_id)
    .filter(Boolean)

  const diffColumns: DiffColumn[] = [
    { key: "add", title: "新增", hint: "发布时 ado + adi + adrules --append", tone: "ok", items: diff?.add ?? [] },
    { key: "change", title: "变更（需重建）", hint: "change 走 remove + add，期间连接会重建", tone: "degraded", items: diff?.change ?? [] },
    { key: "remove", title: "移除", hint: "网关先摘路由，再 rmrules → rmi → 延迟 rmo", tone: "down", items: diff?.remove ?? [] },
    { key: "keep", title: "一致（不触碰）", hint: "keep 不在 ApplyPlan 里，连接不受影响", tone: "idle", items: diff?.keep ?? [] },
  ]

  const statusLoading = status.loading && !status.data
  const jobError =
    publishDry.error ?? publish.error ?? reconcile.error ?? reconcileDry.error ?? restart.error ?? rollback.error ?? rebuild.error ?? readConns.error
  const hasProgress = Boolean(
    publishDry.progress ?? publish.progress ?? reconcile.progress ?? reconcileDry.progress ?? restart.progress ?? rollback.progress ?? rebuild.progress,
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="运行配置"
        description="数据面的权威状态永远是数据库里的期望状态。发布/对账/回滚都走同一套 ApplyPlan，只处理差异；重启是唯一会断开连接的场景。"
        updatedAt={Math.max(status.updatedAt, revisions.updatedAt) || undefined}
        onRefresh={refreshAll}
        refreshing={status.refreshing || revisions.refreshing}
        actions={
          <>
            <LoadingButton variant="outline" size="sm" loading={publishDry.pending} loadingText="预演中…" onClick={() => void publishDry.run()}>
              <Eye data-icon="inline-start" />
              预演 diff
            </LoadingButton>
            <LoadingButton size="sm" loading={publish.pending} loadingText="发布中…" onClick={() => void onPublish()}>
              <Upload data-icon="inline-start" />
              正式发布
            </LoadingButton>
            <LoadingButton variant="outline" size="sm" loading={reconcile.pending} loadingText="对账中…" onClick={() => void onReconcile()}>
              <ListChecks data-icon="inline-start" />
              对账
            </LoadingButton>
            <LoadingButton
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              loading={restart.pending || readConns.pending}
              loadingText={restart.pending ? "重启中…" : "读取连接数…"}
              onClick={() => void onRestart()}
            >
              <Power data-icon="inline-start" />
              重启数据面
            </LoadingButton>
          </>
        }
      />

      {hasProgress ? (
        <div className="space-y-2">
          {publishDry.progress ? <JobProgress job={publishDry.progress} onCancel={publishDry.cancel} /> : null}
          {publish.progress ? <JobProgress job={publish.progress} onCancel={publish.cancel} /> : null}
          {reconcile.progress ? <JobProgress job={reconcile.progress} onCancel={reconcile.cancel} /> : null}
          {reconcileDry.progress ? <JobProgress job={reconcileDry.progress} onCancel={reconcileDry.cancel} /> : null}
          {restart.progress ? <JobProgress job={restart.progress} onCancel={restart.cancel} /> : null}
          {rollback.progress ? <JobProgress job={rollback.progress} onCancel={rollback.cancel} /> : null}
          {rebuild.progress ? <JobProgress job={rebuild.progress} onCancel={rebuild.cancel} /> : null}
        </div>
      ) : null}

      {jobError ? <ErrorState error={jobError} title="任务提交失败" /> : null}

      {preview ? (
        <PublishPreviewCard
          preview={preview}
          publishing={publish.pending}
          onPublish={() => void onPublish()}
          onClear={() => setPreview(null)}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="当前 revision"
          value={
            currentRevision ? (
              <span className="font-mono text-lg" title={currentRevision}>
                {currentRevision}
              </span>
            ) : (
              <span className="text-lg">未发布</span>
            )
          }
          hint={lastRevision ? "最近一次：" + lastMeta.label + (lastRevision.error ? " · 有错误" : "") : "还没有发布记录"}
          icon={GitBranch}
          tone={lastRevision ? lastMeta.tone : "idle"}
          loading={statusLoading}
        />
        <StatCard
          label="期望节点"
          value={fmtNumber(data?.desired.count ?? 0)}
          hint={"数据面 outbound " + fmtNumber(outboundCount) + " · 一致 " + fmtNumber(diff?.keep.length ?? 0)}
          icon={Layers}
          tone="info"
          loading={statusLoading}
        />
        <StatCard
          label="热操作 / 阈值"
          value={
            <span>
              {fmtNumber(hot)}
              <span className="text-base font-normal text-muted-foreground"> / {fmtNumber(threshold)}</span>
            </span>
          }
          hint={hotPercent >= 100 ? "已超阈值，建议维护窗口重启" : "已用 " + hotPercent + "%"}
          icon={Zap}
          tone={hotPercent >= 100 ? "down" : hotPercent >= 80 ? "degraded" : "ok"}
          loading={statusLoading}
        />
        <StatCard
          label="端口池"
          value={
            <span>
              {fmtNumber(ports.used)}
              <span className="text-base font-normal text-muted-foreground"> / {fmtNumber(ports.pool)}</span>
            </span>
          }
          hint={"冷却 " + fmtNumber(ports.cooling) + (ports.start !== undefined && ports.end !== undefined ? " · " + ports.start + "–" + ports.end : "")}
          icon={Database}
          tone={portsExhausted ? "down" : "ok"}
          loading={statusLoading}
        />
        <StatCard
          label="待退休 tag"
          value={fmtNumber(retireItems.length)}
          hint={retireItems.length ? "延迟删除窗口内，连接可继续收尾" : "没有等待退休的 tag"}
          icon={Clock}
          tone={retireItems.length ? "degraded" : "idle"}
          loading={statusLoading}
        />
      </div>

      <SectionCard
        title={
          <CardTitle icon={Activity}>
            数据面状态（实际）
            {data?.lastRevision ? <StatusBadge state={data.lastRevision.status} label={lastMeta.label} tone={lastMeta.tone} className="ml-1" /> : null}
          </CardTitle>
        }
        description="来自 Xray API 的实时快照；对账就是拿它与期望状态做差集。"
        actions={
          dp?.digest ? (
            <Badge variant="outline" className="max-w-64 truncate font-mono text-[11px] font-normal" title={dp.digest}>
              digest {dp.digest.slice(0, 12)}…
            </Badge>
          ) : null
        }
      >
        {statusLoading ? (
          <div className="space-y-3">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : status.error && !status.data ? (
          <ErrorState error={status.error} compact onRetry={status.refresh} />
        ) : data ? (
          <div className="space-y-4">
            <InfoGrid
              columns={4}
              items={[
                { label: "Outbound", value: fmtNumber(outboundCount), hint: Array.isArray(dp?.outbounds) ? "数据面实际枚举" : "来自数据面快照" },
                { label: "Inbound", value: fmtNumber(inboundCount), hint: "环回入站（每节点一个）" },
                {
                  label: "Rule",
                  value: dp?.rulesSupported === false ? "不支持枚举" : fmtNumber(dp?.ruleCount ?? 0),
                  hint: dp?.rulesSupported === false ? "当前 Xray 构建不支持枚举规则" : "每节点一条路由规则",
                },
                { label: "快照时间", value: dp?.at ? <RelativeTime ts={dp.at} /> : "—", hint: "对账读取的时点" },
              ]}
            />
            {Array.isArray(dp?.outbounds) && dp.outbounds.length > 0 ? (
              <>
                <Separator />
                <div className="flex flex-wrap gap-1.5">
                  {dp.outbounds.slice(0, 16).map((tag) => (
                    <Badge key={tag} variant="secondary" className="font-mono text-[11px] font-normal">
                      {tag}
                    </Badge>
                  ))}
                  {dp.outbounds.length > 16 ? (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      +{dp.outbounds.length - 16}
                    </Badge>
                  ) : null}
                </div>
              </>
            ) : null}
            {drift.length > 0 ? (
              <Alert className="border-warning/40 bg-warning/10 py-3 text-warning">
                <AlertTriangle />
                <AlertTitle>数据面存在 {drift.length} 个漂移 tag</AlertTitle>
                <AlertDescription className="text-warning/90">
                  <span className="break-all font-mono text-[11px]">{drift.slice(0, 12).join("、")}</span>
                  {drift.length > 12 ? " 等" : ""}。它们不在期望状态里，也不在已应用记录中，建议对账清理。
                </AlertDescription>
              </Alert>
            ) : null}
            {lastRevision?.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
                最近一次发布失败：{lastRevision.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title={<CardTitle icon={Layers}>期望 vs 实际（ApplyPlan）</CardTitle>}
        description="只对新增 / 变更 / 移除动手；一致（keep）完全不在计划里，既有连接不受影响。"
        actions={
          <>
            <LoadingButton variant="outline" size="sm" loading={reconcileDry.pending} loadingText="对账中…" onClick={() => void reconcileDry.run()}>
              对账预演
            </LoadingButton>
            <LoadingButton variant="outline" size="sm" loading={reconcile.pending} loadingText="对账中…" onClick={() => void onReconcile()}>
              <Wrench data-icon="inline-start" />
              对账并修复
            </LoadingButton>
          </>
        }
      >
        {status.error && !status.data ? (
          <ErrorState error={status.error} compact onRetry={status.refresh} />
        ) : (
          <div className="space-y-3">
            <DiffView columns={diffColumns} loading={statusLoading} />
            <p className="text-[11px] text-muted-foreground">
              期望 {fmtNumber(data?.desired.count ?? 0)} 个节点 · 数据面 outbound {fmtNumber(outboundCount)} 个 · 差异{" "}
              {(diff?.add.length ?? 0) + (diff?.change.length ?? 0) + (diff?.remove.length ?? 0)} 项
              {drift.length ? " · 漂移 " + drift.length + " 项" : ""}
            </p>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard
          title={<CardTitle icon={Database}>端口池水位</CardTitle>}
          description={
            ports.start !== undefined && ports.end !== undefined
              ? ports.start + "–" + ports.end + "：分配取最小可用端口，删除后先冷却以规避 TIME_WAIT"
              : "分配取最小可用端口，删除后先冷却以规避 TIME_WAIT"
          }
        >
          {statusLoading ? <Skeleton className="h-28 w-full" /> : <PortWaterline ports={ports} />}
        </SectionCard>
        <SectionCard title={<CardTitle icon={Zap}>热操作与维护窗口</CardTitle>} description="ado/rmo 累计次数；超过阈值需重启数据面并重放">
          {statusLoading ? <Skeleton className="h-28 w-full" /> : <HotOpsMeter hot={hot} threshold={threshold} />}
        </SectionCard>
        <SectionCard title={<CardTitle icon={ServerCog}>调度器</CardTitle>} description="控制面定时任务（scheduler.list）">
          {statusLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <SchedulerList tasks={data?.scheduler ?? []} />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title={<CardTitle icon={Clock}>待退休 tag 队列</CardTitle>}
        description="延迟删除旧 tag，给在途连接收尾窗口；到期后自动执行 rmo。"
        actions={retireItems.length ? <Badge variant="outline" className="font-normal text-warning">{retireItems.length} 个</Badge> : null}
      >
        <RetireQueue items={retireItems} loading={statusLoading} />
      </SectionCard>

      <SectionCard
        title={<CardTitle icon={GitBranch}>revision 历史</CardTitle>}
        description="回滚不重新拉订阅：把历史 revision 的目标状态当作期望状态，走同一套 ApplyPlan。"
        actions={
          <>
            <Badge variant="outline" className="font-normal">
              {revisionItems.length} 条
            </Badge>
            <LoadingButton variant="ghost" size="sm" loading={revisions.refreshing} loadingText="刷新中…" onClick={revisions.refresh}>
              刷新
            </LoadingButton>
          </>
        }
      >
        {revisions.error && !revisions.data ? (
          <ErrorState error={revisions.error} compact onRetry={revisions.refresh} />
        ) : (
          <RevisionTable
            revisions={revisionItems}
            loading={revisions.loading && !revisions.data}
            currentRevision={currentRevision}
            rollingBackId={rollingBackId}
            onRollback={onRollback}
            onRebuildNode={onRebuildNode}
            rebuildingNodeId={rebuildingNodeId}
          />
        )}
      </SectionCard>

      <SectionCard
        title={<CardTitle icon={Wrench}>节点重建</CardTitle>}
        description="把单个节点的 outbound 重新下发到数据面，用于修复数据面缺失节点；只影响该节点。"
      >
        <NodeRebuild suggestions={rebuildSuggestions} rebuilding={rebuild.pending} onRebuild={onRebuildNode} />
      </SectionCard>
    </div>
  )
}
