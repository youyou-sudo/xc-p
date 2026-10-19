import { CheckCircle2, Eye, Upload, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LoadingButton } from "@/components/common/loading-button"
import { Dot } from "@/components/common/status-badge"
import { ValidationChecks, type RevisionValidation } from "@/components/runtime/validation-checks"
import { fmtNumber } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface PublishPreviewResult {
  dryRun?: boolean
  ok?: boolean
  revisionId?: string
  summary?: { add?: number; change?: number; remove?: number; keep?: number; drift?: number }
  error?: string | null
  validation?: RevisionValidation | null
}

/** 发布预演（dryRun）结果：summary + validation，确认后再正式发布。 */
export function PublishPreviewCard({
  preview,
  publishing,
  onPublish,
  onClear,
}: {
  preview: PublishPreviewResult
  publishing: boolean
  onPublish: () => void
  onClear: () => void
}) {
  const summary = preview.summary ?? {}
  const ok = preview.ok !== false && preview.validation?.ok !== false
  return (
    <Card className={cn("gap-4 border-l-4", ok ? "border-l-success" : "border-l-destructive")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="size-4 text-primary" />
          发布预演结果
          <Badge variant="outline" className={cn("gap-1 font-normal", ok ? "text-success" : "text-destructive")}>
            {ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
            {ok ? "校验通过" : "校验未通过"}
          </Badge>
        </CardTitle>
        <CardDescription>dryRun 只做快照、校验与 ApplyPlan 计算，不会对数据面做任何改动。</CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={onClear}>
            清除
          </Button>
          <LoadingButton size="sm" loading={publishing} loadingText="发布中…" disabled={!ok} onClick={onPublish}>
            <Upload data-icon="inline-start" />
            正式发布
          </LoadingButton>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <SummaryTile label="新增" value={summary.add ?? 0} tone="ok" />
          <SummaryTile label="变更" value={summary.change ?? 0} tone="degraded" />
          <SummaryTile label="移除" value={summary.remove ?? 0} tone="down" />
          <SummaryTile label="一致" value={summary.keep ?? 0} tone="idle" />
          <SummaryTile label="漂移" value={summary.drift ?? 0} tone={summary.drift ? "degraded" : "idle"} />
        </div>

        {preview.error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
            {preview.error}
          </p>
        ) : null}

        <ValidationChecks validation={preview.validation} title="校验项" />
      </CardContent>
    </Card>
  )
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: "ok" | "degraded" | "down" | "idle" }) {
  return (
    <div className="rounded-md border px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Dot tone={tone} />
        {label}
      </div>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{fmtNumber(value)}</p>
    </div>
  )
}
