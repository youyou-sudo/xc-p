import type { ErrorProps } from "@teyik0/furin"
import { RotateCcw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"

/** (app) 段错误边界：页面渲染异常时保底，避免整页空白。 */
export default function AppError({ error, reset }: ErrorProps) {
  return (
    <div role="alert" className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10">
        <TriangleAlert className="size-7 text-destructive" />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">页面加载出错</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          这通常是网络抖动或接口暂时不可用。可以重试；如果持续出现，请查看服务端日志。
        </p>
        <p className="font-mono text-xs text-muted-foreground">错误 ID：{error.digest}</p>
      </div>
      <Button onClick={() => reset()}>
        <RotateCcw data-icon="inline-start" />
        重试
      </Button>
    </div>
  )
}
