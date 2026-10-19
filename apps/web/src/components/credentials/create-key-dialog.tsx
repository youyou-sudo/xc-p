import { useEffect, useState } from "react"
import { CheckCircle2, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CodeBlock } from "@/components/common/code-block"
import { CopyButton } from "@/components/common/copy-button"
import { LoadingButton } from "@/components/common/loading-button"
import { useConfirm } from "@/components/common/confirm-dialog"
import { describeError, eden, unwrap } from "@/lib/api"
import { useAction } from "@/lib/hooks"
import { groupScopes, parseAllowlist, type CreateKeyResponse } from "./types"

interface CreateKeyDialogProps {
  open: boolean
  scopes: string[]
  onOpenChange: (open: boolean) => void
  /** 创建成功后立刻刷新列表（明文仍留在弹窗里展示）。 */
  onCreated: () => void
}

interface FormErrors {
  name?: string
  scopes?: string
  rateLimit?: string
  allowlist?: string
}

/** 新建 API Key：明文只显示一次，关闭前必须提示。 */
export function CreateKeyDialog({ open, scopes, onOpenChange, onCreated }: CreateKeyDialogProps) {
  const confirm = useConfirm()
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<string[]>(["read"])
  const [allowlistText, setAllowlistText] = useState("")
  const [rateLimit, setRateLimit] = useState("0")
  const [errors, setErrors] = useState<FormErrors>({})
  const [created, setCreated] = useState<CreateKeyResponse | null>(null)
  const [saved, setSaved] = useState(false)
  const groups = groupScopes(scopes)

  useEffect(() => {
    if (!open) return
    setName("")
    setSelected(scopes.includes("read") ? ["read"] : scopes.slice(0, 1))
    setAllowlistText("")
    setRateLimit("0")
    setErrors({})
    setCreated(null)
    setSaved(false)
    // 打开时重置表单；scopes 由服务端返回，运行期稳定，不需要进依赖。
  }, [open])

  const toggleScope = (scope: string) => {
    setSelected((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]))
    setErrors((prev) => ({ ...prev, scopes: undefined }))
  }

  const action = useAction(async () => {
    const nextErrors: FormErrors = {}
    const trimmedName = name.trim()
    if (!trimmedName) nextErrors.name = "请填写名称，便于日后识别用途（例如 ci-deploy）"
    if (selected.length === 0) nextErrors.scopes = "至少勾选一个 scope"
    const rate = rateLimit.trim() === "" ? 0 : Number(rateLimit)
    if (!Number.isInteger(rate) || rate < 0) nextErrors.rateLimit = "限流必须是不小于 0 的整数（0 表示不限）"
    const allowlist = parseAllowlist(allowlistText)
    if (allowlist.some((ip) => ip.length > 64)) nextErrors.allowlist = "IP 地址过长，请检查是否混入了其它内容"
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) throw new Error("请先修正表单里的问题")

    if (selected.includes("admin")) {
      const ok = await confirm({
        title: "授予 admin scope？",
        description: "admin 允许管理 API Key 与系统设置，等价于人工运维权限。",
        details: (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>· 该 Key 可创建 / 吊销其它 Key、修改全部系统设置。</p>
            <p>· 建议只放在本机或 CI 的密钥库中，不要分发给客户端。</p>
          </div>
        ),
        confirmText: "确认授予",
        action: async () => undefined,
      })
      if (!ok) return
    }

    const response = await unwrap(
      eden.api.keys.post({
        name: trimmedName,
        scopes: selected,
        ipAllowlist: allowlist,
        rateLimitPerMin: rate,
      }),
    )
    setCreated(response)
    setSaved(false)
    toast.success("API Key 已创建", { description: "明文只显示一次，请立即复制保存。" })
    onCreated()
  })

  const close = () => {
    setCreated(null)
    setSaved(false)
    onOpenChange(false)
  }

  const requestClose = async () => {
    if (created && !saved) {
      const ok = await confirm({
        title: "明文只显示这一次",
        description: "关闭弹窗后无法再次查看这段 secret。确定已经保存好了吗？",
        details: (
          <p className="text-xs text-muted-foreground">
            需要的话先点「复制 secret」，或勾选「我已妥善保存」再关闭。
          </p>
        ),
        confirmText: "仍然关闭",
        destructive: true,
        action: async () => undefined,
      })
      if (!ok) return
    }
    close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else void requestClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            {created ? "Key 已创建" : "新建 API Key"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? "服务端只保存 secret 的哈希：明文仅显示这一次，关闭后无法再次查看。"
              : "服务 API 走 Authorization: Bearer <key>。scope、IP 白名单与限流创建后不可修改，调整请新建并吊销旧 Key。"}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>现在复制并保存到密钥管理工具。离开此页后，面板无法再展示这段明文。</span>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">secret（仅此一次）</p>
              <CodeBlock code={created.plaintext} title={"Bearer " + created.prefix + "…"} maxHeight={140} wrap />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton value={created.plaintext} label="复制 secret" variant="default" size="sm" />
              <label htmlFor="key-saved" className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox id="key-saved" checked={saved} onCheckedChange={(value) => setSaved(value === true)} />
                我已妥善保存这段明文
              </label>
            </div>
            <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground sm:grid-cols-2">
              <p>
                名称：<span className="text-foreground">{name}</span>
              </p>
              <p>
                前缀：<span className="font-mono text-foreground">{created.prefix}</span>
              </p>
              <p className="sm:col-span-2">
                scope：
                <span className="font-mono text-foreground">{selected.join(", ")}</span>
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={!saved} onClick={() => void requestClose()}>
                我已保存，关闭
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <FieldGroup className="gap-5">
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="key-name">名称</FieldLabel>
                <Input
                  id="key-name"
                  value={name}
                  placeholder="例如 ci-deploy"
                  autoComplete="off"
                  aria-invalid={!!errors.name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setErrors((prev) => ({ ...prev, name: undefined }))
                  }}
                />
                <FieldDescription>仅用于识别用途，不能重复也不影响鉴权。</FieldDescription>
                <FieldError>{errors.name}</FieldError>
              </Field>

              <Field data-invalid={!!errors.scopes}>
                <FieldLabel>scope</FieldLabel>
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div key={group.group} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">{group.group}</p>
                      <div className="grid gap-1.5">
                        {group.items.map((info) => (
                          <label
                            key={info.scope}
                            htmlFor={"scope-" + info.scope}
                            className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors hover:bg-accent/40"
                          >
                            <Checkbox
                              id={"scope-" + info.scope}
                              className="mt-0.5"
                              checked={selected.includes(info.scope)}
                              onCheckedChange={() => toggleScope(info.scope)}
                            />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                <span className="font-mono">{info.scope}</span>
                                <span className="text-xs font-normal text-muted-foreground">· {info.title}</span>
                                {info.danger ? (
                                  <Badge variant="outline" className="border-warning/50 font-normal text-warning">
                                    高风险
                                  </Badge>
                                ) : null}
                              </span>
                              <span className="block text-xs text-muted-foreground">{info.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <FieldError>{errors.scopes}</FieldError>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.rateLimit}>
                  <FieldLabel htmlFor="key-rate">每分钟限流</FieldLabel>
                  <Input
                    id="key-rate"
                    type="number"
                    min={0}
                    step={1}
                    value={rateLimit}
                    aria-invalid={!!errors.rateLimit}
                    onChange={(event) => {
                      setRateLimit(event.target.value)
                      setErrors((prev) => ({ ...prev, rateLimit: undefined }))
                    }}
                  />
                  <FieldDescription>0 表示不限；按 Key 计数，超限返回 429。</FieldDescription>
                  <FieldError>{errors.rateLimit}</FieldError>
                </Field>

                <Field data-invalid={!!errors.allowlist}>
                  <FieldLabel htmlFor="key-allowlist">IP 白名单</FieldLabel>
                  <Textarea
                    id="key-allowlist"
                    rows={3}
                    value={allowlistText}
                    placeholder={"10.0.0.5\n192.168.1.20"}
                    aria-invalid={!!errors.allowlist}
                    onChange={(event) => {
                      setAllowlistText(event.target.value)
                      setErrors((prev) => ({ ...prev, allowlist: undefined }))
                    }}
                  />
                  <FieldDescription>每行一个 IP，留空表示不限制；按精确 IP 匹配，不支持网段。</FieldDescription>
                  <FieldError>{errors.allowlist}</FieldError>
                </Field>
              </div>
            </FieldGroup>

            <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>创建成功后明文 secret 只显示一次；面板数据库里只有 sha256 哈希，丢失只能吊销重建。</span>
            </div>

            {action.error ? (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {describeError(action.error)}
              </div>
            ) : null}

            <DialogFooter>
              <Button variant="outline" disabled={action.pending} onClick={() => void requestClose()}>
                取消
              </Button>
              <LoadingButton loading={action.pending} loadingText="创建中…" onClick={() => void action.run().catch(() => {})}>
                <CheckCircle2 data-icon="inline-start" />
                创建 Key
              </LoadingButton>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
