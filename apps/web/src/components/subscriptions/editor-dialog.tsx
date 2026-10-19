import { useEffect, useState } from "react"
import { ChevronDown, Eye, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError, eden, unwrap } from "@/lib/api"
import { isHttpUrl } from "@/lib/format"
import { useAction } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import { FORMAT_OPTIONS } from "./format"
import { PreviewResult } from "./preview-result"
import type { PreviewResponse, SubscriptionItem } from "./types"

type SubscriptionInput = Parameters<typeof eden.api.subscriptions.post>[0]

interface SubscriptionEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null 表示新建 */
  item: SubscriptionItem | null
  onSaved: () => void
}

interface EditorForm {
  name: string
  url: string
  text: string
  formatHint: string
  intervalSec: string
  cron: string
  enabled: boolean
  timeoutMs: string
  retries: string
  userAgent: string
}

function initialForm(item: SubscriptionItem | null): EditorForm {
  return {
    name: item?.name ?? "",
    url: item && !item.inline ? item.url : "",
    text: "",
    formatHint: item?.formatHint ?? "auto",
    intervalSec: item?.intervalSec ? String(item.intervalSec) : "",
    cron: item?.cron ?? "",
    enabled: item ? item.enabled : true,
    timeoutMs: item?.timeoutMs ? String(item.timeoutMs) : "",
    retries: item?.retries !== undefined && item?.retries !== null ? String(item.retries) : "",
    userAgent: item?.userAgent ?? "",
  }
}

export function SubscriptionEditorDialog({ open, onOpenChange, item, onSaved }: SubscriptionEditorDialogProps) {
  const isEdit = !!item
  const [form, setForm] = useState<EditorForm>(() => initialForm(item))
  const [source, setSource] = useState<"url" | "text">("url")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [previewResult, setPreviewResult] = useState<PreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<unknown>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(initialForm(item))
    setSource(item?.inline ? "text" : "url")
    setAdvancedOpen(false)
    setErrors([])
    setPreviewResult(null)
    setPreviewError(null)
    setPreviewOpen(false)
  }, [open, item?.id])

  const showText = item ? item.inline : source === "text"

  function update<K extends keyof EditorForm>(key: K, value: EditorForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const save = useAction(async (payload: SubscriptionInput) => {
    if (item) return unwrap(eden.api.subscriptions({ id: item.id }).patch(payload))
    return unwrap(eden.api.subscriptions.post(payload))
  })

  const preview = useAction(async () => {
    return unwrap(eden.api.subscriptions.preview.post({ text: form.text, formatHint: form.formatHint }))
  })

  async function runPreview() {
    if (!form.text.trim()) {
      toast.error("请先粘贴节点文本", { description: "预览只解析粘贴的文本，不会访问外部 URL。" })
      return
    }
    setPreviewError(null)
    setPreviewOpen(true)
    try {
      const res = await preview.run()
      setPreviewResult(res)
      toast.success("解析完成", { description: "识别格式 " + res.format + " · " + res.total + " 个节点" })
    } catch (caught) {
      setPreviewError(caught)
      toast.error("解析失败", { description: describeError(caught) })
    }
  }

  function buildPayload(): { payload: SubscriptionInput; errors: string[] } {
    const issues: string[] = []
    const name = form.name.trim()
    if (!name) issues.push("名称必填")
    const intervalRaw = form.intervalSec.trim()
    const interval = intervalRaw === "" ? null : Number(intervalRaw)
    if (interval !== null && (!Number.isFinite(interval) || interval < 60)) issues.push("同步间隔不得小于 60 秒（留空表示手动同步）")
    const timeoutRaw = form.timeoutMs.trim()
    const timeout = timeoutRaw === "" ? null : Number(timeoutRaw)
    if (timeout !== null && (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000)) issues.push("拉取超时需在 1000–300000 毫秒之间")
    const retriesRaw = form.retries.trim()
    const retries = retriesRaw === "" ? null : Number(retriesRaw)
    if (retries !== null && (!Number.isFinite(retries) || retries < 0 || retries > 10)) issues.push("重试次数需在 0–10 之间")

    const payload: SubscriptionInput = {
      name,
      formatHint: form.formatHint,
      intervalSec: interval,
      cron: form.cron.trim() || null,
      enabled: form.enabled,
      userAgent: form.userAgent.trim() || null,
    }
    if (timeout !== null) payload.timeoutMs = timeout
    if (retries !== null) payload.retries = retries

    if (showText) {
      const text = form.text
      if (!isEdit && !text.trim()) issues.push("URL 与粘贴文本至少填一个")
      if (isEdit && item?.inline && text.trim() && text.trim().length < 8) issues.push("内联文本过短，请粘贴完整的订阅内容")
      if (!isEdit || text.trim()) payload.text = text
    } else {
      const url = form.url.trim()
      if (!url) issues.push("订阅 URL 必填")
      else if (!isHttpUrl(url)) issues.push("订阅 URL 必须以 http(s):// 开头")
      else payload.url = url
    }
    return { payload, errors: issues }
  }

  async function submit() {
    const built = buildPayload()
    if (built.errors.length) {
      setErrors(built.errors)
      toast.error("请检查表单", { description: built.errors[0] })
      return
    }
    setErrors([])
    try {
      await save.run(built.payload)
      toast.success(isEdit ? "订阅已保存" : "订阅已创建", { description: form.name.trim() })
      onSaved()
      onOpenChange(false)
    } catch (caught) {
      const message = describeError(caught)
      setErrors([message])
      toast.error(isEdit ? "保存失败" : "创建失败", { description: message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!save.pending ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑订阅" : "新建订阅"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "修改只影响后续同步；保存后建议立即同步一次以确认解析结果。"
              : "支持订阅 URL 或直接粘贴节点文本（base64 / Clash / Xray / sing-box / 明文链接）。"}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {errors.length ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>{isEdit ? "无法保存" : "无法创建"}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="sub-name">名称</FieldLabel>
              <Input
                id="sub-name"
                value={form.name}
                autoFocus
                placeholder="例如：机场A-香港"
                onChange={(event) => update("name", event.target.value)}
              />
            </Field>

            {!isEdit ? (
              <Tabs value={source} onValueChange={(value) => setSource(value === "text" ? "text" : "url")}>
                <TabsList className="w-full sm:w-auto">
                  <TabsTrigger value="url">订阅 URL</TabsTrigger>
                  <TabsTrigger value="text">粘贴内联文本</TabsTrigger>
                </TabsList>
                <TabsContent value="url" className="mt-3">
                  <Field>
                    <FieldLabel htmlFor="sub-url">订阅 URL</FieldLabel>
                    <Input
                      id="sub-url"
                      type="url"
                      value={form.url}
                      placeholder="https://example.com/sub?token=…"
                      onChange={(event) => update("url", event.target.value)}
                    />
                    <FieldDescription>保存后会由服务端拉取并解析；URL 中的 token 在列表中会脱敏显示。</FieldDescription>
                  </Field>
                </TabsContent>
                <TabsContent value="text" className="mt-3">
                  <Field>
                    <FieldLabel htmlFor="sub-text">节点文本</FieldLabel>
                    <Textarea
                      id="sub-text"
                      rows={8}
                      value={form.text}
                      className="font-mono text-xs"
                      placeholder="粘贴 base64 / Clash YAML / Xray JSON / sing-box JSON / 明文链接"
                      onChange={(event) => update("text", event.target.value)}
                    />
                    <FieldDescription>内联文本只保存在面板数据库中，定时同步时直接解析，不访问外部 URL。</FieldDescription>
                  </Field>
                </TabsContent>
              </Tabs>
            ) : item?.inline ? (
              <Field>
                <FieldLabel htmlFor="sub-text">内联文本</FieldLabel>
                <Textarea
                  id="sub-text"
                  rows={8}
                  value={form.text}
                  className="font-mono text-xs"
                  placeholder="留空则保持当前内联文本不变（内容不会回显）"
                  onChange={(event) => update("text", event.target.value)}
                />
                <FieldDescription>该订阅是内联文本订阅；粘贴新内容可整体替换，留空保持不变。</FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="sub-url">订阅 URL</FieldLabel>
                <Input
                  id="sub-url"
                  type="url"
                  value={form.url}
                  placeholder="https://example.com/sub?token=…"
                  onChange={(event) => update("url", event.target.value)}
                />
                <FieldDescription>如需改为内联文本，请新建一个「粘贴内联文本」订阅，避免同步来源混淆。</FieldDescription>
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>格式提示</FieldLabel>
                <Select value={form.formatHint} onValueChange={(value) => update("formatHint", value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMAT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>无法自动识别时手动指定</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-interval">同步间隔（秒）</FieldLabel>
                <Input
                  id="sub-interval"
                  type="number"
                  min={60}
                  inputMode="numeric"
                  value={form.intervalSec}
                  placeholder="留空 = 手动同步"
                  onChange={(event) => update("intervalSec", event.target.value)}
                />
                <FieldDescription>默认 21600 秒（6 小时）</FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="sub-cron">或 cron 表达式</FieldLabel>
              <Input
                id="sub-cron"
                value={form.cron}
                placeholder="0 */6 * * *"
                onChange={(event) => update("cron", event.target.value)}
                className="font-mono"
              />
              <FieldDescription>填写 cron 后优先按 cron 调度；两者都为空时只支持手动同步。</FieldDescription>
            </Field>

            <Field orientation="horizontal" className="rounded-lg border p-3">
              <FieldContent>
                <FieldTitle>启用订阅</FieldTitle>
                <FieldDescription>关闭后不再定时同步，已有节点按发布策略保留或标记消失。</FieldDescription>
              </FieldContent>
              <Switch checked={form.enabled} onCheckedChange={(checked) => update("enabled", checked)} aria-label="启用订阅" />
            </Field>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="flex h-auto w-full items-center justify-between rounded-none px-3 py-2">
                  <span className="text-sm font-medium">高级选项（超时 / 重试 / User-Agent）</span>
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 border-t p-3">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="sub-timeout">拉取超时（毫秒）</FieldLabel>
                    <Input
                      id="sub-timeout"
                      type="number"
                      min={1000}
                      max={300000}
                      inputMode="numeric"
                      value={form.timeoutMs}
                      placeholder="20000"
                      onChange={(event) => update("timeoutMs", event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="sub-retries">重试次数</FieldLabel>
                    <Input
                      id="sub-retries"
                      type="number"
                      min={0}
                      max={10}
                      inputMode="numeric"
                      value={form.retries}
                      placeholder="2"
                      onChange={(event) => update("retries", event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="sub-ua">User-Agent</FieldLabel>
                    <Input
                      id="sub-ua"
                      value={form.userAgent}
                      placeholder="留空使用系统默认"
                      onChange={(event) => update("userAgent", event.target.value)}
                    />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">留空表示使用 settings.subsync 中的系统默认值。</p>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>

          {showText ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <LoadingButton
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={preview.pending}
                  loadingText="解析中…"
                  disabled={!form.text.trim()}
                  title={!form.text.trim() ? "先粘贴节点文本才能预览" : "解析粘贴的文本"}
                  onClick={() => void runPreview()}
                >
                  <Eye data-icon="inline-start" />
                  解析预览
                </LoadingButton>
                {previewResult || previewError ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setPreviewResult(null); setPreviewError(null); setPreviewOpen(false) }}>
                    收起预览
                  </Button>
                ) : null}
                <span className="text-xs text-muted-foreground">预览不落库，也不会改变已有节点</span>
              </div>
              {previewOpen ? (
                <div className="rounded-lg border bg-muted/10 p-3">
                  {preview.pending ? (
                    <p className="text-xs text-muted-foreground">正在解析…</p>
                  ) : previewError ? (
                    <ErrorState error={previewError} title="解析失败" compact onRetry={() => void runPreview()} />
                  ) : previewResult ? (
                    <PreviewResult result={previewResult} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" disabled={save.pending} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <LoadingButton type="submit" loading={save.pending} loadingText={isEdit ? "保存中…" : "创建中…"}>
              {isEdit ? "保存" : "创建订阅"}
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
