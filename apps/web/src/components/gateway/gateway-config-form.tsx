import { useEffect, useMemo, useState } from "react"
import { RotateCcw, Save } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/common/confirm-dialog"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { SectionCard } from "@/components/common/section-card"
import { describeError, eden, unwrap } from "@/lib/api"
import { fmtNumber } from "@/lib/format"
import { useAction } from "@/lib/hooks"
import type { GatewayConfig } from "./types"

interface GatewayConfigFormProps {
  config: GatewayConfig | null
  loading: boolean
  error: unknown
  onRetry: () => void
  onSaved: () => void
  activeConns: number
}

interface FormState {
  enabled: boolean
  listen: string
  authMode: "strict" | "username-only"
  maxConcurrentPerUser: string
  maxConcurrentPerIp: string
  idleTimeoutSec: string
  dialTimeoutMs: string
  authFailBanCount: string
  authFailBanSec: string
  http: boolean
  socks5: boolean
  tlsEnabled: boolean
  tlsCertFile: string
  tlsKeyFile: string
}

type NumberKey =
  | "maxConcurrentPerUser"
  | "maxConcurrentPerIp"
  | "idleTimeoutSec"
  | "dialTimeoutMs"
  | "authFailBanCount"
  | "authFailBanSec"

const DEFAULT_FORM: FormState = {
  enabled: true,
  listen: "0.0.0.0:7890",
  authMode: "strict",
  maxConcurrentPerUser: "64",
  maxConcurrentPerIp: "256",
  idleTimeoutSec: "300",
  dialTimeoutMs: "3000",
  authFailBanCount: "20",
  authFailBanSec: "300",
  http: true,
  socks5: true,
  tlsEnabled: false,
  tlsCertFile: "",
  tlsKeyFile: "",
}

const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string; min: number; max: number }[] = [
  { key: "maxConcurrentPerUser", label: "每用户并发上限", hint: "默认 64；按用户名统计活跃连接", min: 1, max: 100000 },
  { key: "maxConcurrentPerIp", label: "每 IP 并发上限", hint: "默认 256；防止单客户端跑满", min: 1, max: 100000 },
  { key: "idleTimeoutSec", label: "空闲超时（秒）", hint: "超过该时长无流量则断开", min: 5, max: 86400 },
  { key: "dialTimeoutMs", label: "拨号超时（毫秒）", hint: "连接目标节点的超时时间", min: 100, max: 120000 },
  { key: "authFailBanCount", label: "认证失败封禁阈值", hint: "连续失败达到该次数后封禁 IP；0 表示不封禁", min: 0, max: 100000 },
  { key: "authFailBanSec", label: "封禁时长（秒）", hint: "封禁到期后自动解除", min: 0, max: 86400 },
]

function toForm(config: GatewayConfig): FormState {
  return {
    enabled: config.enabled,
    listen: config.listen,
    authMode: config.authMode,
    maxConcurrentPerUser: String(config.maxConcurrentPerUser),
    maxConcurrentPerIp: String(config.maxConcurrentPerIp),
    idleTimeoutSec: String(config.idleTimeoutSec),
    dialTimeoutMs: String(config.dialTimeoutMs),
    authFailBanCount: String(config.authFailBanCount),
    authFailBanSec: String(config.authFailBanSec),
    http: config.protocols.http,
    socks5: config.protocols.socks5,
    tlsEnabled: config.tls.enabled,
    tlsCertFile: config.tls.certFile,
    tlsKeyFile: config.tls.keyFile,
  }
}

function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  const listen = form.listen.trim()
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_.-]+):(\d{1,5})$/.exec(listen)
  if (!match) {
    errors.listen = "监听地址需形如 host:port，例如 0.0.0.0:7890"
  } else {
    const port = Number.parseInt(match[2] ?? "", 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.listen = "端口必须在 1–65535 之间"
    }
  }
  for (const field of NUMBER_FIELDS) {
    const raw = form[field.key].trim()
    const value = Number(raw)
    if (!raw || !Number.isFinite(value) || !Number.isInteger(value)) {
      errors[field.key] = field.label + "必须是整数"
    } else if (value < field.min || value > field.max) {
      errors[field.key] = field.label + "需在 " + field.min + "–" + field.max + " 之间"
    }
  }
  if (!form.http && !form.socks5) {
    errors.protocols = "HTTP 与 SOCKS5 至少保留一种入站协议"
  }
  if (form.tlsEnabled) {
    if (!form.tlsCertFile.trim()) errors.tlsCertFile = "启用 TLS 时必须填写证书文件路径"
    if (!form.tlsKeyFile.trim()) errors.tlsKeyFile = "启用 TLS 时必须填写私钥文件路径"
  }
  return errors
}

function toPayload(form: FormState): Partial<GatewayConfig> {
  return {
    enabled: form.enabled,
    listen: form.listen.trim(),
    authMode: form.authMode,
    maxConcurrentPerUser: Number(form.maxConcurrentPerUser),
    maxConcurrentPerIp: Number(form.maxConcurrentPerIp),
    idleTimeoutSec: Number(form.idleTimeoutSec),
    dialTimeoutMs: Number(form.dialTimeoutMs),
    authFailBanCount: Number(form.authFailBanCount),
    authFailBanSec: Number(form.authFailBanSec),
    protocols: { http: form.http, socks5: form.socks5 },
    tls: { enabled: form.tlsEnabled, certFile: form.tlsCertFile.trim(), keyFile: form.tlsKeyFile.trim() },
  }
}

/** settings.gateway 编辑表单：修改监听 / 启用 / TLS 会重建 listener，保存前明确展示影响面。 */
export function GatewayConfigForm({ config, loading, error, onRetry, onSaved, activeConns }: GatewayConfigFormProps) {
  const confirm = useConfirm()
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const configJson = config ? JSON.stringify(config) : ""
  useEffect(() => {
    if (!config) return
    setForm(toForm(config))
    setErrors({})
    // 只在服务端配置值真正变化时重置表单，手动刷新同值时保留用户编辑
  }, [configJson])

  const saved = useMemo(() => (config ? toForm(config) : null), [config])
  const dirty = saved ? JSON.stringify(form) !== JSON.stringify(saved) : false
  const needsRestart = !!saved && (form.listen.trim() !== saved.listen || form.enabled !== saved.enabled || form.tlsEnabled !== saved.tlsEnabled || form.tlsCertFile.trim() !== saved.tlsCertFile || form.tlsKeyFile.trim() !== saved.tlsKeyFile)

  const save = useAction(async (payload: Partial<GatewayConfig>) => {
    await unwrap(eden.api.settings.patch({ gateway: payload }))
    toast.success("网关配置已保存并立即生效")
    onSaved()
  })

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key] && !(key === "http" || key === "socks5")) return prev
      const next = { ...prev }
      delete next[key]
      delete next.protocols
      return next
    })
  }

  const handleSave = async () => {
    const nextErrors = validate(form)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      toast.error("请检查表单", { description: Object.values(nextErrors)[0] })
      return
    }
    const payload = toPayload(form)
    if (needsRestart) {
      await confirm({
        title: "保存并重建网关 listener？",
        description:
          "修改监听地址、启用状态或 TLS 配置会重建 listener：现有代理连接会被立即关闭，客户端需要重新连接。数据面（Xray）不受影响。",
        details: (
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">新监听地址</dt>
              <dd className="font-mono">{form.listen.trim()}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">将断开连接</dt>
              <dd className="font-semibold text-destructive">{fmtNumber(activeConns)} 条</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">生效方式</dt>
              <dd>立即重建 listener</dd>
            </div>
          </dl>
        ),
        destructive: true,
        confirmText: "保存并重建",
        action: async () => {
          await save.run(payload)
        },
      })
      return
    }
    void save.run(payload).catch((saveError) => toast.error("保存失败", { description: describeError(saveError) }))
  }

  const reset = () => {
    if (!saved) return
    setForm(saved)
    setErrors({})
  }

  return (
    <SectionCard
      title="监听与限额"
      description="settings.gateway · 仅改并发/超时/封禁参数会热生效；修改监听地址、启用状态或 TLS 会重建 listener"
      actions={
        dirty ? (
          <Badge variant="outline" className="text-warning">
            有未保存修改
          </Badge>
        ) : (
          <Badge variant="secondary">与服务端一致</Badge>
        )
      }
    >
      {loading && !config ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : error && !config ? (
        <ErrorState error={error} title="网关配置加载失败" onRetry={onRetry} />
      ) : config ? (
        <div className="space-y-6">
          {needsRestart ? (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTitle className="text-warning">保存后将重建 listener</AlertTitle>
              <AlertDescription>
                当前有 {fmtNumber(activeConns)} 条活跃连接，重建时会被立即关闭；新配置立即生效。
              </AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup className="gap-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field data-invalid={!!errors.listen}>
                <FieldLabel htmlFor="gateway-listen">监听地址</FieldLabel>
                <Input
                  id="gateway-listen"
                  value={form.listen}
                  onChange={(event) => update("listen", event.target.value)}
                  className="font-mono"
                  placeholder="0.0.0.0:7890"
                  aria-invalid={!!errors.listen}
                />
                <FieldDescription>对外唯一代理端口；客户端使用 http://节点ID:密码@该地址</FieldDescription>
                {errors.listen ? <FieldError>{errors.listen}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="gateway-auth-mode">认证模式</FieldLabel>
                <Select value={form.authMode} onValueChange={(value) => update("authMode", value as FormState["authMode"])}>
                  <SelectTrigger id="gateway-auth-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="strict">strict（用户名 + 密码）</SelectItem>
                    <SelectItem value="username-only">username-only（仅用户名）</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>username-only 仅校验用户名是否存在，安全性较低</FieldDescription>
              </Field>
              <Field orientation="horizontal" className="items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FieldLabel htmlFor="gateway-enabled">启用网关</FieldLabel>
                  <FieldDescription>关闭后不再监听端口</FieldDescription>
                </div>
                <Switch id="gateway-enabled" checked={form.enabled} onCheckedChange={(checked) => update("enabled", checked === true)} />
              </Field>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">并发与超时</h3>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {NUMBER_FIELDS.slice(0, 4).map((field) => (
                  <NumberField
                    key={field.key}
                    field={field}
                    value={form[field.key]}
                    error={errors[field.key]}
                    onChange={(value) => update(field.key, value)}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">认证失败封禁</h3>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {NUMBER_FIELDS.slice(4).map((field) => (
                  <NumberField
                    key={field.key}
                    field={field}
                    value={form[field.key]}
                    error={errors[field.key]}
                    onChange={(value) => update(field.key, value)}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">入站协议与 TLS</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field orientation="horizontal" className="items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="gateway-http">HTTP 代理</FieldLabel>
                    <FieldDescription>HTTP CONNECT 与绝对 URI 请求</FieldDescription>
                  </div>
                  <Switch id="gateway-http" checked={form.http} onCheckedChange={(checked) => update("http", checked === true)} />
                </Field>
                <Field orientation="horizontal" className="items-center justify-between rounded-lg border p-3" data-invalid={!!errors.protocols}>
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="gateway-socks5">SOCKS5</FieldLabel>
                    <FieldDescription>RFC 1928 / RFC 1929 用户名密码认证</FieldDescription>
                  </div>
                  <Switch id="gateway-socks5" checked={form.socks5} onCheckedChange={(checked) => update("socks5", checked === true)} />
                </Field>
                {errors.protocols ? <FieldError className="sm:col-span-2">{errors.protocols}</FieldError> : null}
                <Field orientation="horizontal" className="items-center justify-between rounded-lg border p-3 sm:col-span-2">
                  <div className="space-y-0.5">
                    <FieldLabel htmlFor="gateway-tls">TLS（HTTPS 代理）</FieldLabel>
                    <FieldDescription>启用后客户端需使用 https:// 连接；需提供证书与私钥文件路径</FieldDescription>
                  </div>
                  <Switch id="gateway-tls" checked={form.tlsEnabled} onCheckedChange={(checked) => update("tlsEnabled", checked === true)} />
                </Field>
              </div>
              {form.tlsEnabled ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={!!errors.tlsCertFile}>
                    <FieldLabel htmlFor="gateway-tls-cert">证书文件</FieldLabel>
                    <Input
                      id="gateway-tls-cert"
                      value={form.tlsCertFile}
                      onChange={(event) => update("tlsCertFile", event.target.value)}
                      className="font-mono"
                      placeholder="/path/to/cert.pem"
                      aria-invalid={!!errors.tlsCertFile}
                    />
                    {errors.tlsCertFile ? <FieldError>{errors.tlsCertFile}</FieldError> : null}
                  </Field>
                  <Field data-invalid={!!errors.tlsKeyFile}>
                    <FieldLabel htmlFor="gateway-tls-key">私钥文件</FieldLabel>
                    <Input
                      id="gateway-tls-key"
                      value={form.tlsKeyFile}
                      onChange={(event) => update("tlsKeyFile", event.target.value)}
                      className="font-mono"
                      placeholder="/path/to/key.pem"
                      aria-invalid={!!errors.tlsKeyFile}
                    />
                    {errors.tlsKeyFile ? <FieldError>{errors.tlsKeyFile}</FieldError> : null}
                  </Field>
                </div>
              ) : null}
            </div>
          </FieldGroup>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <LoadingButton
              loading={save.pending}
              loadingText="保存中…"
              disabled={!dirty}
              onClick={() => void handleSave()}
            >
              <Save data-icon="inline-start" />
              保存配置
            </LoadingButton>
            <Button variant="outline" disabled={!dirty || save.pending} onClick={reset}>
              <RotateCcw data-icon="inline-start" />
              重置
            </Button>
            <p className="text-xs text-muted-foreground">保存后立即生效；HTTP Basic 凭据为明文，请仅在可信网络暴露代理端口。</p>
          </div>
        </div>
      ) : null}
    </SectionCard>
  )
}

function NumberField({
  field,
  value,
  error,
  onChange,
}: {
  field: (typeof NUMBER_FIELDS)[number]
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const id = "gateway-" + field.key
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={field.min}
        max={field.max}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={!!error}
      />
      <FieldDescription>{field.hint}</FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}
