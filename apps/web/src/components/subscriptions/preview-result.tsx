import type { ReactNode } from "react"
import { ChevronDown, FileWarning, Rss } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/common/empty-state"
import { cn } from "@/lib/utils"
import { toneTextClass, type Tone } from "@/lib/format"
import { formatHintLabel } from "./format"
import type { PreviewResponse } from "./types"

/** 解析预览 / 测试解析的结果面板：diff 计数 + 节点样本 + 解析错误样本。 */
export function PreviewResult({ result }: { result: PreviewResponse }) {
  const nodes = result.nodes.slice(0, 50)
  const errors = result.errors ?? []
  const diff = result.diff
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter label="识别格式" value={result.format ? formatHintLabel(result.format, { short: true }) : "—"} hint={result.format} />
        <Counter label="解析节点" value={result.total} hint={result.supported + " 个可发布"} tone="info" />
        <Counter label="新增" value={diff.added} hint="当前节点池中不存在" tone={diff.added ? "ok" : "idle"} />
        <Counter label="保持不变" value={diff.unchanged} hint="指纹已存在" />
        <Counter label="将消失" value={diff.removed} hint="本次未出现（不落库）" tone={diff.removed ? "degraded" : "idle"} />
        <Counter label="不支持协议" value={diff.unsupported || result.unsupported} hint="不会进入发布快照" tone={diff.unsupported || result.unsupported ? "degraded" : "idle"} />
        <Counter label="解析错误" value={errors.length} hint={errors.length ? "见下方样本" : "无"} tone={errors.length ? "down" : "idle"} />
        <Counter label="节点样本" value={nodes.length} hint={"最多展示 50 / 共 " + result.total} />
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Rss className="size-3.5" />
            节点样本
          </span>
          <span>预览与测试均不写库、不改期望状态</span>
        </div>
        {nodes.length === 0 ? (
          <EmptyState
            icon={FileWarning}
            title="没有解析出节点"
            description="检查「格式提示」是否与文本匹配，或确认粘贴的是完整的订阅内容。"
            compact
          />
        ) : (
          <div className="scrollbar-thin max-h-64 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>名称</TableHead>
                  <TableHead>协议</TableHead>
                  <TableHead>服务器</TableHead>
                  <TableHead className="hidden sm:table-cell">端口</TableHead>
                  <TableHead className="text-right">可发布</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((node, index) => (
                  <TableRow key={(node.fingerprint ?? node.server + ":" + node.port) + ":" + index}>
                    <TableCell className="max-w-40 truncate font-medium" title={node.name || node.raw}>
                      {node.name || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[11px] uppercase">
                        {node.protocol}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-44 truncate font-mono text-xs" title={node.server}>
                      {node.server}
                    </TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">{node.port}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn("text-xs font-medium", node.protocolSupported ? "text-success" : "text-warning")}>
                        {node.protocolSupported ? "可发布" : "不支持"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {errors.length ? (
        <Collapsible className="overflow-hidden rounded-lg border">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="flex h-auto w-full items-center justify-between gap-2 rounded-none px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-destructive">
                <FileWarning className="size-3.5" />
                解析错误样本（{errors.length}）
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="scrollbar-thin max-h-52 overflow-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-16">行号</TableHead>
                    <TableHead className="w-32">类型</TableHead>
                    <TableHead>说明</TableHead>
                    <TableHead className="hidden md:table-cell">片段</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((error, index) => (
                    <TableRow key={index}>
                      <TableCell className="tabular-nums text-xs text-muted-foreground">{error.lineNo ?? "—"}</TableCell>
                      <TableCell className="font-mono text-[11px] text-destructive">{error.errorKind || "—"}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs" title={error.errorMsg}>
                        {error.errorMsg || "—"}
                      </TableCell>
                      <TableCell className="hidden max-w-52 truncate font-mono text-[11px] text-muted-foreground md:table-cell" title={error.rawSnippet}>
                        {error.rawSnippet || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}

function Counter({ label, value, hint, tone = "idle" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-base font-semibold tabular-nums", toneTextClass(tone))}>{value}</p>
      {hint ? <p className="truncate text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
