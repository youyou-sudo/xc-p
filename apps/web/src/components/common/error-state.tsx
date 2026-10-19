import { AlertTriangle, RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { describeError } from "@/lib/api"

interface ErrorStateProps {
  error: unknown
  title?: string
  onRetry?: () => void
  compact?: boolean
}

export function ErrorState({ error, title = "加载失败", onRetry, compact }: ErrorStateProps) {
  return (
    <Alert variant="destructive" className={compact ? "py-3" : undefined}>
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all">{describeError(error)}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            重试
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
