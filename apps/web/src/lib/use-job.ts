import { useCallback, useMemo, useState } from "react"
import { ApiError } from "./api"
import { useAction } from "./hooks"
import { cancelJob, watchJob, type JobOutcome } from "./jobs"

export interface JobProgress {
  jobId: string
  label: string
  progress: number
  total?: number
  message?: string
  status: "running" | "ok" | "failed" | "cancelled"
}

export interface UseJobActionOptions {
  label: string
  start: () => Promise<{ jobId: string | null }>
  onDone?: (outcome: JobOutcome) => void
  onFail?: (outcome: JobOutcome) => void
}

/** 长任务按钮：点击即进入加载态，SSE 进度写入 progress，结束后自动刷新。 */
export function useJobAction(options: UseJobActionOptions) {
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const optionsRef = useMemo(() => options, [options])

  const action = useAction(async () => {
    const { jobId } = await optionsRef.start()
    if (!jobId) throw new ApiError(0, "missing_job_id", optionsRef.label + "：服务端未返回任务号 jobId")
    setProgress({ jobId, label: optionsRef.label, progress: 0, status: "running", message: optionsRef.label + " 已提交" })
    const watcher = watchJob(jobId, {
      label: optionsRef.label,
      onProgress: (message) => {
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                progress: message.progress ?? prev.progress,
                total: message.total ?? prev.total,
                message: message.message || prev.message,
              }
            : prev,
        )
      },
      onDone: () => {
        setProgress((prev) => (prev ? { ...prev, status: "ok", progress: prev.total ?? prev.progress } : prev))
      },
    })
    const outcome = await watcher.done
    setProgress(null)
    if (outcome.status === "ok") optionsRef.onDone?.(outcome)
    else optionsRef.onFail?.(outcome)
    return outcome
  })

  const cancel = useCallback(() => {
    if (progress) void cancelJob(progress.jobId)
  }, [progress])

  return { ...action, progress, cancel }
}
