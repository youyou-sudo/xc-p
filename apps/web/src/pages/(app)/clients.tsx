import { useEffect, useMemo, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import { useNavigate } from "@teyik0/furin/link"
import { Cable, Globe2, LockKeyhole, Server, Terminal, Waypoints } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/common/page-header"
import { SectionCard } from "@/components/common/section-card"
import { StatCard } from "@/components/common/stat-card"
import { EmptyState } from "@/components/common/empty-state"
import { ConnectionPanel } from "@/components/clients/connection-panel"
import { DirectModeCard, GatewaySummaryCard, SecurityNote } from "@/components/clients/gateway-info"
import { NodePicker } from "@/components/clients/node-picker"
import { authModeLabel } from "@/components/clients/labels"
import {
  clientHost,
  listenPort,
  nodeState,
  type ClientNode,
  type ClientSettings,
} from "@/components/clients/types"
import { eden, unwrap } from "@/lib/api"
import { useResource } from "@/lib/hooks"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "客户端接入 · xc-p" }] }))
  .page(() => <ClientsPage />)

interface NodeListResponse {
  items: ClientNode[]
  total?: number
  updatedAt?: number
}

interface SettingsResponse {
  settings: ClientSettings
}

export function ClientsPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const nodes = useResource<NodeListResponse>(
    "clients:nodes",
    (signal) => unwrap(eden.api.nodes.get({ query: { limit: 500 }, fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const settings = useResource<SettingsResponse>(
    "clients:settings",
    (signal) => unwrap(eden.api.settings.get({ fetch: { signal } })),
    { pollMs: 60_000 },
  )

  const nodeItems = useMemo(() => nodes.data?.items ?? [], [nodes.data])
  const settingsValue = settings.data?.settings

  // 默认选中第一个「启用且协议受支持」的节点；节点被删除/过滤后自动回到可用项。
  useEffect(() => {
    if (nodeItems.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (selectedId && nodeItems.some((node) => node.id === selectedId)) return
    const preferred = nodeItems.find((node) => node.enabled && node.protocolSupported !== false) ?? nodeItems[0]
    setSelectedId(preferred ? preferred.id : null)
  }, [nodeItems, selectedId])

  const selectedNode = nodeItems.find((node) => node.id === selectedId) ?? null
  const gateway = settingsValue?.gateway
  const direct = settingsValue?.direct
  const host = clientHost(settingsValue)
  const port = listenPort(gateway?.listen)
  const scheme = gateway?.tls?.enabled ? "https" : "http"
  const auth = authModeLabel(gateway?.authMode)
  const publishable = nodeItems.filter((node) => node.protocolSupported !== false)
  const enabledCount = nodeItems.filter((node) => node.enabled).length
  const total = nodes.data?.total ?? nodeItems.length
  const selectedState = selectedNode ? nodeState(selectedNode) : ""

  const refreshAll = () => {
    nodes.refresh()
    settings.refresh()
  }

  const goSubscriptions = () => {
    void navigate({ to: "/subscriptions" })
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="客户端接入"
        description="选择节点，生成 HTTP / SOCKS5 / curl / Docker / 环境变量 / Clash 客户端配置并一键复制。用户名 = 节点 ID，密码 = 节点凭据。"
        updatedAt={Math.max(nodes.updatedAt ?? 0, settings.updatedAt ?? 0)}
        onRefresh={refreshAll}
        refreshing={nodes.refreshing || settings.refreshing}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="网关地址"
          value={
            <span className="font-mono text-lg">
              {scheme}://{host}:{port}
            </span>
          }
          hint={"监听 " + (gateway?.listen ?? "加载中…")}
          icon={Globe2}
          tone="info"
          loading={settings.loading && !settings.data}
        />
        <StatCard
          label="可用节点"
          value={publishable.length}
          hint={enabledCount + " 个已启用 · 共 " + total + " 个"}
          icon={Server}
          tone={publishable.length ? "ok" : "idle"}
          loading={nodes.loading && !nodes.data}
        />
        <StatCard
          label="认证方式"
          value={settings.data ? auth.label : "—"}
          hint={settings.data ? auth.hint : "等待配置加载"}
          icon={LockKeyhole}
          tone={auth.tone}
          loading={settings.loading && !settings.data}
        />
        <StatCard
          label="直连模式"
          value={direct?.enabled ? "已开启" : "未开启"}
          hint={direct?.enabled ? direct.listen + " · 能力有降级" : "推荐只用网关模式"}
          icon={Waypoints}
          tone={direct?.enabled ? "degraded" : "idle"}
          loading={settings.loading && !settings.data}
        />
      </div>

      <SecurityNote />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <NodePicker
          nodes={nodeItems}
          loading={nodes.loading}
          error={nodes.error}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRetry={nodes.refresh}
          onGoSubscriptions={goSubscriptions}
        />

        {selectedNode ? (
          <ConnectionPanel key={selectedNode.id} node={selectedNode} />
        ) : (
          <SectionCard title="生成连接串" description="选中左侧任一节点后，这里会展示六种客户端格式。">
            {nodes.error && !nodes.data ? (
              <EmptyState
                icon={Terminal}
                title="节点列表暂不可用"
                description="连接串依赖节点池。请先修复左侧的加载错误，然后重新选择节点。"
                compact
                action={
                  <Button size="sm" variant="outline" onClick={nodes.refresh}>
                    重试
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Cable}
                title={nodes.loading ? "正在读取节点池…" : "还没有可接入的节点"}
                description={
                  nodes.loading
                    ? "节点读取完成后会自动选中一个可用节点。"
                    : "客户端接入依赖节点池：先添加订阅并同步，节点会自动出现在这里。"
                }
                compact
                action={
                  nodes.loading ? undefined : (
                    <Button size="sm" onClick={goSubscriptions}>
                      去添加订阅
                    </Button>
                  )
                }
              />
            )}
          </SectionCard>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GatewaySummaryCard
          settings={settingsValue}
          loading={settings.loading}
          error={settings.error}
          onRetry={settings.refresh}
          onOpenSettings={() => void navigate({ to: "/settings" })}
        />
        <DirectModeCard settings={settingsValue} loading={settings.loading} error={settings.error} onRetry={settings.refresh} />
      </div>

      {selectedNode ? (
        <p className="text-[11px] text-muted-foreground">
          当前选中 <span className="font-mono">{selectedNode.id}</span>（状态 {selectedState}）。若连接失败，请先到「检测」页确认该节点可用。
        </p>
      ) : null}
    </div>
  )
}
