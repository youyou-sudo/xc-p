import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { JobProgress as JobProgressState } from "@/lib/use-job"
import { cn } from "@/lib/utils"

export function JobProgress({ job, onCancel, className }: { job: JobProgressState | null; onCancel?: () => void; className?: string }) {
  if (!job) return null
  const total = job.total && job.total > 0 ? job.total : undefined
  const percent = total ? Math.min(100, Math.round((job.progress / total) * 100)) : job.status === "ok" ? 100 : undefined
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs", className)}>
      <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-primary" aria-hidden />
      <span className="font-medium">{job.label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {job.message || "执行中…"}
        {total ? " · " + job.progress + "/" + total : ""}
      </span>
      <Progress value={percent} className="h-1.5 w-32" />
      {onCancel ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCancel}>
          <X data-icon="inline-start" />
          取消
        </Button>
      ) : null}
    </div>
  )
}
