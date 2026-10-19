import { useState } from "react"
import { useNavigate } from "@teyik0/furin/link"
import { CheckCircle2, Eye, EyeOff, KeyRound, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/common/confirm-dialog"
import { describeError, eden, unwrap } from "@/lib/api"
import { logout } from "@/lib/session"

interface PasswordErrors {
  current?: string
  next?: string
  again?: string
}

/** 管理员口令修改：POST /api/auth/password，成功后提示用新口令重新登录。 */
export function PasswordCard() {
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [show, setShow] = useState(false)
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const nextErrors: PasswordErrors = {}
    if (!current) nextErrors.current = "请填写当前口令"
    if (next.length < 8) nextErrors.next = "新口令至少 8 位"
    else if (next === current) nextErrors.next = "新口令不能与当前口令相同"
    if (next !== again) nextErrors.again = "两次输入的新口令不一致"
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      toast.error("请先修正表单里的问题")
      return
    }

    setBusy(true)
    try {
      await confirm({
        title: "修改管理员口令？",
        description: "修改成功后，其它所有面板会话会立即失效（当前会话保留）。",
        details: (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>· 新口令立即生效，下次登录请使用新口令。</p>
            <p>
              · 忘记口令可在服务器执行 <span className="font-mono">bun run admin:password &quot;&lt;新口令&gt;&quot;</span> 重置（会吊销全部会话）。
            </p>
          </div>
        ),
        confirmText: "修改口令",
        action: async () => {
          try {
            await unwrap(eden.api.auth.password.post({ currentPassword: current, newPassword: next }))
            setCurrent("")
            setNext("")
            setAgain("")
            setErrors({})
            setDone(true)
            toast.success("管理员口令已修改", { description: "其它会话已吊销，下次登录请使用新口令。" })
          } catch (caught) {
            toast.error("修改失败", { description: describeError(caught) })
            throw caught
          }
        },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-primary" />
          管理员口令
        </CardTitle>
        <CardDescription>修改后会吊销其它会话；忘记口令可在服务器用 bun run admin:password 重置。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <Alert className="border-success/40 bg-success/10">
            <CheckCircle2 className="text-success" />
            <AlertTitle className="text-success">口令已更新</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              其它面板会话已吊销。请使用新口令重新登录；如果当前浏览器还要继续操作，可以稍后再登录。
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void (async () => {
                      await logout()
                      toast.success("已退出登录")
                      await navigate({ to: "/login", replace: true })
                    })()
                  }}
                >
                  <LogOut data-icon="inline-start" />
                  立即重新登录
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup className="gap-4">
          <Field data-invalid={!!errors.current}>
            <FieldLabel htmlFor="pw-current">当前口令</FieldLabel>
            <div className="relative">
              <Input
                id="pw-current"
                type={show ? "text" : "password"}
                value={current}
                autoComplete="current-password"
                aria-invalid={!!errors.current}
                className="pr-10"
                onChange={(event) => {
                  setCurrent(event.target.value)
                  setErrors((prev) => ({ ...prev, current: undefined }))
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setShow((value) => !value)}
                aria-label={show ? "隐藏口令" : "显示口令"}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
            <FieldError>{errors.current}</FieldError>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.next}>
              <FieldLabel htmlFor="pw-next">新口令</FieldLabel>
              <Input
                id="pw-next"
                type={show ? "text" : "password"}
                value={next}
                autoComplete="new-password"
                aria-invalid={!!errors.next}
                onChange={(event) => {
                  setNext(event.target.value)
                  setErrors((prev) => ({ ...prev, next: undefined }))
                }}
              />
              <FieldDescription>至少 8 位；建议用密码管理器生成。</FieldDescription>
              <FieldError>{errors.next}</FieldError>
            </Field>

            <Field data-invalid={!!errors.again}>
              <FieldLabel htmlFor="pw-again">确认新口令</FieldLabel>
              <Input
                id="pw-again"
                type={show ? "text" : "password"}
                value={again}
                autoComplete="new-password"
                aria-invalid={!!errors.again}
                onChange={(event) => {
                  setAgain(event.target.value)
                  setErrors((prev) => ({ ...prev, again: undefined }))
                }}
              />
              <FieldError>{errors.again}</FieldError>
            </Field>
          </div>
        </FieldGroup>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            <KeyRound data-icon="inline-start" />
            修改口令
          </Button>
          <span className="text-xs text-muted-foreground">提交前会二次确认，并提示影响面。</span>
        </div>
      </CardContent>
    </Card>
  )
}
