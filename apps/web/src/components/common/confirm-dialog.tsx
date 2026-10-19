import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError } from "@/lib/api"

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  details?: ReactNode
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  /** 需要用户原样输入该文本才能确认（如重启数据面输入 RESTART）。 */
  requireText?: string
  /** 点击确认后由弹窗自己执行并显示加载态；抛错时弹窗保持打开并展示错误。 */
  action?: () => Promise<void>
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value)
        return null
      })
      setInput("")
      setError(null)
      setBusy(false)
    },
    [],
  )

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setInput("")
      setError(null)
      setBusy(false)
      setPending({ options, resolve })
    })
  }, [])

  const value = useMemo(() => confirm, [confirm])
  const options = pending?.options
  const textOk = !options?.requireText || input.trim() === options.requireText

  const onConfirm = async () => {
    if (!options || !textOk) return
    if (!options.action) {
      close(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await options.action()
      close(true)
    } catch (caught) {
      setError(describeError(caught))
      setBusy(false)
    }
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={!!options} onOpenChange={(open) => (!open && !busy ? close(false) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {options?.destructive ? <AlertTriangle className="size-4 text-destructive" /> : null}
              {options?.title}
            </AlertDialogTitle>
            {options?.description ? (
              <AlertDialogDescription asChild>
                <div className="text-sm text-muted-foreground">{options.description}</div>
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          {options?.details ? <div className="rounded-lg border bg-muted/30 p-3 text-sm">{options.details}</div> : null}
          {options?.requireText ? (
            <div className="space-y-2">
              <Label htmlFor="confirm-text" className="text-xs text-muted-foreground">
                输入 <span className="font-mono font-semibold text-foreground">{options.requireText}</span> 以确认
              </Label>
              <Input
                id="confirm-text"
                value={input}
                autoFocus
                autoComplete="off"
                onChange={(event) => setInput(event.target.value)}
                aria-invalid={input.length > 0 && !textOk}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={() => close(false)}>
              {options?.cancelText ?? "取消"}
            </AlertDialogCancel>
            <LoadingButton
              variant={options?.destructive ? "destructive" : "default"}
              loading={busy}
              loadingText="执行中…"
              disabled={!textOk}
              onClick={() => void onConfirm()}
            >
              {options?.confirmText ?? "确认"}
            </LoadingButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm 必须在 ConfirmProvider 内使用")
  return ctx
}
