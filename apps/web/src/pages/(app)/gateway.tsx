import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "@teyik0/furin/link"
import { Activity, Ban, Radio, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/common/confirm-dialog"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { PageHeader } from "@/components/common/page-header"
import { StatCard } from "@/components/common/stat-card"
import { Dot } from "@/components/common/status-badge"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionCard } from "@/components/common/section-card"
import { AggregateTable } from "@/components/gateway/aggregate-table"
import { BannedList } from "@/components/gateway/banned-list"
import { ConnectionsTable } from "@/components/gateway/connections-table"
import { GatewayConfigForm } from "@/components/gateway/gateway-config-form"
import { RecentConnections } from "@/components/gateway/recent-connections"
import {
  countByUser,
  toAggregateRows,
  type GatewayConnectionsResponse,
  type KickPayload,
  type SettingsResponse,
} from "@/components/gateway/types"
import { eden, unwrap } from "@/lib/api"
import { fmtNumber } from "@/lib/format"
import { useResource } from "@/lib/hooks"
import { refreshHealth, useHealth } from "@/lib/health"
import { subscribeStream, useStreamState } from "@/lib/stream"
import { defineRoute } from "@teyik0/furin"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "网关 · xc-p" }] }))
  .page(() => <GatewayPage />)

export function GatewayPage() {
  const confirm = useConfirm()
  const health = useHealth()
  const stream = useStreamState()
  const [tab, setTab] = useState("conns")

  const gateway = useResource<GatewayConnectionsResponse>(
    "gateway:connections",
    async (signal) => (await unwrap(eden.api.gateway.connections.get({ fetch: { signal } }))) as GatewayConnectionsResponse,
    { pollMs: 8_000 },
  )
  const settings = useResource<SettingsResponse>("gateway:settings", (signal) =>
    unwrap(eden.api.settings.get({ fetch: { signal } })),
  )

  // SSE 网关事件：收到推送后节流刷新，保证「实时」而不打爆接口
  const refreshRef = useRef(gateway.refresh)
  refreshRef.current = gateway.refresh
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeStream((message) => {
      const isGateway =
        message.type === "gateway" ||
        (message.kind ?? "").startsWith("gateway") ||
        message.raw?.activeConns !== undefined ||
        message.raw?.byNode !== undefined
      if (!isGateway || timer) return
      timer = setTimeout(() => {
        timer = null
        refreshRef.current()
      }, 800)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  const data = gateway.data
  const active = data?.active ?? []
  const stats = data?.stats ?? null
  const config = settings.data?.settings.gateway ?? null
  const byNode = useMemo(() => {
    if (stats?.activeByNode && Object.keys(stats.activeByNode).length > 0) return stats.activeByNode
    return data?.byNode ?? {}
  }, [stats, data])
  const byIp = useMemo(() => {
    if (stats?.activeByIp && Object.keys(stats.activeByIp).length > 0) return stats.activeByIp
    return data?.byIp ?? {}
  }, [stats, data])
  const byUser = useMemo(() => countByUser(active), [active])
  const banned = stats?.bannedIps ?? []
  const recent = data?.recent ?? []
  const listen = stats?.listen || health?.gateway.listen || "—"
  const enabled = config?.enabled ?? health?.gateway.enabled ?? null
  const authFailures = stats?.authFailures5m ?? health?.gateway.authFailures5m ?? 0
  const banCount = config?.authFailBanCount ?? 0
  const banSeconds = config?.authFailBanSec ?? 0
  const loading = gateway.loading && !data

  const refreshAll = () => {
    gateway.refresh()
    settings.refresh()
    void refreshHealth(true)
  }

  const kick = async (payload: KickPayload, what: string, affected: number) => {
    await confirm({
      title: "断开" + what + "？",
      description: "网关会立即关闭匹配的 socket，客户端马上感知断开。这是网关独有的能力，Xray 本身无法枚举或断开连接。",
      details: (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">匹配目标</dt>
            <dd className="min-w-0 truncate text-right font-mono">{what}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">将断开连接</dt>
            <dd className="font-semibold text-destructive">{fmtNumber(affected)} 条</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">数据面</dt>
            <dd>不受影响</dd>
          </div>
        </dl>
      ),
      destructive: true,
      confirmText: "断开连接",
      action: async () => {
        const result = await unwrap(eden.api.gateway.kick.post(payload))
        toast.success("已断开 " + fmtNumber(result.closed ?? affected) + " 条连接")
        gateway.refresh()
      },
    })
  }

  const emptyConnections = (
    <div className="flex flex-col items-center gap-4 px-4 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
        <Radio className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium">当前没有已建立的连接</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {enabled === false
            ? "网关当前未启用：请到「监听与限额」打开「启用网关」并保存。"
            : "客户端通过网关 " + listen + " 建立代理连接后会实时出现在这里。可以先用「客户端接入」页的连接串发起一次测试请求。"}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <LoadingButton size="sm" variant="outline" loading={gateway.refreshing} loadingText="刷新中…" onClick={refreshAll}>
          <Radio data-icon="inline-start" />
          刷新
        </LoadingButton>
        <Button size="sm" variant="outline" onClick={() => setTab("config")}>
          检查监听配置
        </Button>
        <Button size="sm" asChild>
          <Link to="/clients">客户端接入</Link>
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="网关"
        description="客户端 → 网关（HTTP CONNECT / SOCKS5 首字节分流）。网关是唯一能枚举连接、踢线与限流的组件。"
        updatedAt={gateway.updatedAt || undefined}
        onRefresh={refreshAll}
        refreshing={gateway.refreshing || settings.refreshing}
        actions={
          <Badge variant="outline" className="gap-1.5 font-normal" title="SSE 实时通道状态；断线时自动降级为 8 秒轮询">
            <Dot tone={stream.connected ? "ok" : "degraded"} pulse={stream.connected} />
            {stream.connected ? "实时推送" : "轮询模式"}
            {stream.lastEventAt ? (
              <span className="text-xs text-muted-foreground">
                · <RelativeTime ts={stream.lastEventAt} />
              </span>
            ) : null}
          </Badge>
        }
      />

      {gateway.error && !data ? (
        <ErrorState error={gateway.error} title="网关连接数据加载失败" onRetry={gateway.refresh} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="活跃连接"
          value={fmtNumber(stats?.activeConns ?? active.length)}
          hint={"监听 " + listen + " · 累计建立 " + fmtNumber(stats?.totalOpened ?? 0)}
          icon={Activity}
          tone={active.length > 0 ? "info" : "idle"}
          loading={loading}
        />
        <StatCard
          label="认证失败（5 分钟）"
          value={fmtNumber(authFailures)}
          hint={banCount > 0 ? "阈值 " + banCount + " 次 · 封禁 " + banSeconds + " 秒" : "未启用自动封禁"}
          icon={ShieldAlert}
          tone={authFailures > 0 ? "degraded" : "ok"}
          loading={loading}
        />
        <StatCard
          label="封禁 IP"
          value={fmtNumber(banned.length)}
          hint={banned.length > 0 ? "到期自动解除，可立即断开其连接" : "当前没有封禁"}
          icon={Ban}
          tone={banned.length > 0 ? "down" : "idle"}
          loading={loading}
        />
        <StatCard
          label="网关监听"
          value={<span className="font-mono text-base">{listen}</span>}
          hint={enabled === null ? "等待配置" : enabled ? "监听中 · HTTP + SOCKS5" : "网关未启用"}
          icon={Radio}
          tone={enabled === false ? "idle" : "ok"}
          loading={loading || (settings.loading && !config)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <BannedList
          ips={banned}
          activeByIp={byIp}
          loading={loading}
          banCount={banCount}
          banSeconds={banSeconds}
          onKick={(payload, what, affected) => void kick(payload, what, affected)}
        />
        <RecentConnections rows={recent} loading={loading} />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="h-auto! w-full flex-wrap justify-start">
          <TabsTrigger value="conns" className="flex-none px-3">
            连接明细
          </TabsTrigger>
          <TabsTrigger value="nodes" className="flex-none px-3">
            按节点
          </TabsTrigger>
          <TabsTrigger value="users" className="flex-none px-3">
            按用户名
          </TabsTrigger>
          <TabsTrigger value="ips" className="flex-none px-3">
            按 IP
          </TabsTrigger>
          <TabsTrigger value="config" className="flex-none px-3">
            监听与限额
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conns">
          <SectionCard
            title="连接明细"
            description="来自网关内存会话表，每 8 秒自动刷新，SSE 推送时即时刷新"
            actions={<Badge variant="secondary">{fmtNumber(active.length)} 条</Badge>}
          >
            <ConnectionsTable
              rows={active}
              loading={loading}
              empty={emptyConnections}
              onKick={(payload, what, affected) => void kick(payload, what, affected)}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="nodes">
          <AggregateTable
            kind="node"
            title="按节点聚合"
            description="断开某节点 = 关闭该节点全部已建立连接；节点本身与其数据面配置不受影响"
            rows={toAggregateRows(byNode)}
            loading={loading}
            emptyTitle="暂无节点连接"
            emptyDescription="有客户端通过某个节点建立连接后，这里会按节点汇总。"
            onKick={(payload, what, affected) => void kick(payload, what, affected)}
          />
        </TabsContent>

        <TabsContent value="users">
          <AggregateTable
            kind="user"
            title="按用户名聚合"
            description="用户名 = 节点 ID 或改名后的别名；旧别名仍可路由（PANEL.md §7.4）"
            rows={toAggregateRows(byUser)}
            loading={loading}
            emptyTitle="暂无用户连接"
            emptyDescription="用户名即节点 ID；有连接后这里会按用户名汇总。"
            onKick={(payload, what, affected) => void kick(payload, what, affected)}
          />
        </TabsContent>

        <TabsContent value="ips">
          <AggregateTable
            kind="ip"
            title="按客户端 IP 聚合"
            description="适合定位单个客户端跑满并发的场景；同 IP 连续认证失败会被封禁"
            rows={toAggregateRows(byIp)}
            loading={loading}
            emptyTitle="暂无客户端 IP"
            emptyDescription="有连接后这里会按客户端 IP 汇总。"
            onKick={(payload, what, affected) => void kick(payload, what, affected)}
          />
        </TabsContent>

        <TabsContent value="config">
          <GatewayConfigForm
            config={config}
            loading={settings.loading}
            error={settings.error}
            onRetry={settings.refresh}
            onSaved={() => {
              settings.refresh()
              gateway.refresh()
              void refreshHealth(true)
            }}
            activeConns={stats?.activeConns ?? active.length}
          />
        </TabsContent>
      </Tabs>

      {gateway.error && data ? (
        <ErrorState error={gateway.error} title="实时连接刷新失败" compact onRetry={gateway.refresh} />
      ) : null}
    </div>
  )
}
