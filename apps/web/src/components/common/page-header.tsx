import type { ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { fmtRelative } from "@/lib/format"
import { useNow } from "@/lib/hooks"

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  updatedAt?: number
  onRefresh?: () => void
  refreshing?: boolean
}

export function PageHeader({
  title,
  description,
  actions,
  updatedAt,
  onRefresh,
  refreshing = false,
}: PageHeaderProps) {
  const now = useNow(10_000)
  return (
    <div className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
        {updatedAt ? (
          <p className="text-xs text-muted-foreground">
            数据更新于 <span className="tabular-nums">{fmtRelative(updatedAt, now)}</span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRefresh ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            data-loading={refreshing || undefined}
            aria-busy={refreshing || undefined}
          >
            {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {refreshing ? "刷新中…" : "刷新"}
          </Button>
        ) : null}
        {actions}
      </div>
    </div>
  )
}
