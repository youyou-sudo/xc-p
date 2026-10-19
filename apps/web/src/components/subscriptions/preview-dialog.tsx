import { useEffect, useState } from "react"
import { Play } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError, eden, unwrap } from "@/lib/api"
import { useAction } from "@/lib/hooks"
import { FORMAT_OPTIONS } from "./format"
import { PreviewResult } from "./preview-result"
import type { PreviewResponse } from "./types"

interface ParsePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传入订阅时走 POST /subscriptions/:id/test（格式提示使用该订阅的配置）。 */
  target?: { id: string; name: string; formatHint: string } | null
}

const PLACEHOLDER = "粘贴订阅内容：明文链接（vless://… / ss://…）、Base64、Clash YAML、Xray JSON 或 sing-box JSON"

export function ParsePreviewDialog({ open, onOpenChange, target = null }: ParsePreviewDialogProps) {
  const isTest = !!target
  const [text, setText] = useState("")
  const [hint, setHint] = useState("auto")
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!open) return
    setText("")
    setHint(target?.formatHint || "auto")
    setResult(null)
    setError(null)
  }, [open, target?.id, target?.formatHint])

  const parse = useAction(async (payload: { text: string; formatHint: string }) => {
    if (target) return unwrap(eden.api.subscriptions({ id: target.id }).test.post(payload))
    return unwrap(eden.api.subscriptions.preview.post(payload))
  })

  async function run() {
    if (!text.trim()) {
      toast.error("请先粘贴节点文本", { description: "解析预览只读取粘贴的文本，不会访问外部 URL。" })
      return
    }
    setError(null)
    try {
      const res = await parse.run({ text, formatHint: hint })
      setResult(res)
      if (res.total === 0) {
        toast.warning("解析完成，但没有识别出节点", { description: "请检查格式提示或源内容。" })
      } else {
        toast.success("解析完成", { description: "识别格式 " + res.format + " · " + res.total + " 个节点 · 新增 " + res.diff.added })
      }
    } catch (caught) {
      setError(caught)
      toast.error(isTest ? "测试解析失败" : "解析预览失败", { description: describeError(caught) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isTest ? "测试解析 · " + target?.name : "解析预览"}</DialogTitle>
          <DialogDescription>
            {isTest
              ? "使用该订阅的格式提示解析粘贴的文本；只读解析，不落库、不改期望状态，也不会访问订阅 URL。"
              : "POST /api/subscriptions/preview · 只做解析与 diff 计算，不落库、不改期望状态。"}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="preview-text">节点文本（原文）</FieldLabel>
            <Textarea
              id="preview-text"
              rows={7}
              value={text}
              placeholder={PLACEHOLDER}
              className="font-mono text-xs"
              onChange={(event) => setText(event.target.value)}
            />
            <FieldDescription>支持明文链接、Base64、Clash YAML、Xray JSON、sing-box JSON；自动识别失败时可手动指定格式。</FieldDescription>
          </Field>
          <Field className="sm:max-w-60">
            <FieldLabel>格式提示</FieldLabel>
            <Select value={hint} onValueChange={setHint}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="自动识别" />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>auto 会按内容自动探测格式</FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap items-center gap-2">
          <LoadingButton type="button" loading={parse.pending} loadingText="解析中…" onClick={() => void run()}>
            <Play data-icon="inline-start" />
            解析
          </LoadingButton>
          {result || error ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setResult(null)
                setError(null)
              }}
            >
              清空结果
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">解析不产生任何写入</span>
        </div>

        {parse.pending ? (
          <div className="space-y-2" aria-live="polite">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error ? (
          <ErrorState error={error} title="解析失败" compact onRetry={() => void run()} />
        ) : result ? (
          <PreviewResult result={result} />
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
