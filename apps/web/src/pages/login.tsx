import { useEffect, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import { useNavigate } from "@teyik0/furin/link"
import { Eye, EyeOff, Server, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { BootSplash } from "@/components/layout/app-shell"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError } from "@/lib/api"
import { useAction } from "@/lib/hooks"
import { APP_NAME, APP_TAGLINE, PANEL_VERSION } from "@/lib/nav"
import { bootstrapSession, login, useSession } from "@/lib/session"
import { route as rootRoute } from "./root"

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "登录 · " + APP_NAME }] }))
  .page(() => <LoginPage />)

function LoginPage() {
  const session = useSession()
  const navigate = useNavigate()
  const [username, setUsername] = useState("admin")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    void bootstrapSession()
  }, [])

  useEffect(() => {
    if (session.status === "authed") void navigate({ to: "/", replace: true })
  }, [session.status, navigate])

  const action = useAction(async () => {
    if (!username.trim() || !password) {
      setInvalid(true)
      throw new Error("请输入管理员账号与口令")
    }
    setInvalid(false)
    await login(username.trim(), password)
    toast.success("登录成功", { description: "欢迎回来，" + username.trim() })
  })

  if (session.status === "loading" || session.status === "authed") {
    return <BootSplash label={session.status === "authed" ? "已登录，正在进入面板…" : "正在检查会话…"} />
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Server className="size-4" />
          </span>
          <span className="grid text-left leading-tight">
            <span className="text-sm font-semibold">{APP_NAME}</span>
            <span className="text-xs text-muted-foreground">{APP_TAGLINE}</span>
          </span>
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">登录控制面</CardTitle>
            <CardDescription>使用管理员账号与口令进入面板。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void action.run().catch(() => {})
              }}
              className="flex flex-col gap-6"
            >
              <FieldGroup>
                <Field data-invalid={invalid && !username.trim()}>
                  <FieldLabel htmlFor="username">管理员账号</FieldLabel>
                  <Input
                    id="username"
                    value={username}
                    autoComplete="username"
                    autoFocus
                    onChange={(event) => setUsername(event.target.value)}
                    aria-invalid={invalid && !username.trim()}
                    placeholder="admin"
                  />
                </Field>

                <Field data-invalid={invalid && !password}>
                  <FieldLabel htmlFor="password">管理员口令</FieldLabel>
                  <div className="relative">
                    <Input
                      id="password"
                      className="pr-10"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)}
                      aria-invalid={invalid && !password}
                      placeholder="输入口令"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? "隐藏口令" : "显示口令"}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </div>
                  <FieldDescription>首次登录后请在「系统设置 → 管理员口令」中修改默认口令。</FieldDescription>
                </Field>
              </FieldGroup>

              {action.error ? (
                <Alert variant="destructive">
                  <ShieldCheck />
                  <AlertTitle>登录失败</AlertTitle>
                  <AlertDescription>{describeError(action.error)}</AlertDescription>
                </Alert>
              ) : null}

              <LoadingButton type="submit" className="w-full" loading={action.pending} loadingText="正在登录…">
                登录
              </LoadingButton>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">会话使用 HttpOnly Cookie；连续失败会触发限流。</p>
        <p className="text-center text-xs text-muted-foreground">v{PANEL_VERSION}</p>
      </div>
    </div>
  )
}

// I have nothing but my burger and I want nothing more
