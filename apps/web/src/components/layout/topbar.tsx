import { useState } from "react"
import { Link, useNavigate } from "@teyik0/furin/link"
import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Settings, Sun, UserRound } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Dot } from "@/components/common/status-badge"
import { useAction } from "@/lib/hooks"
import { APP_NAME, routeMeta, usePathname } from "@/lib/nav"
import { useHealth } from "@/lib/health"
import { logout, useSession } from "@/lib/session"
import { useStreamState } from "@/lib/stream"
import { useTheme, type ThemeMode } from "@/lib/theme"
import { cn } from "@/lib/utils"

export function Topbar() {
  const pathname = usePathname()
  const meta = routeMeta(pathname)
  const health = useHealth()
  const stream = useStreamState()
  const session = useSession()
  const navigate = useNavigate()
  const { mode, theme, setMode } = useTheme()
  const [modeOpen, setModeOpen] = useState(false)
  const logoutAction = useAction(async () => {
    toast.loading("正在退出…", { id: "xcp-logout" })
    try {
      await logout()
      toast.success("已退出登录", { id: "xcp-logout" })
    } catch (error) {
      toast.error("退出失败", { id: "xcp-logout", description: error instanceof Error ? error.message : String(error) })
    }
    await navigate({ to: "/login", replace: true })
  })

  const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor },
  ]

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink asChild>
              <Link to="/">{APP_NAME}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden md:block" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate">{meta.title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="mr-0.5 hidden items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] text-muted-foreground sm:flex"
              aria-live="polite"
            >
              <Dot tone={stream.connected ? "ok" : "degraded"} pulse={stream.connected} />
              {stream.connected ? "实时" : "轮询"}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {stream.connected ? "SSE 实时通道已连接，任务进度会即时推送" : "SSE 未连接，已降级为轮询 /api/jobs"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="hidden gap-2 md:inline-flex" onClick={() => void navigate({ to: "/runtime" })}>
              <Dot
                tone={health ? (health.xray.status === "running" ? "ok" : "degraded") : "idle"}
                pulse={health?.xray.status === "running"}
              />
              <span className="text-xs text-muted-foreground">数据面</span>
              <span className="text-xs font-medium">
                {health ? (health.xray.status === "running" ? "运行中" : health.xray.status) : "未知"}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {health
              ? "API " + health.xray.api + " · 延迟 " + health.xray.apiLatencyMs + "ms · tag " + health.xray.tagCount
              : "正在获取健康状态…"}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu open={modeOpen} onOpenChange={setModeOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="切换主题">
              {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuGroup>
              <DropdownMenuLabel>主题</DropdownMenuLabel>
              {themeOptions.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setMode(option.value)}>
                  <option.icon />
                  {option.label}
                  <Check className={cn("ml-auto size-4", mode === option.value ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-1.5" aria-label="账户菜单">
              <Avatar className="size-7">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {(session.username || "A").slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-28 truncate text-xs font-medium sm:inline">{session.username || "admin"}</span>
              <ChevronsUpDown className="hidden size-3.5 text-muted-foreground sm:inline" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="flex items-center gap-2 font-normal">
              <UserRound className="size-4 text-muted-foreground" />
              <div className="grid leading-tight">
                <span className="text-sm font-medium">{session.username || "admin"}</span>
                <span className="text-[11px] text-muted-foreground">管理员</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void navigate({ to: "/settings" })}>
              <Settings />
              系统设置
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={logoutAction.pending}
              onClick={() => void logoutAction.run()}
            >
              {logoutAction.pending ? <Spinner /> : <LogOut />}
              {logoutAction.pending ? "退出中…" : "退出登录"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
