import type { ReactNode } from "react"
import { CopyButton } from "@/components/common/copy-button"
import { cn } from "@/lib/utils"

interface CodeBlockProps {
  code: string
  title?: ReactNode
  language?: string
  className?: string
  maxHeight?: number
  wrap?: boolean
}

export function CodeBlock({ code, title, language, className, maxHeight = 260, wrap = false }: CodeBlockProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/30", className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1.5">
        <span className="truncate font-mono text-xs text-muted-foreground">{title ?? language ?? "text"}</span>
        <CopyButton value={code} iconOnly size="xs" variant="ghost" />
      </div>
      <pre
        className={cn("scrollbar-thin overflow-auto p-3 font-mono text-xs leading-relaxed", wrap && "whitespace-pre-wrap break-all")}
        style={{ maxHeight }}
      >
        {code}
      </pre>
    </div>
  )
}
