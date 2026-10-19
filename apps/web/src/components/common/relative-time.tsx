import { fmtRelative, fmtTime } from "@/lib/format"
import { useNow } from "@/lib/hooks"
import { cn } from "@/lib/utils"

export function RelativeTime({ ts, className }: { ts?: number | null; className?: string }) {
  const now = useNow(10_000)
  return (
    <span className={cn("tabular-nums", className)} title={fmtTime(ts)}>
      {fmtRelative(ts, now)}
    </span>
  )
}

export function TimeText({ ts, className }: { ts?: number | null; className?: string }) {
  return (
    <span className={cn("tabular-nums", className)} title={fmtRelative(ts)}>
      {fmtTime(ts)}
    </span>
  )
}
