import type { ReactNode } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { Topbar } from "@/components/layout/topbar"
import { PANEL_VERSION } from "@/lib/nav"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <Topbar />
          <div className="mx-auto w-full max-w-[1500px] flex-1 space-y-6 p-4 md:p-6">{children}</div>
          <footer className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-2 px-4 pb-5 text-[11px] text-muted-foreground md:px-6">
            <span>xc-p · Xray-core 节点池管理面板</span>
            <span className="font-mono">v{PANEL_VERSION}</span>
          </footer>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export function BootSplash({ label = "正在校验会话…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background">
      <div className="flex size-10 items-center justify-center rounded-md bg-primary font-mono text-lg font-bold text-primary-foreground">
        s
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {label}
      </div>
    </div>
  )
}
