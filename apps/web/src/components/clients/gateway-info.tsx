import { CircleAlert, Radio, ShieldAlert, Waypoints } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ErrorState } from "@/components/common/error-state"
import { InfoGrid } from "@/components/common/section-card"
import { authModeLabel } from "./labels"
import { clientHost, isWildcardHost, listenPort, type ClientSettings } from "./types"

interface GatewayCardProps {
  settings: ClientSettings | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  onOpenSettings: () => void
}

/** 网关入口摘要（GET /api/settings 的 gateway / panel 段）。 */
export function GatewaySummaryCard({ settings, loading, error, onRetry, onOpenSettings }: GatewayCardProps) {
  const gateway = settings?.gateway
  const direct = settings?.direct
  const host = clientHost(settings)
  const port = listenPort(gateway?.listen)
  const scheme = gateway?.tls?.enabled ? "https" : "http"
  const auth = authModeLabel(gateway?.authMode)
  const protocols = [gateway?.protocols?.http ? "HTTP" : "", gateway?.protocols?.socks5 ? "SOCKS5" : ""].filter(Boolean)
  const wildcard = gateway?.listen ? isWildcardHost(gateway.listen.slice(0, gateway.listen.lastIndexOf(":"))) : false

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4 text-primary" />
          网关入口
        </CardTitle>
        <CardDescription>客户端统一访问的入口；连接串里的主机名来自「系统设置 → 面板 → baseUrl」。</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            调整配置
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !settings ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : error && !settings ? (
          <ErrorState error={error} title="网关配置加载失败" compact onRetry={onRetry} />
        ) : settings ? (
          <>
            <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground">客户端地址</p>
              <p className="truncate font-mono text-sm font-medium">
                {scheme}://{host}:{port}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {gateway?.tls?.enabled ? "已启用网关 TLS，客户端用 https 前缀" : "未启用 TLS：凭据在传输中是明文，建议只在内网/VPN 暴露"}
              </p>
            </div>
            <InfoGrid
              columns={2}
              items={[
                { label: "网关监听", value: <span className="font-mono">{gateway?.listen ?? "—"}</span>, hint: wildcard ? "0.0.0.0 表示所有网卡，客户端请填宿主可达地址" : undefined },
                {
                  label: "认证模式",
                  value: (
                    <span className={auth.tone === "degraded" ? "text-warning" : "text-success"}>{auth.label}</span>
                  ),
                  hint: auth.hint,
                },
                { label: "开放协议", value: protocols.length ? protocols.join(" · ") : "未开放" },
                { label: "网关状态", value: gateway?.enabled ? "已启用" : "已禁用" },
                { label: "TLS", value: gateway?.tls?.enabled ? "已开启" : "未开启" },
                {
                  label: "直连模式",
                  value: direct?.enabled ? "已开启" : "未开启",
                  hint: direct?.enabled ? direct.listen + " · " + direct.socksListen : "推荐只用网关模式",
                },
              ]}
            />
            {gateway?.enabled === false ? (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>网关当前已禁用，客户端连接串不可用。到「系统设置 → 网关」开启后会重建 listener。</span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-normal">
                认证 {gateway?.authMode ?? "strict"}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {gateway?.maxConcurrentPerUser ?? "—"} 并发/用户
              </Badge>
              <Badge variant="outline" className="font-normal">
                {gateway?.maxConcurrentPerIp ?? "—"} 并发/IP
              </Badge>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

const DEGRADATION_ROWS: { capability: string; gateway: string; direct: string }[] = [
  { capability: "凭据轮换生效速度", gateway: "立即（网关内存）", direct: "需重载数据面，短暂断开新连接" },
  { capability: "主动断开指定用户", gateway: "支持（网关按连接踢线）", direct: "不支持" },
  { capability: "按用户并发 / 限流", gateway: "支持（每用户 + 每 IP）", direct: "只能按入站级策略" },
  { capability: "按用户流量统计", gateway: "网关自行统计", direct: "仅 HTTP 入站整体统计" },
  { capability: "额外一跳延迟", gateway: "+0.1~0.3 ms（环回）", direct: "0" },
  { capability: "连接明细可观测性", gateway: "面板「网关」页可见", direct: "仅能看 Xray 日志" },
]

/** 直连模式的能力降级说明（PANEL.md §10.3）。 */
export function DirectModeCard({ settings, loading, error, onRetry }: Omit<GatewayCardProps, "onOpenSettings">) {
  const direct = settings?.direct
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Waypoints className="size-4 text-primary" />
          直连模式降级说明
        </CardTitle>
        <CardDescription>
          {direct?.enabled
            ? "直连模式已开启（额外监听 " + direct.listen + " / " + direct.socksListen + "）：它只是网关故障时的旁路，能力有明确降级。"
            : "当前未开启直连模式（推荐）。下表说明一旦开启会失去哪些能力。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !settings ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : error && !settings ? (
          <ErrorState error={error} title="直连配置加载失败" compact onRetry={onRetry} />
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>能力</TableHead>
                  <TableHead>网关模式</TableHead>
                  <TableHead>直连模式</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DEGRADATION_ROWS.map((row) => (
                  <TableRow key={row.capability}>
                    <TableCell className="text-xs font-medium whitespace-normal">{row.capability}</TableCell>
                    <TableCell className="text-xs whitespace-normal text-muted-foreground">{row.gateway}</TableCell>
                    <TableCell className="text-xs whitespace-normal text-warning">{row.direct}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 安全提示：凭据即身份。 */
export function SecurityNote() {
  return (
    <Alert className="border-warning/40 bg-warning/10">
      <ShieldAlert className="text-warning" />
      <AlertTitle className="text-warning">安全提示</AlertTitle>
      <AlertDescription className="text-warning/90">
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>连接串里的用户名 / 密码等同于该节点的身份：拿到它就能以该节点出网，请按密码保管，不要公开分享。</li>
          <li>HTTP 代理的 Basic 凭据是明文：尽量只在 Docker 内网、VPN 或内网暴露网关端口；需要公网暴露时开启网关 TLS 或在前置反代做 TCP + TLS 终止。</li>
          <li>数据面管理口（xray.apiAddress / metricsListen）与环回入站一律只绑 127.0.0.1，面板建议只在内网或反代后访问。</li>
          <li>怀疑泄漏时：到「节点」页轮换凭据或在「网关」页踢掉连接；旧连接串会在下一次请求时失效。</li>
        </ul>
      </AlertDescription>
    </Alert>
  )
}
