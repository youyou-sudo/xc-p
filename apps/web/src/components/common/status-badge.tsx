import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { stateMeta, toneBgClass, type Tone } from "@/lib/format"

interface StatusBadgeProps {
  state?: string | null
  label?: string
  tone?: Tone
  className?: string
  pulse?: boolean
}

export function StatusBadge({ state, label, tone, className, pulse }: StatusBadgeProps) {
  const meta = stateMeta(state)
  const resolvedTone = tone ?? meta.tone
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", toneBgClass(resolvedTone), pulse && "animate-pulse")} />
      {label ?? meta.label}
    </Badge>
  )
}

export function Dot({ tone = "idle", pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn("inline-block size-2 rounded-full", toneBgClass(tone), pulse && "animate-pulse", className)} />
}
