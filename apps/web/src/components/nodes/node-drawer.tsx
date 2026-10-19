import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  Link2,
  Radar,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/common/code-block"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { JobProgress } from "@/components/common/job-progress"
import { LoadingButton } from "@/components/common/loading-button"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { useConfirm } from "@/components/common/confirm-dialog"
import { StatusBadge } from "@/components/common/status-badge"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { describeError, eden, startJob, unwrap } from "@/lib/api"
import { fmtMs, fmtNumber, fmtPercent } from "@/lib/format"
import { useAction, useResource } from "@/lib/hooks"
import { watchJob } from "@/lib/jobs"
import { useJobAction } from "@/lib/use-job"
import { cn } from "@/lib/utils"
import { ERROR_KINDS, type ConnectionStrings } from "@/lib/domain"
import type { GatewayConnectionsResponse } from "@/components/gateway/types"
import { passwordFromConnection, type NodeCheckRun, type NodeRow } from "./types"

/** 抽屉只关心网关响应里的活跃连接/聚合；复用网关页的类型，避免再抄一份。 */
type GatewayConnections = Pick<GatewayConnectionsResponse, "active" | "byNode" | "stats">

const TABS = [
  { value: "cred", label: "凭据" },
  { value: "conn", label: "连接串" },
  { value: "hist", label: "检测历史" },
  { value: "err", label: "错误详情" },
] as const

type TabValue = (typeof TABS)[number]["value"]

/** 单节点抽屉：凭据、连接串、检测历史与错误详情；所有动作都有加载态与确认面。 */
export function NodeDrawer({
  node,
  onRefresh,
  onDeleted,
}: {
  node: NodeRow
  onRefresh: () => void
  onDeleted?: () => void
}) {
  const confirm = useConfirm()
  const [tab, setTab] = useState<TabValue>("cred")
  const [password, setPassword] = useState("")
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [rotated, setRotated] = useState<{ username: string; password: string; at: number } | null>(null)

  const gateway = useResource<GatewayConnections>("node-drawer:gateway", (signal) => unwrap(eden.api.gateway.connections.get({ fetch: { signal } })), {
    pollMs: 15_000,
  })

  const connection = useResource<ConnectionStrings>(
    "node-drawer:connection:" + node.id,
    (signal) => unwrap(eden.api.nodes({ id: node.id }).connection.get({ fetch: { signal } })),
    { enabled: tab === "conn" },
  )

  const checks = useResource<{ items: NodeCheckRun[] }>(
    "node-drawer:checks:" + node.id,
    (signal) => unwrap(eden.api.nodes({ id: node.id }).checks.get({ query: { limit: 50 }, fetch: { signal } })),
    { enabled: tab === "hist" },
  )

  const checkJob = useJobAction({
    label: "检测 " + node.id,
    start: () => startJob(eden.api.nodes({ id: node.id }).check.post({ depth: "full" })),
    onDone: () => {
      checks.refresh()
      onRefresh()
    },
  })

  useEffect(() => {
    setTab("cred")
    setPassword("")
    setPasswordVisible(false)
    setRotated(null)
  }, [node.id])

  const connectionCount = useMemo(() => {
    const data = gateway.data
    if (!data) return null
    const fromStats = data.stats?.activeByNode?.[node.id]
    if (typeof fromStats === "number") return fromStats
    const fromNode = data.byNode?.[node.id]
    if (typeof fromNode === "number") return fromNode
    return (data.active ?? []).filter((item) => item.nodeId === node.id).length
  }, [gateway.data, node.id])

  const reveal = useAction(async () => {
    if (password) {
      setPasswordVisible((value) => !value)
      return
    }
    try {
      const result = await unwrap(eden.api.nodes({ id: node.id }).connection.get())
      const value = passwordFromConnection(result)
      if (!value) {
        toast.error("未获取到密码", { description: "服务端返回的连接串中没有可解析的凭据。" })
        return
      }
      setPassword(value)
      setPasswordVisible(true)
    } catch (error) {
      toast.error("读取密码失败", { description: describeError(error) })
    }
  })

  const rotate = async () => {
    await confirm({
      title: "轮换节点密码？",
      description:
        "轮换只在网关内存中生效：新连接必须使用新密码，旧密码立刻失效；已建立的连接不会被断开。轮换不需要重新发布数据面。",
      details: <ImpactRows rows={[["影响节点", <span className="font-mono">{node.id}</span>], ["当前连接", (connectionCount ?? "—") + " 条（不受影响）"], ["生效速度", "立即"]]} />,
      destructive: true,
      confirmText: "轮换密码",
      action: async () => {
        const result = await unwrap(eden.api.nodes({ id: node.id }).rotate.post())
        setPassword(result.password)
        setPasswordVisible(true)
        setRotated({ username: result.username, password: result.password, at: Date.now() })
        setTab("cred")
        toast.success("密码已轮换并立即生效")
        gateway.refresh()
      },
    })
  }

  const disconnect = async () => {
    await confirm({
      title: "断开该节点的全部连接？",
      description:
        "网关会立即关闭该节点所有已建立的 socket，客户端马上感知断开。这是网关独有的能力，Xray 本身无法枚举或断开连接。",
      details: <ImpactRows rows={[["影响节点", <span className="font-mono">{node.id}</span>], ["将断开连接", (connectionCount ?? "未知") + " 条"], ["数据面", "不受影响"]]} />,
      destructive: true,
      confirmText: "断开连接",
      action: async () => {
        const result = await unwrap(eden.api.nodes({ id: node.id }).disconnect.post())
        toast.success("已断开 " + fmtNumber(result.closed) + " 条连接")
        gateway.refresh()
        onRefresh()
      },
    })
  }

  const deleteNode = () => {
    void confirm({
      title: "删除节点 " + node.id + "？",
      description:
        "从期望状态（数据库）中删除该节点。若它仍在数据面，系统会立即提交一次对账：移除环回入站与路由规则，outbound 进入延迟退休队列。",
      details: (
        <ImpactRows
          rows={[
            ["影响节点", <span className="font-mono">{node.id}</span>],
            ["当前连接", (connectionCount ?? "未知") + " 条（删除时断开）"],
            ["凭据与检测历史", "一并删除，不可恢复"],
            ["数据面", node.missingSince ? "对账后移除残留 tag" : "对账后移除入站；outbound 延迟回收"],
          ]}
        />
      ),
      destructive: true,
      requireText: node.id,
      confirmText: "删除节点",
      action: async () => {
        const result = await unwrap(eden.api.nodes({ id: node.id }).delete())
        if (result.jobId) {
          watchJob(result.jobId, {
            label: "清理数据面节点 " + node.id,
            silent: true,
            onDone: onRefresh,
          })
        }
        toast.success("已删除节点 " + node.id, {
          description: result.jobId ? "数据面清理任务已提交，完成后自动刷新" : "该节点未进入数据面，无需清理",
        })
        onRefresh()
        onDeleted?.()
      },
    })
  }

  const canDelete = !!node.missingSince || !node.enabled

  const runCheck = () => {
    void checkJob.run().catch((error) => toast.error("检测提交失败", { description: describeError(error) }))
  }

  return (
    <>
      <SheetHeader className="gap-2 border-b p-4 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-base">
            <span className="truncate">{node.displayName || node.id}</span>
            <StatusBadge state={node.state} pulse={node.state === "up"} />
          </SheetTitle>
          <Badge variant="secondary" className="font-mono text-[11px] uppercase">
            {node.protocol}
          </Badge>
          {node.missingSince ? (
            <Badge variant="outline" className="text-warning">
              已消失
            </Badge>
          ) : null}
          {!node.enabled ? (
            <Badge variant="outline" className="text-muted-foreground">
              已停用
            </Badge>
          ) : null}
        </div>
        <SheetDescription className="font-mono text-xs">{node.id}</SheetDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <LoadingButton size="sm" variant="outline" loading={checkJob.pending} loadingText="检测中…" onClick={runCheck}>
            <Radar data-icon="inline-start" />
            立即检测
          </LoadingButton>
          <Button size="sm" variant="outline" onClick={() => void rotate()}>
            <KeyRound data-icon="inline-start" />
            轮换密码
          </Button>
          <Button size="sm" variant="destructive" onClick={() => void disconnect()}>
            <Unplug data-icon="inline-start" />
            断开连接
          </Button>
          {canDelete ? (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => void deleteNode()}
            >
              <Trash2 data-icon="inline-start" />
              删除节点
            </Button>
          ) : null}
        </div>
        {checkJob.progress ? <JobProgress job={checkJob.progress} onCancel={checkJob.cancel} className="mt-1" /> : null}
      </SheetHeader>

      <div className="flex-1 p-4">
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
          <TabsList className="w-full">
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="cred" className="mt-4 space-y-4">
            <Alert>
              <ShieldCheck />
              <AlertTitle>凭据由面板生成并加密存储</AlertTitle>
              <AlertDescription>
                用户名即节点 ID；轮换后网关立即生效（旧密码立刻失效），已建立的连接不会被踢线。
              </AlertDescription>
            </Alert>

            {rotated ? (
              <Alert className="border-warning/50 bg-warning/10">
                <TriangleAlert className="text-warning" />
                <AlertTitle className="text-warning">新密码已生成 · 立即生效</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {new Date(rotated.at).toLocaleTimeString("zh-CN")} 轮换。请立刻更新所有使用旧密码的客户端配置。
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-background px-2 py-1 font-mono text-xs">{rotated.password}</code>
                    <CopyButton value={rotated.password} label="复制新密码" size="xs" variant="outline" />
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}

            <dl className="space-y-3">
              <CredentialRow label="用户名 / 节点 ID">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{node.username || node.id}</code>
                  <CopyButton value={node.username || node.id} label="复制" size="xs" variant="outline" />
                </div>
              </CredentialRow>
              <Separator />
              <CredentialRow label="密码" hint="默认隐藏；显示时会从服务端读取明文">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {password && passwordVisible ? password : "••••••••••••••••"}
                  </code>
                  <LoadingButton
                    size="xs"
                    variant="outline"
                    loading={reveal.pending}
                    loadingText="读取中…"
                    onClick={() => void reveal.run()}
                  >
                    {password && passwordVisible ? "隐藏" : "显示"}
                  </LoadingButton>
                  {password ? <CopyButton value={password} label="复制" size="xs" variant="outline" /> : null}
                </div>
              </CredentialRow>
              <Separator />
              <CredentialRow label="当前连接" hint="来自网关连接表，每 15 秒刷新">
                {connectionCount === null ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <span className="text-sm tabular-nums">
                    {fmtNumber(connectionCount)} 条
                    {connectionCount > 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">可用「断开连接」立即关闭</span>
                    ) : null}
                  </span>
                )}
              </CredentialRow>
              <Separator />
              <CredentialRow label="客户端连接串" hint="HTTP / SOCKS5 · Basic 凭据为明文，注意暴露面">
                <Button size="xs" variant="outline" onClick={() => setTab("conn")}>
                  <Link2 data-icon="inline-start" />
                  查看连接串
                </Button>
              </CredentialRow>
            </dl>
          </TabsContent>

          <TabsContent value="conn" className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">所有连接串都包含明文密码，请仅在可信网络中分发。</p>
              <LoadingButton size="sm" variant="outline" loading={connection.refreshing} loadingText="刷新中…" onClick={connection.refresh}>
                <ClipboardCopy data-icon="inline-start" />
                刷新
              </LoadingButton>
            </div>
            {connection.loading && !connection.data ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-24 w-full rounded-lg" />
                ))}
              </div>
            ) : connection.error && !connection.data ? (
              <ErrorState error={connection.error} title="连接串加载失败" onRetry={connection.refresh} />
            ) : connection.data ? (
              <div className="space-y-3">
                <CodeBlock title="HTTP 代理" code={connection.data.http} maxHeight={120} wrap />
                <CodeBlock title="SOCKS5" code={connection.data.socks5} maxHeight={120} wrap />
                <CodeBlock title="curl" code={connection.data.curl} maxHeight={120} wrap />
                <CodeBlock title="Docker env" code={(connection.data.docker ?? []).join("\n")} maxHeight={160} />
                <CodeBlock title="环境变量" code={connection.data.env} maxHeight={160} />
                <CodeBlock title="Clash" code={connection.data.clash} maxHeight={220} />
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="hist" className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                最近 {checks.data?.items.length ?? 0} 条检测记录（上限 50 条）
              </p>
              <div className="flex items-center gap-2">
                <LoadingButton size="sm" variant="outline" loading={checks.refreshing} loadingText="刷新中…" onClick={checks.refresh}>
                  刷新
                </LoadingButton>
                <LoadingButton size="sm" loading={checkJob.pending} loadingText="检测中…" onClick={runCheck}>
                  <Radar data-icon="inline-start" />
                  立即检测
                </LoadingButton>
              </div>
            </div>
            {checks.loading && !checks.data ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </div>
            ) : checks.error && !checks.data ? (
              <ErrorState error={checks.error} title="检测历史加载失败" onRetry={checks.refresh} />
            ) : (checks.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                icon={Radar}
                title="暂无检测记录"
                description="该节点还没有跑过检测。点击「立即检测」触发一次完整探测（S1 连通 / S2 出口 / S3 规则）。"
                compact
                action={
                  <LoadingButton size="sm" loading={checkJob.pending} loadingText="检测中…" onClick={runCheck}>
                    立即检测
                  </LoadingButton>
                }
              />
            ) : (
              <div className="scrollbar-thin overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>时间</TableHead>
                      <TableHead className="hidden sm:table-cell">来源</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>延迟</TableHead>
                      <TableHead className="hidden md:table-cell">出口 IP</TableHead>
                      <TableHead>错误</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(checks.data?.items ?? []).map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          <TimeText ts={run.at} />
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{run.source}</TableCell>
                        <TableCell>
                          <StatusBadge state={run.ok ? "up" : "down"} label={run.ok ? "成功" : "失败"} />
                        </TableCell>
                        <TableCell className={cn("whitespace-nowrap text-xs tabular-nums", run.ok && "text-success")}>
                          {fmtMs(run.delay_ms || run.total_ms)}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap font-mono text-xs md:table-cell">
                          {run.exit_ip || "—"}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-xs text-muted-foreground" title={run.error_msg ?? undefined}>
                          {run.error_kind || run.error_msg || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="err" className="mt-4 space-y-4">
            {node.errorKind || node.errorMsg ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle className="font-mono">{node.errorKind || "unknown"}</AlertTitle>
                <AlertDescription className="break-all">{node.errorMsg || "服务端没有返回错误描述"}</AlertDescription>
              </Alert>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">最近一次检测没有记录错误</p>
                  <p className="text-xs text-muted-foreground">如果状态仍异常，可以点击「立即检测」重新探测。</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Metric label="状态" value={<StatusBadge state={node.state} />} />
              <Metric label="连续失败" value={<span className={node.failStreak > 0 ? "text-destructive" : undefined}>{node.failStreak}</span>} />
              <Metric label="连续成功" value={node.successStreak} />
              <Metric label="累计检测" value={fmtNumber(node.checksTotal)} />
              <Metric label="成功次数" value={fmtNumber(node.checksOk)} />
              <Metric label="成功率" value={fmtPercent(node.uptime24h)} />
              <Metric label="最后检测" value={<RelativeTime ts={node.lastCheckAt} />} />
              <Metric label="最后成功" value={<RelativeTime ts={node.lastOkAt} />} />
              <Metric label="发布错误" value={node.publishError ? <span className="text-warning">{node.publishError}</span> : "—"} />
            </div>

            {node.missingSince ? (
              <Alert className="border-warning/50 bg-warning/10">
                <TriangleAlert className="text-warning" />
                <AlertTitle className="text-warning">该节点已从订阅中消失</AlertTitle>
                <AlertDescription>
                  消失于 <TimeText ts={node.missingSince} />。下一次发布将按「自动移除消失节点」策略处理；已有节点记录会保留到清理策略生效。
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">检测错误分类枚举（PANEL.md §8.3）</p>
              <div className="flex flex-wrap gap-1">
                {ERROR_KINDS.map((kind) => (
                  <Badge
                    key={kind}
                    variant="outline"
                    className={cn("font-mono text-[10px]", kind === node.errorKind && "border-destructive text-destructive")}
                  >
                    {kind}
                  </Badge>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

function CredentialRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="mt-0.5 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

function ImpactRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
