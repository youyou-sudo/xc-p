import { useState } from "react"
import { CircleAlert, KeyRound, RefreshCw, Terminal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/common/code-block"
import { CopyButton } from "@/components/common/copy-button"
import { ErrorState } from "@/components/common/error-state"
import { StatusBadge } from "@/components/common/status-badge"
import { eden, unwrap } from "@/lib/api"
import { fmtMs } from "@/lib/format"
import { useResource } from "@/lib/hooks"
import { allFormatsText, CONNECTION_FORMATS, type ConnectionFormatId } from "./formats"
import { countryLabel, nodeRegion } from "./labels"
import type { ConnectionStrings } from "@/lib/domain"
import { nodeState, type ClientNode } from "./types"

/**
 * 单节点连接串面板：自己拉 /nodes/:id/connection（父组件用 key=nodeId 挂载，
 * 切换节点即重新挂载，从而保证每次都展示「生成中」加载态）。
 */
export function ConnectionPanel({ node }: { node: ClientNode }) {
  const resource = useResource<ConnectionStrings>("clients:connection:" + node.id, (signal) =>
    unwrap(eden.api.nodes({ id: node.id }).connection.get({ fetch: { signal } })),
  )
  const [format, setFormat] = useState<ConnectionFormatId>("http")
  const connection = resource.data
  const regionCode = nodeRegion(node)
  const meta = nodeState(node)

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-4 text-primary" />
          生成连接串
        </CardTitle>
        <CardDescription>
          节点 <span className="font-mono">{node.id}</span>
          {node.username && node.username !== node.id ? (
            <>
              （用户名 <span className="font-mono">{node.username}</span>）
            </>
          ) : null}
          ：用户名 = 节点 ID，密码 = 节点凭据。轮换凭据后旧连接串立即失效。
        </CardDescription>
        <CardAction>
          {connection ? (
            <CopyButton value={allFormatsText(node.id, connection)} label="复制全部格式" variant="outline" size="sm" />
          ) : resource.loading ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" />
              生成中…
            </span>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="font-normal">
            {node.protocol || "未知协议"}
          </Badge>
          {regionCode ? (
            <Badge variant="outline" className="font-normal">
              {countryLabel(regionCode)}
            </Badge>
          ) : null}
          <StatusBadge state={meta} />
          {node.status?.delayMs ? (
            <span className="text-muted-foreground">
              延迟 <span className="tabular-nums">{fmtMs(node.status.delayMs)}</span>
            </span>
          ) : null}
          {node.status?.exitIp ? (
            <span className="text-muted-foreground">
              出口 <span className="font-mono">{node.status.exitIp}</span>
            </span>
          ) : null}
          {node.protocolSupported === false ? (
            <Badge variant="outline" className="border-warning/50 font-normal text-warning">
              协议不可发布
            </Badge>
          ) : null}
          {!node.enabled ? (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              已禁用
            </Badge>
          ) : null}
        </div>

        {resource.loading && !resource.data ? (
          <div className="space-y-2 rounded-lg border p-3" aria-busy="true">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-primary" />
              正在生成 {node.id} 的连接串…
            </p>
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : resource.error && !resource.data ? (
          <ErrorState error={resource.error} title="连接串生成失败" compact onRetry={resource.refresh} />
        ) : connection ? (
          <Tabs value={format} onValueChange={(value) => setFormat(value as ConnectionFormatId)} className="gap-3">
            <TabsList className="h-auto! w-full flex-wrap justify-start gap-1">
              {CONNECTION_FORMATS.map((item) => (
                <TabsTrigger key={item.id} value={item.id} data-testid={"clients-format-" + item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {CONNECTION_FORMATS.map((item) => (
              <TabsContent key={item.id} value={item.id} className="space-y-2">
                <p className="text-xs text-muted-foreground">{item.description}</p>
                <CodeBlock code={item.code(connection)} title={item.label} maxHeight={220} wrap={item.id === "env" || item.id === "docker"} />
              </TabsContent>
            ))}
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                连接串包含明文凭据，等同于该节点的身份。不要贴到公开仓库、聊天群或工单里；需要撤销时在「节点」页轮换该节点凭据。
              </span>
            </div>
          </Tabs>
        ) : null}

        <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <span>
            服务端返回的 <span className="font-mono">docker</span> 是数组，这里逐行展示；<span className="font-mono">env</span> /{" "}
            <span className="font-mono">clash</span> 是多行文本，可直接保存为文件。
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
