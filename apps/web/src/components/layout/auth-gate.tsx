import { useEffect, type ReactNode } from "react"
import { useNavigate } from "@teyik0/furin/link"
import { AppShell, BootSplash } from "@/components/layout/app-shell"
import { startHealthLoop } from "@/lib/health"
import { bootstrapSession, useSession } from "@/lib/session"
import { connectStream as connectRealtime } from "@/lib/stream"

export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    void bootstrapSession()
  }, [])

  useEffect(() => {
    if (session.status === "anon") {
      void navigate({ to: "/login", replace: true })
    }
  }, [session.status, navigate])

  useEffect(() => {
    if (session.status !== "authed") return
    const stopHealth = startHealthLoop()
    const stopStream = connectRealtime()
    return () => {
      stopHealth()
      stopStream()
    }
  }, [session.status])

  if (session.status === "authed") return <AppShell>{children}</AppShell>
  if (session.status === "anon") return <BootSplash label="未登录，正在跳转到登录页…" />
  return <BootSplash />
}
