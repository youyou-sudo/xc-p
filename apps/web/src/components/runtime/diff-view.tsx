import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { toneBgClass, type Tone } from "@/lib/format"

export interface DiffColumn {
  key: string
  title: string
  hint: string
  tone: Tone
  items: string[]
}

/** 期望 vs 实际四栏：新增 / 变更 / 移除 / 一致。keep 完全不在 ApplyPlan 里。 */
export function DiffView({ columns, loading, maxHeight = 220 }: { columns: DiffColumn[]; loading?: boolean; maxHeight?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {columns.map((column) => (
        <div key={column.key} className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
          <span className={cn("h-1 w-full", toneBgClass(column.tone))} aria-hidden />
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="truncate text-sm font-medium">{column.title}</span>
            {loading ? (
              <Skeleton className="h-5 w-8 rounded-full" />
            ) : (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
                  column.items.length ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                {column.items.length}
              </span>
            )}
          </div>
          <div className="scrollbar-thin flex-1 overflow-auto px-2.5" style={{ maxHeight }}>
            {loading ? (
              <div className="space-y-1.5 py-1">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-5 w-full" />
                ))}
              </div>
            ) : column.items.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">无</p>
            ) : (
              <ul className="space-y-1 py-1">
                {column.items.map((item) => (
                  <li key={item} className="truncate rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px] leading-4" title={item}>
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="border-t bg-muted/20 px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">{column.hint}</p>
        </div>
      ))}
    </div>
  )
}
