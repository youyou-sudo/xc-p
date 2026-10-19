import { useEffect, useMemo, useRef, useState } from "react"
import { Power, PowerOff, Radar, Search, SlidersHorizontal, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { useConfirm } from "@/components/common/confirm-dialog"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { describeError, eden, normalizeNode, startJob, unwrap } from "@/lib/api"
import { fmtNumber } from "@/lib/format"
import { useAction, useDebounced, useResource } from "@/lib/hooks"
import { watchJob } from "@/lib/jobs"
import { useJobAction } from "@/lib/use-job"
import { NodeDrawer } from "@/components/nodes/node-drawer"
import { NodesEmpty, NodesTable } from "@/components/nodes/nodes-table"
import { PROTOCOLS, type NodeRow, type NodesResponse } from "@/components/nodes/types"
import { defineRoute } from "@teyik0/furin"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "节点 · xc-p" }] }))
  .page(() => <NodesPage />)

const STATE_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "up", label: "正常" },
  { value: "degraded", label: "降级" },
  { value: "down", label: "不可用" },
  { value: "quarantined", label: "隔离" },
  { value: "unknown", label: "未检测" },
]

const SORT_OPTIONS = [
  { value: "id", label: "按 ID 排序" },
  { value: "latency", label: "按延迟排序" },
  { value: "state", label: "按状态排序" },
]

const PAGE_SIZES = ["20", "50", "100"]

export function NodesPage() {
  const confirm = useConfirm()

  const [query, setQuery] = useState("")
  const debouncedQuery = useDebounced(query, 350)
  const [stateFilter, setStateFilter] = useState("all")
  const [protocolFilter, setProtocolFilter] = useState("all")
  const [country, setCountry] = useState("")
  const debouncedCountry = useDebounced(country, 350)
  const [enabledFilter, setEnabledFilter] = useState("all")
  const [supportedFilter, setSupportedFilter] = useState("all")
  const [sort, setSort] = useState("id")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [countries, setCountries] = useState<string[]>([])
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<NodeRow | null>(null)

  const params = useMemo(
    () => ({
      limit: pageSize,
      cursor: (page - 1) * pageSize,
      q: debouncedQuery.trim() || undefined,
      state: stateFilter === "all" ? undefined : stateFilter,
      protocol: protocolFilter === "all" ? undefined : protocolFilter,
      country: debouncedCountry.trim().toUpperCase() || undefined,
      enabled: enabledFilter === "all" ? undefined : enabledFilter,
      supported: supportedFilter === "all" ? undefined : supportedFilter,
      sort,
    }),
    [pageSize, page, debouncedQuery, stateFilter, protocolFilter, debouncedCountry, enabledFilter, supportedFilter, sort],
  )

  const resourceKey = "nodes:" + JSON.stringify(params)
  const nodesRes = useResource<NodesResponse>(
    resourceKey,
    (signal) => unwrap(eden.api.nodes.get({ query: params, fetch: { signal } })),
    { pollMs: 20_000 },
  )

  // 「已消失」节点数量（用于批量清理入口；服务端过滤，不受当前页/筛选影响）
  const missingRes = useResource<NodesResponse>(
    "nodes:missing",
    (signal) => unwrap(eden.api.nodes.get({ query: { missing: true, limit: 1 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const missingTotal = missingRes.data?.total ?? 0

  const items = useMemo<NodeRow[]>(
    () => (nodesRes.data?.items ?? []).map((raw) => normalizeNode(raw as unknown as Record<string, any>) as unknown as NodeRow),
    [nodesRes.data],
  )
  const total = nodesRes.data?.total ?? items.length
  const pageCount = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1
  const hasMore = nodesRes.data ? page * pageSize < (nodesRes.data.total ?? 0) : false
  const loading = nodesRes.loading && !nodesRes.data
  const hasFilters =
    debouncedQuery.trim() !== "" ||
    stateFilter !== "all" ||
    protocolFilter !== "all" ||
    debouncedCountry.trim() !== "" ||
    enabledFilter !== "all" ||
    supportedFilter !== "all"

  useEffect(() => {
    setPage(1)
  }, [debouncedQuery, stateFilter, protocolFilter, debouncedCountry, enabledFilter, supportedFilter, sort, pageSize])

  // 翻页/筛选变化时清空选择；轮询刷新只剔除已不在当前页的节点
  useEffect(() => {
    setSelected(new Set())
  }, [resourceKey])

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const ids = new Set(items.map((node) => node.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  // 用当前页出现过的国家补全筛选下拉，避免额外请求
  useEffect(() => {
    const found = items.map((node) => (node.countryCode ?? "").toUpperCase()).filter(Boolean)
    if (found.length === 0) return
    setCountries((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const code of found) {
        if (!next.has(code)) {
          next.add(code)
          changed = true
        }
      }
      return changed ? [...next].sort() : prev
    })
  }, [items])

  const refresh = nodesRes.refresh

  const updateMany = async (ids: string[], enabled: boolean) => {
    const results = await Promise.allSettled(ids.map((id) => unwrap(eden.api.nodes({ id }).patch({ enabled }))))
    const failed = results
      .map((result, index) => ({ result, id: ids[index] }))
      .filter((entry) => entry.result.status === "rejected")
    if (failed.length > 0) {
      const first = failed[0]?.result
      toast.error(
        "已" + (enabled ? "启用" : "停用") + " " + (ids.length - failed.length) + "/" + ids.length + " 个节点",
        {
          description:
            failed
              .slice(0, 3)
              .map((entry) => entry.id)
              .join("、") +
            (failed.length > 3 ? " 等" : "") +
            " 失败：" +
            (first && first.status === "rejected" ? describeError(first.reason) : "未知错误"),
        },
      )
    } else {
      toast.success("已" + (enabled ? "启用" : "停用") + " " + ids.length + " 个节点")
    }
    setSelected(new Set())
    refresh()
  }

  const batchEnable = useAction(async (ids: string[]) => updateMany(ids, true))
  const batchDisable = useAction(async (ids: string[]) => updateMany(ids, false))

  const toggleEnabled = useAction(async (node: NodeRow, enabled: boolean) => {
    setTogglingId(node.id)
    try {
      await unwrap(eden.api.nodes({ id: node.id }).patch({ enabled }))
      toast.success("已" + (enabled ? "启用" : "停用") + " " + (node.displayName || node.id))
      refresh()
    } catch (error) {
      toast.error("操作失败", { description: describeError(error) })
    } finally {
      setTogglingId(null)
    }
  })

  const handleToggleEnabled = async (node: NodeRow, enabled: boolean) => {
    if (enabled) {
      void toggleEnabled.run(node, true)
      return
    }
    await confirm({
      title: "停用节点？",
      description: "停用只影响期望状态：下一次发布时该节点会从数据面移除，已建立的连接不会被断开。",
      details: (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">节点</dt>
            <dd className="font-mono">{node.id}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">当前状态</dt>
            <dd className="font-medium">{node.state}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">在途连接</dt>
            <dd className="font-medium">不受影响</dd>
          </div>
        </dl>
      ),
      destructive: true,
      confirmText: "停用",
      action: async () => {
        await unwrap(eden.api.nodes({ id: node.id }).patch({ enabled: false }))
        toast.success("已停用 " + (node.displayName || node.id))
        refresh()
      },
    })
  }

  const batchIdsRef = useRef<string[]>([])

  const batchCheck = useJobAction({
    label: "批量检测",
    start: () => startJob(eden.api.nodes["check-batch"].post({ nodeIds: batchIdsRef.current, depth: "full" })),
    onDone: () => {
      setSelected(new Set())
      refresh()
    },
  })

  const checkAll = useJobAction({
    label: "检测全部节点",
    start: () => startJob(eden.api.nodes["check-batch"].post({ depth: "full" })),
    onDone: refresh,
  })

  const purgeMissing = () => {
    void confirm({
      title: "清理已消失节点？",
      description:
        "删除所有「已消失且已停用」的节点记录（凭据、检测历史一并删除），并自动提交一次对账，清理数据面残留的 in-/out-/node- tag。",
      details: (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">将清理节点</dt>
            <dd className="font-medium tabular-nums">{missingTotal} 个</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">启用中的节点</dt>
            <dd className="font-medium">不会被清理</dd>
          </div>
          <p className="text-xs text-muted-foreground">该操作不可恢复；数据面清理完成前，运行配置页会显示待退休 tag。</p>
        </div>
      ),
      destructive: true,
      confirmText: "清理 " + missingTotal + " 个",
      action: async () => {
        const result = await unwrap(eden.api.nodes["purge-missing"].post())
        if (result.jobId) {
          watchJob(result.jobId, {
            label: "清理数据面残留",
            silent: true,
            onDone: () => {
              refresh()
              missingRes.refresh()
            },
          })
        }
        toast.success("已清理 " + result.removed + " 个已消失节点", {
          description: result.jobId ? "数据面清理任务已提交，完成后自动刷新" : "数据面没有需要清理的残留 tag",
        })
        refresh()
        missingRes.refresh()
      },
    })
  }

  const runBatchCheck = () => {
    batchIdsRef.current = [...selected]
    void batchCheck.run().catch((error) => toast.error("批量检测提交失败", { description: describeError(error) }))
  }

  const runBatchDisable = async () => {
    const ids = [...selected]
    await confirm({
      title: "停用 " + ids.length + " 个节点？",
      description:
        "停用只影响期望状态：下一次发布时这些节点会从数据面移除，已建立的连接不会被断开。随时可以重新启用。",
      details: (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">将停用节点</dt>
            <dd className="font-medium tabular-nums">{ids.length} 个</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">在途连接</dt>
            <dd className="font-medium">不受影响</dd>
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">{ids.slice(0, 6).join("、")}{ids.length > 6 ? " 等" : ""}</p>
        </div>
      ),
      destructive: true,
      confirmText: "停用",
      action: async () => {
        await updateMany(ids, false)
      },
    })
  }

  const quickCheck = useAction(async (node: NodeRow) => {
    setCheckingId(node.id)
    try {
      const { jobId } = await startJob(eden.api.nodes({ id: node.id }).check.post({ depth: "full" }))
      if (!jobId) {
        toast.error("检测任务提交失败", { description: "服务端未返回任务号（jobId）" })
        return
      }
      const outcome = await watchJob(jobId, { label: "检测 " + node.id, silent: true }).done
      if (outcome.status === "ok") {
        toast.success("检测完成：" + (node.displayName || node.id))
        refresh()
      } else {
        toast.error("检测失败：" + (node.displayName || node.id), {
          description: outcome.message || outcome.error?.message || undefined,
        })
      }
    } catch (error) {
      toast.error("检测提交失败", { description: describeError(error) })
    } finally {
      setCheckingId(null)
    }
  })

  const resetFilters = () => {
    setQuery("")
    setStateFilter("all")
    setProtocolFilter("all")
    setCountry("")
    setEnabledFilter("all")
    setSupportedFilter("all")
    setSort("id")
  }

  const toggleAll = (checked: boolean) => {
    if (!checked) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(items.map((node) => node.id)))
  }

  const toggleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const activeNode = useMemo(() => {
    if (!activeId) return null
    return items.find((node) => node.id === activeId) ?? snapshot
  }, [activeId, items, snapshot])

  const openNode = (node: NodeRow) => {
    setActiveId(node.id)
    setSnapshot(node)
    setDrawerOpen(true)
  }

  const activeProgress = checkAll.progress ?? batchCheck.progress

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="节点"
        description="节点池的期望状态（数据库为准）：搜索、筛选、批量启停与检测，点击行查看凭据、连接串与检测历史。"
        updatedAt={nodesRes.updatedAt || nodesRes.data?.updatedAt || undefined}
        onRefresh={refresh}
        refreshing={nodesRes.refreshing}
        actions={
          <>
            {missingTotal > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={purgeMissing}
              >
                <Trash2 data-icon="inline-start" />
                清理已消失 ({missingTotal})
              </Button>
            ) : null}
            <LoadingButton
              variant="outline"
              size="sm"
              loading={checkAll.pending}
              loadingText="检测中…"
              onClick={() => void checkAll.run().catch((error) => toast.error("检测提交失败", { description: describeError(error) }))}
            >
              <Radar data-icon="inline-start" />
              检测全部
            </LoadingButton>
            <Badge variant="outline" className="hidden font-normal sm:inline-flex">
              共 {fmtNumber(total)} 个节点
            </Badge>
          </>
        }
      />

      {activeProgress ? <JobProgress job={activeProgress} onCancel={() => { if (checkAll.progress) checkAll.cancel(); else batchCheck.cancel() }} /> : null}

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-2 p-3">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <div className="relative col-span-2 w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索节点 ID / 名称 / 协议"
                className="h-8 pl-8"
                aria-label="搜索节点"
              />
            </div>
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={protocolFilter} onValueChange={setProtocolFilter}>
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="协议筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部协议</SelectItem>
                {PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocol.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="w-full sm:w-40">
              <Input
                value={country}
                onChange={(event) => setCountry(event.target.value)}
                placeholder="国家（如 HK）"
                list="node-countries"
                className="h-8"
                aria-label="国家筛选"
              />
              <datalist id="node-countries">
                {countries.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
            </div>
            <Select value={enabledFilter} onValueChange={setEnabledFilter}>
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="启用筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">启用不限</SelectItem>
                <SelectItem value="true">仅已启用</SelectItem>
                <SelectItem value="false">仅已停用</SelectItem>
              </SelectContent>
            </Select>
            <Select value={supportedFilter} onValueChange={setSupportedFilter}>
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="可发布筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">可发布不限</SelectItem>
                <SelectItem value="true">仅可发布</SelectItem>
                <SelectItem value="false">仅不支持</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="排序">
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
            {hasFilters ? (
              <Button variant="ghost" size="sm" className="col-span-2 justify-self-start sm:col-auto" onClick={resetFilters}>
                <X data-icon="inline-start" />
                清除筛选
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SlidersHorizontal className="size-3.5" />
            <span>
              第 {page} / {pageCount} 页 · 当前页 {items.length} 项 · 共 {fmtNumber(total)} 个节点
            </span>
            {selected.size > 0 ? <Badge variant="secondary">已选 {selected.size} 项</Badge> : null}
          </div>
        </CardContent>
      </Card>

      {selected.size > 0 ? (
        <Card className="gap-0 border-primary/40 bg-primary/5 py-0">
          <CardContent className="flex flex-wrap items-center gap-2 p-2.5">
            <span className="text-sm font-medium">已选 {selected.size} 个节点</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <LoadingButton
                size="sm"
                variant="outline"
                loading={batchEnable.pending}
                loadingText="启用中…"
                onClick={() => void batchEnable.run([...selected])}
              >
                <Power data-icon="inline-start" />
                批量启用
              </LoadingButton>
              <LoadingButton
                size="sm"
                variant="outline"
                loading={batchDisable.pending}
                loadingText="停用中…"
                onClick={() => void runBatchDisable()}
              >
                <PowerOff data-icon="inline-start" />
                批量停用
              </LoadingButton>
              <LoadingButton
                size="sm"
                loading={batchCheck.pending}
                loadingText="检测中…"
                onClick={runBatchCheck}
              >
                <Radar data-icon="inline-start" />
                批量检测
              </LoadingButton>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                清除选择
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {nodesRes.error ? (
        <ErrorState
          error={nodesRes.error}
          title={nodesRes.data ? "刷新节点列表失败" : "节点列表加载失败"}
          compact={!!nodesRes.data}
          onRetry={refresh}
        />
      ) : null}

      {nodesRes.data || !nodesRes.error ? (
        <NodesTable
          nodes={items}
          loading={loading}
          selected={selected}
          checkingId={checkingId}
          togglingId={togglingId}
          onToggleAll={toggleAll}
          onToggleSelect={toggleSelect}
          onOpen={openNode}
          onCheck={(node) => void quickCheck.run(node)}
          onToggleEnabled={(node, enabled) => void handleToggleEnabled(node, enabled)}
          empty={<NodesEmpty filtered={hasFilters} onReset={resetFilters} />}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          共 {fmtNumber(total)} 个节点 · 第 {page} / {pageCount} 页 · 每页 {pageSize} 条
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
            <SelectTrigger size="sm" className="w-28" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={size}>
                  每页 {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={page <= 1 || nodesRes.refreshing} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore || nodesRes.refreshing}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </Button>
        </div>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {activeNode ? (
            <NodeDrawer node={activeNode} onRefresh={refresh} onDeleted={() => setDrawerOpen(false)} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
