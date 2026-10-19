import type { NotFoundProps } from "@teyik0/furin"
import { Link } from "@teyik0/furin/link"
import { ArrowLeft, Compass } from "lucide-react"

/**
 * Furin 路由级 404 边界（默认导出）。
 * 直接访问未知路径时服务端返回内置 404 文档；客户端导航到未知路由时由这个边界渲染。
 */
export default function NotFound({ error }: NotFoundProps) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        <Compass className="size-7 text-muted-foreground" />
      </span>
      <div className="space-y-2">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">页面不存在</h1>
        <p className="max-w-md text-sm text-muted-foreground">{error?.message || "这个地址没有对应的面板页面。"}</p>
      </div>
      <Link
        to="/"
        className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
      >
        <ArrowLeft className="size-4" />
        返回概览
      </Link>
    </div>
  )
}
