import { Link } from "@teyik0/furin/link"
import { Activity, ShieldCheck } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Dot } from "@/components/common/status-badge"
import { useHealth } from "@/lib/health"
import { useStreamState } from "@/lib/stream"
import { APP_NAME, APP_TAGLINE, NAV_GROUPS, PANEL_VERSION, usePathname } from "@/lib/nav"
import { cn } from "@/lib/utils"

export function AppSidebar() {
  const pathname = usePathname()
  const health = useHealth()
  const stream = useStreamState()

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" className="gap-2.5">
              <Link to="/" aria-label={APP_NAME}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground shadow-sm">
                  s
                </span>
                <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-sm font-semibold">{APP_NAME}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{APP_TAGLINE}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="scrollbar-thin">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = pathname === item.to
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <Link to={item.to} aria-current={active ? "page" : undefined}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="group-data-[collapsible=icon]:hidden">
          <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                数据面
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <Dot
                  tone={health ? (health.overall === "ok" ? "ok" : "degraded") : "idle"}
                  pulse={health?.xray.status === "running"}
                />
                {health ? (health.overall === "ok" ? "正常" : "降级") : "未知"}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Activity className="size-3.5" />
                实时通道
              </span>
              <span className={cn("flex items-center gap-1.5", stream.connected ? "text-success" : "text-muted-foreground")}>
                <Dot tone={stream.connected ? "ok" : "idle"} pulse={stream.connected} />
                {stream.connected ? "已连接" : "重连中"}
              </span>
            </div>
          </div>
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">版本 v{PANEL_VERSION}</p>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
