import { useRef, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import {
  CheckCircle2,
  Eye,
  FlaskConical,
  History,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/common/confirm-dialog"
import { DataTable, type DataTableColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { RelativeTime } from "@/components/common/relative-time"
import { StatCard } from "@/components/common/stat-card"
import { StatusBadge } from "@/components/common/status-badge"
import { SubscriptionEditorDialog } from "@/components/subscriptions/editor-dialog"
import { maskUrl, formatInterval, subStatusMeta } from "@/components/subscriptions/format"
import { ParsePreviewDialog } from "@/components/subscriptions/preview-dialog"
import { SubscriptionRunsSheet } from "@/components/subscriptions/runs-sheet"
import type { SubscriptionItem } from "@/components/subscriptions/types"
import { describeError, eden, startJob, unwrap } from "@/lib/api"
import { useAction, useDebounced, useResource } from "@/lib/hooks"
import { useJobAction } from "@/lib/use-job"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "订阅 · xc-p" }] }))
  .page(() => <SubscriptionsPage />)

const SORT_OPTIONS = [
  { value: "name:asc", label: "名称 A→Z" },
  { value: "name:desc", label: "名称 Z→A" },
  { value: "lastSyncAt:desc", label: "最近同步" },
  { value: "nodeCount:desc", label: "节点数" },
  { value: "status:asc", label: "状态" },
  { value: "intervalSec:asc", label: "同步间隔" },
] as const

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "ok", label: "正常" },
  { value: "failed", label: "失败" },
  { value: "never", label: "未同步" },
  { value: "disabled", label: "已暂停" },
] as const

function statusRank(item: SubscriptionItem): number {
  if (!item.enabled) return 3
  if (item.lastStatus === "ok") return 0
  if (item.lastStatus === "failed") return 1
  return 2
}

export function SubscriptionsPage() {
  const subs = useResource<{ items: SubscriptionItem[] }>(
    "subscriptions:list",
    (signal) => unwrap(eden.api.subscriptions.get({ fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const confirm = useConfirm()

  const [query, setQuery] = useState("")
  const debouncedQuery = useDebounced(query, 200)
  const [statusFilter, setStatusFilter] = useState("all")
  const [sortKey, setSortKey] = useState("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<SubscriptionItem | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [testTarget, setTestTarget] = useState<SubscriptionItem | null>(null)
  const [runsTarget, setRunsTarget] = useState<SubscriptionItem | null>(null)

  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [toggleId, setToggleId] = useState<string | null>(null)
  const syncTargetRef = useRef<SubscriptionItem | null>(null)

  const rowSync = useJobAction({
    label: "同步订阅",
    start: () => {
      const target = syncTargetRef.current
      if (!target) return Promise.reject(new Error("未选择要同步的订阅"))
      return startJob(eden.api.subscriptions({ id: target.id }).sync.post())
    },
    onDone: () => {
      setSyncingId(null)
      subs.refresh()
    },
    onFail: () => {
      setSyncingId(null)
      subs.refresh()
    },
  })

  const syncAll = useJobAction({
    label: "同步全部订阅",
    start: () => startJob(eden.api.subscriptions["sync-all"].post()),
    onDone: () => subs.refresh(),
    onFail: () => subs.refresh(),
  })

  const activeJob = rowSync.progress ?? syncAll.progress

  function openCreate() {
    setEditing(null)
    setEditorOpen(true)
  }

  function openEdit(item: SubscriptionItem) {
    setEditing(item)
    setEditorOpen(true)
  }

  function syncOne(item: SubscriptionItem) {
    syncTargetRef.current = item
    setSyncingId(item.id)
    void rowSync.run().catch((caught) => {
      setSyncingId(null)
      toast.error("同步提交失败", { description: describeError(caught) })
    })
  }

  const toggle = useAction(async (item: SubscriptionItem, enabled: boolean) => {
    const previous = subs.data
    if (previous) {
      subs.setData({ items: previous.items.map((row) => (row.id === item.id ? { ...row, enabled } : row)) })
    }
    setToggleId(item.id)
    try {
      await unwrap(eden.api.subscriptions({ id: item.id }).patch({ enabled }))
    } catch (caught) {
      if (previous) subs.setData(previous)
      throw caught
    } finally {
      setToggleId(null)
    }
  })

  function onToggle(item: SubscriptionItem, enabled: boolean) {
    toggle
      .run(item, enabled)
      .then(() => toast.success(enabled ? "已启用订阅" : "已暂停订阅", { description: item.name }))
      .catch((caught) => toast.error("切换失败", { description: describeError(caught) }))
  }

  async function remove(item: SubscriptionItem) {
    const ok = await confirm({
      title: "删除订阅？",
      description:
        "删除只影响后续同步：已入库的节点不会立即消失，会在 staleRetentionDays（默认 7 天）后标记为消失，并在下次发布时下架。",
      details: (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">订阅</span>
            <span className="max-w-60 truncate text-right font-medium">{item.name}</span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">来源</span>
            <span className="max-w-60 truncate text-right font-mono text-[11px]">{item.inline ? "内联文本" : maskUrl(item.url)}</span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <span className="text-muted-foreground">影响面</span>
            <span className="text-right font-medium">{item.nodeCount} 个来源节点 · 不再参与定时同步</span>
          </div>
        </div>
      ),
      destructive: true,
      confirmText: "删除订阅",
      action: async () => {
        await unwrap(eden.api.subscriptions({ id: item.id }).delete())
      },
    })
    if (ok) {
      toast.success("已删除订阅", { description: item.name })
      subs.refresh()
    }
  }

  function renderSwitch(item: SubscriptionItem) {
    const busy = toggle.pending && toggleId === item.id
    return (
      <div className="flex items-center gap-1.5">
        <Switch
          checked={item.enabled}
          disabled={toggle.pending}
          onCheckedChange={(checked) => onToggle(item, checked)}
          aria-label={(item.enabled ? "暂停" : "启用") + "订阅 " + item.name}
        />
        {busy ? <Spinner className="size-3 text-muted-foreground" /> : null}
      </div>
    )
  }

  function renderActions(item: SubscriptionItem) {
    const syncing = rowSync.pending && syncingId === item.id
    return (
      <div className="flex items-center justify-end gap-0.5">
        <LoadingButton
          variant="ghost"
          size="icon-sm"
          loading={syncing}
          loadingText=""
          disabled={rowSync.pending && !syncing}
          onClick={() => syncOne(item)}
          title="立即同步"
          aria-label={"立即同步 " + item.name}
        >
          <RefreshCw />
        </LoadingButton>
        <Button variant="ghost" size="icon-sm" onClick={() => setRunsTarget(item)} title="同步历史" aria-label={"同步历史 " + item.name}>
          <History />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setTestTarget(item)} title="测试解析" aria-label={"测试解析 " + item.name}>
          <FlaskConical />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(item)} title="编辑" aria-label={"编辑 " + item.name}>
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          onClick={() => void remove(item)}
          title="删除"
          aria-label={"删除 " + item.name}
        >
          <Trash2 />
        </Button>
      </div>
    )
  }

  function renderMobileCard(item: SubscriptionItem) {
    const meta = subStatusMeta(item.lastStatus, item.enabled)
    const syncing = rowSync.pending && syncingId === item.id
    return (
      <Card key={item.id} className="gap-0 py-0">
        <CardContent className="space-y-3 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium">{item.name}</span>
                {item.inline ? (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    内联
                  </Badge>
                ) : null}
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground" title={maskUrl(item.url)}>
                {item.inline ? "内联文本 · 不访问外部 URL" : maskUrl(item.url)}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <StatusBadge state={item.lastStatus} label={meta.label} tone={meta.tone} />
              {renderSwitch(item)}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <span>
              节点 <b className="font-medium text-foreground tabular-nums">{item.nodeCount}</b>
            </span>
            <span className="truncate">
              间隔 <b className="font-medium text-foreground">{formatInterval(item.intervalSec, item.cron)}</b>
            </span>
            <span className="truncate">
              上次成功{" "}
              <b className="font-medium text-foreground">
                {item.lastStatus === "ok" && item.lastSyncAt ? <RelativeTime ts={item.lastSyncAt} /> : "从未"}
              </b>
            </span>
          </div>
          {item.lastError ? (
            <p className="line-clamp-2 text-[11px] break-all text-destructive" title={item.lastError}>
              {item.lastErrorKind ? item.lastErrorKind + " · " : ""}
              {item.lastError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <LoadingButton variant="outline" size="sm" loading={syncing} loadingText="同步中…" disabled={rowSync.pending && !syncing} onClick={() => syncOne(item)}>
              <RefreshCw data-icon="inline-start" />
              同步
            </LoadingButton>
            <Button variant="outline" size="sm" onClick={() => setRunsTarget(item)}>
              <History data-icon="inline-start" />
              历史
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTestTarget(item)}>
              <FlaskConical data-icon="inline-start" />
              测试
            </Button>
            <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
              <Pencil data-icon="inline-start" />
              编辑
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void remove(item)}>
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const allItems = subs.data?.items ?? []
  const keyword = debouncedQuery.trim().toLowerCase()
  const filtered = allItems.filter((item) => {
    if (keyword) {
      const haystack = [item.name, item.url, item.formatHint, item.lastError ?? ""].join("\n").toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    switch (statusFilter) {
      case "ok":
        return item.enabled && item.lastStatus === "ok"
      case "failed":
        return item.enabled && item.lastStatus === "failed"
      case "never":
        return item.enabled && (item.lastStatus === "never" || !item.lastStatus)
      case "disabled":
        return !item.enabled
      default:
        return true
    }
  })
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1
    switch (sortKey) {
      case "nodeCount":
        return (a.nodeCount - b.nodeCount) * dir || a.name.localeCompare(b.name, "zh-CN")
      case "lastSyncAt":
        return ((a.lastSyncAt ?? 0) - (b.lastSyncAt ?? 0)) * dir || a.name.localeCompare(b.name, "zh-CN")
      case "status":
        return (statusRank(a) - statusRank(b)) * dir || a.name.localeCompare(b.name, "zh-CN")
      case "intervalSec":
        return ((a.intervalSec ?? 0) - (b.intervalSec ?? 0)) * dir || a.name.localeCompare(b.name, "zh-CN")
      default:
        return a.name.localeCompare(b.name, "zh-CN") * dir
    }
  })

  const enabledCount = allItems.filter((item) => item.enabled).length
  const failedCount = allItems.filter((item) => item.enabled && item.lastStatus === "failed").length
  const inlineCount = allItems.filter((item) => item.inline).length
  const nodeTotal = allItems.reduce((sum, item) => sum + (item.nodeCount || 0), 0)
  const filtering = statusFilter !== "all" || keyword !== ""
  const initialLoading = subs.loading && !subs.data

  const columns: DataTableColumn<SubscriptionItem>[] = [
    {
      key: "name",
      header: "名称 / 来源",
      sortable: true,
      cell: (item) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-56 truncate font-medium" title={item.name}>
              {item.name}
            </span>
            {item.inline ? (
              <Badge variant="secondary" className="shrink-0 font-normal">
                内联
              </Badge>
            ) : null}
          </div>
          <p className="max-w-64 truncate font-mono text-[11px] text-muted-foreground" title={item.inline ? "内联文本" : maskUrl(item.url)}>
            {item.inline ? "内联文本 · 不访问外部 URL" : maskUrl(item.url)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "状态",
      sortable: true,
      cell: (item) => {
        const meta = subStatusMeta(item.lastStatus, item.enabled)
        return (
          <div className="flex flex-col gap-1">
            <StatusBadge state={item.lastStatus} label={meta.label} tone={meta.tone} />
            {item.consecutiveFailures > 0 ? <span className="text-[11px] text-destructive">连败 {item.consecutiveFailures} 次</span> : null}
          </div>
        )
      },
    },
    {
      key: "lastSyncAt",
      header: "上次成功",
      sortable: true,
      className: "hidden md:table-cell",
      cell: (item) =>
        item.lastStatus === "ok" && item.lastSyncAt ? (
          <RelativeTime ts={item.lastSyncAt} />
        ) : (
          <span className="text-xs text-muted-foreground">从未</span>
        ),
    },
    {
      key: "intervalSec",
      header: "间隔",
      sortable: true,
      className: "hidden lg:table-cell",
      cell: (item) => <span className="whitespace-nowrap text-xs">{formatInterval(item.intervalSec, item.cron)}</span>,
    },
    {
      key: "nodeCount",
      header: "节点",
      sortable: true,
      className: "text-right",
      headClassName: "text-right",
      cell: (item) => <span className="tabular-nums">{item.nodeCount}</span>,
    },
    {
      key: "enabled",
      header: "启用",
      headClassName: "w-16",
      cell: (item) => renderSwitch(item),
    },
    {
      key: "lastError",
      header: "最近错误",
      className: "hidden xl:table-cell",
      cell: (item) =>
        item.lastError ? (
          <p className="max-w-56 truncate text-[11px] text-destructive" title={item.lastError}>
            {item.lastErrorKind ? item.lastErrorKind + " · " : ""}
            {item.lastError}
          </p>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">操作</span>,
      headClassName: "text-right",
      className: "text-right",
      cell: (item) => renderActions(item),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="订阅"
        description="同步只写期望状态（nodes），绝不直接改数据面；同步失败时保留上一次成功配置。"
        updatedAt={subs.updatedAt || undefined}
        onRefresh={subs.refresh}
        refreshing={subs.refreshing}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
              <Eye data-icon="inline-start" />
              解析预览
            </Button>
            <LoadingButton
              variant="outline"
              size="sm"
              loading={syncAll.pending}
              loadingText="同步中…"
              onClick={() => void syncAll.run().catch((caught) => toast.error("同步全部提交失败", { description: describeError(caught) }))}
            >
              <RefreshCw data-icon="inline-start" />
              同步全部
            </LoadingButton>
            <Button size="sm" onClick={openCreate}>
              <Plus data-icon="inline-start" />
              新建订阅
            </Button>
          </>
        }
      />

      {activeJob ? (
        <JobProgress
          job={activeJob}
          onCancel={() => {
            if (rowSync.progress) rowSync.cancel()
            else syncAll.cancel()
          }}
        />
      ) : null}

      {rowSync.error || syncAll.error ? (
        <ErrorState error={rowSync.error ?? syncAll.error} title="任务提交失败" compact />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="订阅总数"
          value={allItems.length}
          hint={inlineCount ? inlineCount + " 个内联文本 · " + (allItems.length - inlineCount) + " 个 URL" : "全部通过 URL 拉取"}
          icon={Rss}
          tone="info"
          loading={initialLoading}
        />
        <StatCard label="已启用" value={enabledCount} hint={"共 " + allItems.length + " 个订阅"} icon={CheckCircle2} tone="ok" loading={initialLoading} />
        <StatCard
          label="最近失败"
          value={failedCount}
          hint={failedCount ? "检查订阅源可达性与格式提示" : "所有启用订阅状态正常"}
          icon={TriangleAlert}
          tone={failedCount ? "down" : "ok"}
          loading={initialLoading}
        />
        <StatCard label="来源节点" value={nodeTotal} hint="按订阅关联的节点计数" icon={Layers} tone="info" loading={initialLoading} />
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称 / URL / 格式"
              className="pl-8"
              aria-label="搜索订阅"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger size="sm" className="w-32" aria-label="状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortKey + ":" + sortDir}
            onValueChange={(value) => {
              const [key, dir] = value.split(":")
              setSortKey(key ?? "name")
              setSortDir(dir === "desc" ? "desc" : "asc")
            }}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="排序方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          共 {allItems.length} 个订阅 · 当前显示 {sorted.length} 个{filtering ? "（已筛选）" : ""}
        </p>
      </div>

      {subs.error && !subs.data ? (
        <ErrorState error={subs.error} title="加载订阅失败" onRetry={subs.refresh} />
      ) : initialLoading ? (
        <>
          <div className="grid gap-2 md:hidden">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-36 w-full rounded-xl" />
            ))}
          </div>
          <div className="hidden md:block">
            <DataTable columns={columns} rows={[]} rowKey={(item) => item.id} loading loadingRows={5} />
          </div>
        </>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Rss}
          title={filtering ? "没有匹配的订阅" : "还没有订阅"}
          description={filtering ? "试试清空搜索或切换状态筛选。" : "添加第一个订阅源后，节点会自动同步进池。支持 URL 或直接粘贴节点文本。"}
          action={
            filtering ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("")
                  setStatusFilter("all")
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}>
                <Plus data-icon="inline-start" />
                添加第一个订阅
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid gap-2 md:hidden">{sorted.map((item) => renderMobileCard(item))}</div>
          <div className="hidden md:block">
            <DataTable
              columns={columns}
              rows={sorted}
              rowKey={(item) => item.id}
              sort={sortKey}
              sortDir={sortDir}
              onSortChange={(key) => {
                if (key === sortKey) setSortDir((previous) => (previous === "asc" ? "desc" : "asc"))
                else {
                  setSortKey(key)
                  setSortDir(key === "name" ? "asc" : "desc")
                }
              }}
            />
          </div>
        </>
      )}

      <SubscriptionEditorDialog open={editorOpen} onOpenChange={setEditorOpen} item={editing} onSaved={subs.refresh} />
      <ParsePreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} />
      <ParsePreviewDialog
        open={!!testTarget}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null)
        }}
        target={testTarget}
      />
      {runsTarget ? (
        <SubscriptionRunsSheet
          item={runsTarget}
          open
          onOpenChange={(open) => {
            if (!open) setRunsTarget(null)
          }}
          onSync={() => {
            setRunsTarget(null)
            syncOne(runsTarget)
          }}
        />
      ) : null}
    </div>
  )
}
