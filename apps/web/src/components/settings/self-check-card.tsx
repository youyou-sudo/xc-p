import { useState } from "react"
import { Activity, Globe2, PlugZap, Server } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { Dot } from "@/components/common/status-badge"
import { eden, unwrap } from "@/lib/api"
import type { SettingsTestResult } from "@/lib/domain"
import { fmtTime } from "@/lib/format"

interface SelfCheckResult {
  target: string
  items: SettingsTestResult[]
  at: number
}

const TARGETS = [
  { id: "xray", label: "数据面与 API", description: "xray 二进制版本 + API（lso）可达性", icon: Server },
  { id: "ports", label: "端口池可 bind", description: "端口池前 8 个端口逐个 bind 测试", icon: PlugZap },
  { id: "ipecho", label: "IP 查询源", description: "逐个请求 detect.ipEchoUrls", icon: Globe2 },
] as const

/**
 * 「测试」按钮：POST /api/settings/test。
 * 注意：服务端用当前已保存的 settings 执行测试，所以先保存再测试。
 */
export function SelfCheckCard() {
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<SelfCheckResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [failedTarget, setFailedTarget] = useState("xray")

  const run = async (target: string) => {
    setRunning(target)
    setFailedTarget(target)
    setError(null)
    try {
      const response = await unwrap(eden.api.settings.test.post({ what: target }))
      const items = response.results ?? []
      setResult({ target, items, at: Date.now() })
      const failed = items.filter((item) => !item.ok).length
      if (items.length === 0) {
        toast.info("测试完成，但没有返回结果")
      } else if (failed === 0) {
        toast.success("自检通过：全部 " + items.length + " 项正常")
      } else {
        toast.error("自检有 " + failed + " 项失败", { description: "详情见下方结果列表。" })
      }
    } catch (caught) {
      setError(caught)
      setResult(null)
      toast.error("测试请求失败")
    } finally {
      setRunning(null)
    }
  }

  const passed = result?.items.filter((item) => item.ok).length ?? 0
  const failed = (result?.items.length ?? 0) - passed

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          系统自检
        </CardTitle>
        <CardDescription>
          按需对数据面、端口池与 IP 查询源做只读探测（POST /api/settings/test）。测试使用服务端当前<strong>已保存</strong>的配置，改完参数请先保存再测试。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {TARGETS.map((target) => {
            const Icon = target.icon
            return (
              <div key={target.id} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-primary" />
                  <span className="text-sm font-medium">{target.label}</span>
                </div>
                <p className="min-h-8 flex-1 text-xs text-muted-foreground">{target.description}</p>
                <LoadingButton
                  size="sm"
                  variant="outline"
                  className="w-full"
                  loading={running === target.id}
                  loadingText="测试中…"
                  disabled={running !== null}
                  onClick={() => void run(target.id)}
                >
                  运行测试
                </LoadingButton>
              </div>
            )
          })}
        </div>

        {error ? <ErrorState error={error} title="自检请求失败" compact onRetry={() => void run(failedTarget)} /> : null}

        {result ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {TARGETS.find((target) => target.id === result.target)?.label ?? result.target} · 共 {result.items.length} 项
              </span>
              <span className={failed > 0 ? "text-destructive" : "text-success"}>
                {passed} 项通过{failed > 0 ? " · " + failed + " 项失败" : ""} · {fmtTime(result.at)}
              </span>
            </div>
            {result.items.length === 0 ? (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                测试完成但服务端没有返回结果项，请查看服务端日志。
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {result.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-2.5 px-3 py-2">
                    <Dot tone={item.ok ? "ok" : "down"} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{item.label}</p>
                      {item.detail ? (
                        <p className="break-all font-mono text-[11px] text-muted-foreground">{item.detail}</p>
                      ) : null}
                    </div>
                    <Badge
                      variant="outline"
                      className={"shrink-0 font-normal " + (item.ok ? "border-success/40 text-success" : "border-destructive/40 text-destructive")}
                    >
                      {item.ok ? "通过" : "失败"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : running ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
