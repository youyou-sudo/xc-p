import { ListChecks, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingButton } from "@/components/common/loading-button"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { jobStatusMeta } from "@/lib/format"

export interface JobItem {
  id: string
  kind: string
  status: string
  priority?: number
  payload_json?: string | null
  progress?: number
  total?: number
  message?: string | null
  started_at?: number | null
  finished_at?: number | null
  created_at?: number
  created_by?: string | null
  result?: unknown
  error?: string | null
}

const JOB_KIND_LABEL: Record<string, string> = {
  sync: "订阅同步",
  sync_all: "全部同步",
  detect: "节点检测",
  publish: "发布",
  rollback: "回滚",
  reconcile: "对账",
  restart: "重启数据面",
}

export function jobKindLabel(kind?: string | null): string {
  if (!kind) return "—"
  return JOB_KIND_LABEL[kind] ?? kind
}

export function JobsTable({
  items,
  loading,
  cancellingId,
  onDetail,
  onCancel,
  onGoRuntime,
}: {
  items: JobItem[]
  loading?: boolean
  cancellingId: string | null
  onDetail: (job: JobItem) => void
  onCancel: (job: JobItem) => void
  onGoRuntime: () => void
}) {
  const columns: DataTableColumn<JobItem>[] = [
    {
      key: "id",
      header: "任务号",
      cell: (job) => (
        <span className="block max-w-40 truncate font-mono text-[11px]" title={job.id}>
          {job.id}
        </span>
      ),
    },
    {
      key: "kind",
      header: "类型",
      cell: (job) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant="secondary" className="font-normal">
            {jobKindLabel(job.kind)}
          </Badge>
          <span className="hidden font-mono text-[10px] text-muted-foreground lg:inline">{job.kind}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (job) => {
        const meta = jobStatusMeta(job.status)
        return <StatusBadge state={job.status} label={meta.label} tone={meta.tone} pulse={job.status === "running"} />
      },
    },
    {
      key: "progress",
      header: "进度",
      cell: (job) => {
        const total = job.total ?? 0
        const percent = total > 0 ? Math.min(100, Math.round(((job.progress ?? 0) / total) * 100)) : job.status === "ok" ? 100 : 0
        if (job.status !== "running" && job.status !== "queued") {
          return (
            <span className="text-xs tabular-nums text-muted-foreground">
              {total ? (job.progress ?? 0) + "/" + total : "—"}
            </span>
          )
        }
        return (
          <span className="flex w-28 items-center gap-2">
            <Progress value={percent} className="h-1.5 flex-1" />
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {job.progress ?? 0}
              {total ? "/" + total : ""}
            </span>
          </span>
        )
      },
    },
    {
      key: "message",
      header: "说明",
      className: "max-w-60",
      cell: (job) => (
        <span className="block truncate text-xs text-muted-foreground" title={job.message ?? ""}>
          {job.message || "—"}
        </span>
      ),
    },
    {
      key: "started",
      header: "开始",
      className: "hidden md:table-cell",
      cell: (job) => (
        <span className="text-xs text-muted-foreground" title={job.started_at ? new Date(job.started_at).toLocaleString("zh-CN") : ""}>
          {job.started_at ? <RelativeTime ts={job.started_at} /> : "—"}
        </span>
      ),
    },
    {
      key: "finished",
      header: "结束",
      className: "hidden lg:table-cell",
      cell: (job) => (
        <span className="text-xs text-muted-foreground" title={job.finished_at ? new Date(job.finished_at).toLocaleString("zh-CN") : ""}>
          {job.finished_at ? <RelativeTime ts={job.finished_at} /> : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">操作</span>,
      className: "text-right",
      cell: (job) => {
        const cancellable = job.status === "queued" || job.status === "running"
        return (
          <span className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            <Button variant="ghost" size="sm" onClick={() => onDetail(job)}>
              详情
            </Button>
            {cancellable ? (
              <LoadingButton
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                loading={cancellingId === job.id}
                loadingText="取消中…"
                onClick={() => onCancel(job)}
              >
                <X data-icon="inline-start" />
                取消
              </LoadingButton>
            ) : null}
          </span>
        )
      },
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={items}
      rowKey={(job) => job.id}
      loading={loading}
      loadingRows={8}
      onRowClick={onDetail}
      empty={
        <EmptyState
          icon={ListChecks}
          title="暂无任务记录"
          description="同步、检测、发布、对账等长任务都会出现在这里，可查看进度、结果与错误。"
          action={
            <Button size="sm" onClick={onGoRuntime}>
              去运行配置发布一次
            </Button>
          }
        />
      }
    />
  )
}
