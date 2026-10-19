import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { toneTextClass, type Tone } from "@/lib/format"

interface StatCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: LucideIcon
  tone?: Tone
  loading?: boolean
  onClick?: () => void
  className?: string
}

export function StatCard({ label, value, hint, icon: Icon, tone = "idle", loading, onClick, className }: StatCardProps) {
  const interactive = !!onClick
  return (
    <Card
      className={cn(
        "gap-0 py-0 shadow-xs transition-colors",
        interactive && "cursor-pointer hover:border-primary/40 hover:bg-accent/40",
        className,
      )}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
          )}
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
        {Icon ? (
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60", toneTextClass(tone))}>
            <Icon className="size-4.5" />
          </span>
        ) : null}
      </CardContent>
    </Card>
  )
}
