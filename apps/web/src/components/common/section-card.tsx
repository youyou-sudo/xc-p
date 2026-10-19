import type { ReactNode } from "react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface SectionCardProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: SectionCardProps) {
  return (
    <Card className={cn("gap-4 shadow-xs", className)}>
      {title || description || actions ? (
        <CardHeader>
          {title ? <CardTitle>{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
          {actions ? <CardAction className="flex flex-wrap items-center gap-2">{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent className="px-6">{children}</CardContent>
    </Card>
  )
}

export function InfoGrid({ items, columns = 2 }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; columns?: 2 | 3 | 4 }) {
  const cols = columns === 2 ? "sm:grid-cols-2" : columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-4", cols)}>
      {items.map((item, index) => (
        <div key={index} className="min-w-0 space-y-1">
          <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className="truncate text-sm font-medium tabular-nums">{item.value}</dd>
          {item.hint ? <p className="truncate text-xs text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  )
}
