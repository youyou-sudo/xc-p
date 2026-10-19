import { Clock, Play } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusBadge } from "@/components/common/status-badge"
import { cn } from "@/lib/utils"
import { fmtNumber } from "@/lib/format"

export interface PortsStat {
  pool: number
  used: number
  cooling: number
  start?: number
  end?: number
}

export interface SchedulerTask {
  name: string
  everyMs: number
  lastRun: number | null
  running: boolean
}

/** 调度间隔（毫秒）→ 中文文案；与订阅页的 formatInterval(秒) 不同。 */
function formatEvery(ms: number): string {
  const value = Number.isFinite(ms) ? ms : 0
  if (value <= 0) return "—"
  if (value % 3_600_000 === 0) return value / 3_600_000 + " 小时"
  if (value % 60_000 === 0) return value / 60_000 + " 分钟"
  return Math.round(value / 1000) + " 秒"
}

/** 端口池水位：已分配 + 冷却中，剩余可用 = pool - used - cooling */
export function PortWaterline({ ports }: { ports: PortsStat }) {
  const pool = Math.max(1, ports.pool)
  const usedPct = Math.min(100, (ports.used / pool) * 100)
  const coolingPct = Math.min(100 - usedPct, (ports.cooling / pool) * 100)
  const available = Math.max(0, ports.pool - ports.used - ports.cooling)
  const exhausted = ports.used + ports.cooling >= ports.pool
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums">
          {fmtNumber(ports.used)}
          <span className="text-base font-normal text-muted-foreground"> / {fmtNumber(ports.pool)}</span>
        </p>
        <span className="text-xs text-muted-foreground">
          {ports.start !== undefined && ports.end !== undefined ? ports.start + "–" + ports.end : "端口区间未知"}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={"端口已分配 " + ports.used + "，冷却 " + ports.cooling}>
        <span className="h-full bg-primary transition-all" style={{ width: usedPct + "%" }} />
        <span className="h-full bg-warning transition-all" style={{ width: coolingPct + "%" }} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">已分配</dt>
          <dd className="font-medium tabular-nums">{fmtNumber(ports.used)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">冷却中</dt>
          <dd className="font-medium tabular-nums text-warning">{fmtNumber(ports.cooling)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">可用</dt>
          <dd className={cn("font-medium tabular-nums", available === 0 && "text-destructive")}>{fmtNumber(available)}</dd>
        </div>
      </dl>
      {exhausted ? (
        <Alert variant="destructive" className="py-2">
          <AlertTitle>端口池已耗尽</AlertTitle>
          <AlertDescription className="text-xs">发布将中止。请扩大 inbound 端口范围，或等待冷却中的端口回收。</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

/** 热操作计数（ado/rmo 累计）与阈值 */
export function HotOpsMeter({ hot, threshold }: { hot: number; threshold: number }) {
  const safeThreshold = threshold > 0 ? threshold : 1
  const ratio = Math.min(1, hot / safeThreshold)
  const percent = Math.round(ratio * 100)
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums">
          {fmtNumber(hot)}
          <span className="text-base font-normal text-muted-foreground"> / {fmtNumber(threshold)}</span>
        </p>
        <Badge variant="outline" className={cn("font-normal", percent >= 100 ? "text-destructive" : percent >= 80 ? "text-warning" : "text-muted-foreground")}>
          {percent}%
        </Badge>
      </div>
      <Progress
        value={percent}
        className={cn("h-2", percent >= 100 ? "[&>[data-slot=progress-indicator]]:bg-destructive" : percent >= 80 ? "[&>[data-slot=progress-indicator]]:bg-warning" : undefined)}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {percent >= 100
          ? "已超过阈值：Xray 的 RemoveHandler 不释放 mux/xudp 资源，请在维护窗口执行「重启数据面」并重放期望状态。"
          : percent >= 80
            ? "接近阈值：建议在维护窗口安排一次重启 + 重放。"
            : "处于安全范围；每次 ado/rmo 都会累加计数。"}
      </p>
    </div>
  )
}

export function SchedulerList({ tasks }: { tasks: SchedulerTask[] }) {
  if (tasks.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">没有定时任务信息（调度器未启动？）。</p>
  }
  return (
    <ul className="divide-y">
      {tasks.map((task) => (
        <li key={task.name} className="flex items-center gap-3 py-2 text-sm">
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs">{task.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              每 {formatEvery(task.everyMs)} · 上次{" "}
              {task.lastRun ? <RelativeTime ts={task.lastRun} /> : "尚未运行"}
            </p>
          </div>
          {task.running ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-info">
              <Play className="size-3" />
              执行中
            </span>
          ) : (
            <StatusBadge state="idle" label="待命" />
          )}
        </li>
      ))}
    </ul>
  )
}
