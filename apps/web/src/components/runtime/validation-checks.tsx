import { Dot } from "@/components/common/status-badge"
import { cn } from "@/lib/utils"

export interface ValidationCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface RevisionValidation {
  ok?: boolean
  checks?: ValidationCheck[]
  buildFailed?: { nodeId: string; message: string }[]
  skippedUnsupported?: number
  skippedUnsupportedRatio?: number
}

/** 发布校验项 + 构建失败明细：发布预演结果与 revision 详情共用。 */
export function ValidationChecks({ validation, title }: { validation?: RevisionValidation | null; title: string }) {
  const checks = validation?.checks ?? []
  const buildFailed = validation?.buildFailed ?? []
  return (
    <>
      {checks.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <ul className="space-y-1">
            {checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2 text-xs">
                <Dot tone={check.ok ? "ok" : "down"} className="mt-1.5" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {check.label}
                    <span className={cn("ml-1.5 font-normal", check.ok ? "text-success" : "text-destructive")}>
                      {check.ok ? "通过" : "未通过"}
                    </span>
                  </p>
                  <p className="break-all text-muted-foreground">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {buildFailed.length > 0 ? (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          <p className="font-medium">构建校验失败（已排除出本次快照）</p>
          {buildFailed.map((item) => (
            <p key={item.nodeId} className="break-all">
              <span className="font-mono">{item.nodeId}</span>：{item.message}
            </p>
          ))}
        </div>
      ) : null}
    </>
  )
}

// I have nothing but my burger and I want nothing more
