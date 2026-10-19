import type { ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopy } from "@/lib/hooks"
import { cn } from "@/lib/utils"

interface CopyButtonProps {
  value: string
  label?: ReactNode
  size?: "sm" | "default" | "xs"
  variant?: "ghost" | "outline" | "default" | "secondary"
  className?: string
  iconOnly?: boolean
}

export function CopyButton({ value, label, variant = "ghost", size = "sm", className, iconOnly }: CopyButtonProps) {
  const { copy, copied } = useCopy()
  return (
    <Button
      type="button"
      variant={variant}
      size={size === "xs" ? "sm" : size}
      className={cn(size === "xs" && "h-7 px-2 text-xs", className)}
      onClick={() => void copy(value, "copy")}
      title={copied === "copy" ? "已复制" : "复制到剪贴板"}
    >
      {copied === "copy" ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {iconOnly ? <span className="sr-only">复制</span> : copied === "copy" ? "已复制" : (label ?? "复制")}
    </Button>
  )
}
