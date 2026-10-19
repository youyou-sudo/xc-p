import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface LoadingButtonProps extends ComponentProps<typeof Button> {
  loading?: boolean
  loadingText?: ReactNode
  icon?: ReactNode
}

/** 所有异步按钮统一走这里：点击立即进入加载态并禁用，避免重复提交。 */
export function LoadingButton({
  loading = false,
  loadingText,
  icon,
  children,
  disabled,
  className,
  ...props
}: LoadingButtonProps) {
  return (
    <Button data-loading={loading || undefined} aria-busy={loading || undefined} disabled={disabled || loading} className={className} {...props}>
      {loading ? <Spinner data-icon="inline-start" /> : icon}
      {loading ? (loadingText ?? children) : children}
    </Button>
  )
}
