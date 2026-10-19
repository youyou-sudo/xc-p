import { useEffect, useRef, useState } from "react"
import { RotateCcw, Save, SlidersHorizontal, TriangleAlert, Wifi } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dot } from "@/components/common/status-badge"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError, eden, unwrap } from "@/lib/api"
import { isHttpUrl } from "@/lib/format"
import { useAction } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import type { SettingsTestResult } from "@/lib/domain"
import type { DetectSettings } from "./types"

interface DetectPolicyFormProps {
  /** GET /api/settings 返回的 detect 段（父组件保证非空） */
  settings: DetectSettings
  onSaved: (next: DetectSettings) => void
}

interface DetectForm {
  enabled: boolean
  intervalSec: string
  liteIntervalSec: string
  fullIntervalSec: string
  fullModeEnabled: boolean
  checkOnPublish: boolean
  concurrency: string
  jitterMs: string
  tcpTimeoutMs: string
  totalTimeoutMs: string
  testUrl: string
  ipEchoUrls: string
  probeVia: "gateway" | "direct"
  quarantineAfter: string
  recoverAfter: string
  historyKeep: string
}

function toForm(settings: DetectSettings): DetectForm {
  return {
    enabled: !!settings.enabled,
    intervalSec: String(settings.intervalSec ?? ""),
    liteIntervalSec: String(settings.liteIntervalSec ?? ""),
    fullIntervalSec: String(settings.fullIntervalSec ?? ""),
    fullModeEnabled: !!settings.fullModeEnabled,
    checkOnPublish: !!settings.checkOnPublish,
    concurrency: String(settings.concurrency ?? ""),
    jitterMs: String(settings.jitterMs ?? ""),
    tcpTimeoutMs: String(settings.tcpTimeoutMs ?? ""),
    totalTimeoutMs: String(settings.totalTimeoutMs ?? ""),
    testUrl: settings.testUrl ?? "",
    ipEchoUrls: Array.isArray(settings.ipEchoUrls) ? settings.ipEchoUrls.join("\n") : "",
    probeVia: settings.probeVia === "direct" ? "direct" : "gateway",
    quarantineAfter: String(settings.quarantineAfter ?? ""),
    recoverAfter: String(settings.recoverAfter ?? ""),
    historyKeep: String(settings.historyKeep ?? ""),
  }
}

function toSettings(form: DetectForm): DetectSettings {
  return {
    enabled: form.enabled,
    intervalSec: Number(form.intervalSec),
    liteIntervalSec: Number(form.liteIntervalSec),
    fullIntervalSec: Number(form.fullIntervalSec),
    fullModeEnabled: form.fullModeEnabled,
    checkOnPublish: form.checkOnPublish,
    concurrency: Number(form.concurrency),
    jitterMs: Number(form.jitterMs),
    tcpTimeoutMs: Number(form.tcpTimeoutMs),
    totalTimeoutMs: Number(form.totalTimeoutMs),
    testUrl: form.testUrl.trim(),
    ipEchoUrls: form.ipEchoUrls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    probeVia: form.probeVia,
    quarantineAfter: Number(form.quarantineAfter),
    recoverAfter: Number(form.recoverAfter),
    historyKeep: Number(form.historyKeep),
  }
}

function validate(form: DetectForm): string[] {
  const errors: string[] = []
  const num = (value: string) => (value.trim() === "" ? Number.NaN : Number(value))
  const range = (value: string, label: string, min: number, max: number) => {
    const parsed = num(value)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) errors.push(label + "需在 " + min + "–" + max + " 之间")
    return parsed
  }
  range(form.intervalSec, "检测间隔（秒）", 30, 2592000)
  range(form.liteIntervalSec, "轻量检测间隔（秒）", 60, 2592000)
  range(form.fullIntervalSec, "全量检测间隔（秒）", 60, 2592000)
  range(form.concurrency, "全局并发上限", 1, 64)
  const tcp = range(form.tcpTimeoutMs, "S1 网关握手超时（毫秒）", 200, 60000)
  const total = range(form.totalTimeoutMs, "单节点总超时（毫秒）", 500, 300000)
  range(form.jitterMs, "抖动（毫秒）", 0, 600000)
  range(form.quarantineAfter, "隔离阈值", 1, 100)
  range(form.recoverAfter, "恢复阈值", 1, 100)
  range(form.historyKeep, "历史保留条数", 5, 10000)
  if (Number.isFinite(tcp) && Number.isFinite(total) && total < tcp) errors.push("单节点总超时必须 ≥ S1 网关握手超时")
  if (!isHttpUrl(form.testUrl)) errors.push("S2 探测地址必须是 http(s) URL")
  const urls = form.ipEchoUrls
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!urls.length) errors.push("至少需要一个 IP 查询源")
  else if (urls.some((url) => !isHttpUrl(url))) errors.push("IP 查询源必须是 http(s) URL（每行一个）")
  return errors
}

/** 检测策略卡片：settings.detect 的可视化编辑、保存、放弃修改与 IP 查询源连通性测试。 */
export function DetectPolicyForm({ settings, onSaved }: DetectPolicyFormProps) {
  const [form, setForm] = useState<DetectForm>(() => toForm(settings))
  const [baseline, setBaseline] = useState<DetectForm>(() => toForm(settings))
  const [errors, setErrors] = useState<string[]>([])
  const [testResults, setTestResults] = useState<SettingsTestResult[] | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    if (dirtyRef.current) return
    const next = toForm(settings)
    setForm(next)
    setBaseline(next)
  }, [settings])

  function update<K extends keyof DetectForm>(key: K, value: DetectForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  const save = useAction(async (detect: DetectSettings) => {
    const response = await unwrap(eden.api.settings.patch({ detect }))
    return response?.settings?.detect ?? detect
  })

  async function savePolicy() {
    const issues = validate(form)
    if (issues.length) {
      setErrors(issues)
      toast.error("检测策略校验未通过", { description: issues[0] })
      return
    }
    setErrors([])
    try {
      const next = await save.run(toSettings(form))
      const nextForm = toForm(next)
      setForm(nextForm)
      setBaseline(nextForm)
      setTestResults(null)
      toast.success("检测策略已保存", { description: "已立即生效；并发上限会同步更新到检测信号量。" })
      onSaved(next)
    } catch (caught) {
      const message = describeError(caught)
      setErrors([message])
      toast.error("保存检测策略失败", { description: message })
    }
  }

  const test = useAction(async () => {
    const response = await unwrap(eden.api.settings.test.post({ what: "ipecho" }))
    return response?.results ?? []
  })

  async function runTest() {
    setTestResults(null)
    try {
      const results = await test.run()
      setTestResults(results)
      const failed = results.filter((result) => !result.ok).length
      if (failed) toast.warning("IP 查询源部分不可用", { description: failed + " / " + results.length + " 个源测试失败" })
      else toast.success("IP 查询源全部可用", { description: results.length + " 个源返回正常" })
    } catch (caught) {
      toast.error("测试失败", { description: describeError(caught) })
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-primary" />
          检测策略
        </CardTitle>
        <CardDescription>settings.detect · 保存后立即生效；阈值与超时会同时约束手动检测与定时检测。</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-1.5">
          {dirty ? (
            <Badge variant="outline" className="font-normal text-warning">
              有未保存修改
            </Badge>
          ) : null}
          <Badge variant="outline" className={"font-normal " + (form.enabled ? "text-success" : "text-muted-foreground")}>
            定时检测{form.enabled ? "已开启" : "已关闭"}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {errors.length ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>检测策略校验未通过</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">定时与调度</p>
          <Field orientation="horizontal" className="rounded-lg border p-3">
            <FieldContent>
              <FieldTitle>启用定时检测</FieldTitle>
              <FieldDescription>关闭后只保留手动检测与发布前门禁检测。</FieldDescription>
            </FieldContent>
            <Switch checked={form.enabled} onCheckedChange={(checked) => update("enabled", checked)} aria-label="启用定时检测" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id="detect-interval" label="检测间隔（秒）" min={30} value={form.intervalSec} onChange={(value) => update("intervalSec", value)} hint="默认 900（15 分钟）" />
            <NumberField id="detect-lite-interval" label="轻量检测间隔（秒）" min={60} value={form.liteIntervalSec} onChange={(value) => update("liteIntervalSec", value)} hint="默认 3600" />
            <NumberField id="detect-full-interval" label="全量检测间隔（秒）" min={60} value={form.fullIntervalSec} onChange={(value) => update("fullIntervalSec", value)} hint="默认 21600" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field orientation="horizontal" className="rounded-lg border p-3">
              <FieldContent>
                <FieldTitle>启用全量检测</FieldTitle>
                <FieldDescription>关闭后定时任务只跑 lite（S1 + S2）。</FieldDescription>
              </FieldContent>
              <Switch checked={form.fullModeEnabled} onCheckedChange={(checked) => update("fullModeEnabled", checked)} aria-label="启用全量检测" />
            </Field>
            <Field orientation="horizontal" className="rounded-lg border p-3">
              <FieldContent>
                <FieldTitle>发布前门禁检测</FieldTitle>
                <FieldDescription>发布前对涉及且已过期的节点做一次快速 lite 检测。</FieldDescription>
              </FieldContent>
              <Switch checked={form.checkOnPublish} onCheckedChange={(checked) => update("checkOnPublish", checked)} aria-label="发布前门禁检测" />
            </Field>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">并发与超时</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="detect-concurrency"
              label="全局并发上限"
              min={1}
              max={64}
              value={form.concurrency}
              onChange={(value) => update("concurrency", value)}
              hint="默认 8；必须显著低于网关并发上限，避免挤占用户带宽"
            />
            <NumberField
              id="detect-jitter"
              label="抖动（毫秒）"
              min={0}
              max={600000}
              value={form.jitterMs}
              onChange={(value) => update("jitterMs", value)}
              hint="默认 800，避免整点雪崩"
            />
            <NumberField
              id="detect-tcp-timeout"
              label="S1 网关握手超时（毫秒）"
              min={200}
              max={60000}
              value={form.tcpTimeoutMs}
              onChange={(value) => update("tcpTimeoutMs", value)}
              hint="默认 4000"
            />
            <NumberField
              id="detect-total-timeout"
              label="单节点总超时（毫秒）"
              min={500}
              max={300000}
              value={form.totalTimeoutMs}
              onChange={(value) => update("totalTimeoutMs", value)}
              hint="默认 12000，必须 ≥ S1 超时"
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">探测与出口确认</p>
          <Field>
            <FieldLabel htmlFor="detect-test-url">S2 探测地址</FieldLabel>
            <Input
              id="detect-test-url"
              value={form.testUrl}
              placeholder="https://www.gstatic.com/generate_204"
              onChange={(event) => update("testUrl", event.target.value)}
            />
            <FieldDescription>期望返回 200/204；检测流量会经探测路径发出。</FieldDescription>
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
            <Field>
              <FieldLabel htmlFor="detect-ip-echo">S3 IP 查询源（每行一个）</FieldLabel>
              <Textarea
                id="detect-ip-echo"
                rows={4}
                value={form.ipEchoUrls}
                className="font-mono text-xs"
                placeholder={"https://api.ip.sb/geoip\nhttps://ipinfo.io/json"}
                onChange={(event) => update("ipEchoUrls", event.target.value)}
              />
              <FieldDescription>至少一个，用于确认节点真实出口 IP 与地区。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>探测路径</FieldLabel>
              <Select value={form.probeVia} onValueChange={(value) => update("probeVia", value === "direct" ? "direct" : "gateway")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gateway">经网关（端到端，推荐）</SelectItem>
                  <SelectItem value="direct">仅经数据面直连</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>经网关能验证完整链路与认证；直连只验证节点本身。</FieldDescription>
            </Field>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">隔离与保留</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField
              id="detect-quarantine"
              label="隔离阈值（连续失败）"
              min={1}
              max={100}
              value={form.quarantineAfter}
              onChange={(value) => update("quarantineAfter", value)}
              hint="默认 3 次"
            />
            <NumberField
              id="detect-recover"
              label="恢复阈值（连续成功）"
              min={1}
              max={100}
              value={form.recoverAfter}
              onChange={(value) => update("recoverAfter", value)}
              hint="默认 2 次"
            />
            <NumberField
              id="detect-history"
              label="每节点历史保留条数"
              min={5}
              max={10000}
              value={form.historyKeep}
              onChange={(value) => update("historyKeep", value)}
              hint="默认 50"
            />
          </div>
        </div>

        {testResults ? (
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Wifi className="size-3.5 text-primary" />
                IP 查询源连通性
              </p>
              <span className="text-[11px] text-muted-foreground">测试使用已保存的配置</span>
            </div>
            {testResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">没有可测试的 IP 查询源，请先保存至少一个源。</p>
            ) : (
              <ul className="space-y-1.5">
                {testResults.map((result) => (
                  <li key={result.id} className="flex items-start gap-2 text-xs">
                    <Dot tone={result.ok ? "ok" : "down"} className="mt-1.5" />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px]">{result.label || result.id}</p>
                      <p className={cn("truncate", result.ok ? "text-muted-foreground" : "text-destructive")}>{result.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 border-t pt-4">
        <LoadingButton loading={save.pending} loadingText="保存中…" onClick={() => void savePolicy()}>
          <Save data-icon="inline-start" />
          保存策略
        </LoadingButton>
        <Button type="button" variant="outline" disabled={!dirty || save.pending} onClick={() => setForm(baseline)}>
          <RotateCcw data-icon="inline-start" />
          放弃修改
        </Button>
        <LoadingButton
          type="button"
          variant="outline"
          loading={test.pending}
          loadingText="测试中…"
          onClick={() => void runTest()}
          title="测试已保存的 IP 查询源（未保存的修改不生效）"
        >
          <Wifi data-icon="inline-start" />
          测试 IP 查询源
        </LoadingButton>
        <span className="text-xs text-muted-foreground">保存后立即生效</span>
      </CardFooter>
    </Card>
  )
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  min?: number
  max?: number
  hint?: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  )
}
