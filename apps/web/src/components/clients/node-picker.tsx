import { useMemo, useState } from "react"
import { Check, Filter, Search, Server, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { Dot } from "@/components/common/status-badge"
import { fmtMs, stateMeta } from "@/lib/format"
import { cn } from "@/lib/utils"
import { countryLabel, nodeRegion } from "./labels"
import { nodeState, type ClientNode } from "./types"

interface NodePickerProps {
  nodes: ClientNode[]
  loading: boolean
  error: unknown
  selectedId: string | null
  onSelect: (id: string) => void
  onRetry: () => void
  onGoSubscriptions: () => void
}

const ALL = "__all__"

/** 节点选择器：搜索 + 地区/协议筛选 + 仅启用；点一行即切换右侧连接串。 */
export function NodePicker({ nodes, loading, error, selectedId, onSelect, onRetry, onGoSubscriptions }: NodePickerProps) {
  const [query, setQuery] = useState("")
  const [region, setRegion] = useState(ALL)
  const [protocol, setProtocol] = useState(ALL)
  const [enabledOnly, setEnabledOnly] = useState(false)

  const regions = useMemo(() => {
    const set = new Set<string>()
    for (const node of nodes) {
      const code = nodeRegion(node)
      if (code) set.add(code)
    }
    return Array.from(set).sort()
  }, [nodes])

  const protocols = useMemo(() => {
    const set = new Set<string>()
    for (const node of nodes) {
      if (node.protocol) set.add(node.protocol)
    }
    return Array.from(set).sort()
  }, [nodes])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return nodes.filter((node) => {
      if (enabledOnly && !node.enabled) return false
      if (region !== ALL && nodeRegion(node) !== region) return false
      if (protocol !== ALL && (node.protocol ?? "") !== protocol) return false
      if (needle) {
        const haystack = (node.id + " " + (node.displayName ?? "") + " " + (node.username ?? "")).toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [nodes, enabledOnly, protocol, query, region])

  const filtering = query.trim() !== "" || region !== ALL || protocol !== ALL || enabledOnly

  const resetFilters = () => {
    setQuery("")
    setRegion(ALL)
    setProtocol(ALL)
    setEnabledOnly(false)
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4 text-primary" />
          选择节点
        </CardTitle>
        <CardDescription>
          {loading && nodes.length === 0
            ? "正在读取节点池…"
            : "共 " + nodes.length + " 个节点，可按名称 / 地区 / 协议筛选；点击一行生成连接串。"}
        </CardDescription>
        <CardAction>
          <Badge variant="secondary" className="font-normal">
            <Filter data-icon="inline-start" className="size-3" />
            {filtered.length} / {nodes.length}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节点 ID / 名称"
              aria-label="搜索节点"
              className="h-8 pl-8 text-sm"
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
                onClick={() => setQuery("")}
                aria-label="清空搜索"
              >
                <X data-icon="inline-start" />
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger size="sm" className="w-[128px]" aria-label="地区筛选">
                <SelectValue placeholder="全部地区" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部地区</SelectItem>
                {regions.map((code) => (
                  <SelectItem key={code} value={code}>
                    {countryLabel(code)} · {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={protocol} onValueChange={setProtocol}>
              <SelectTrigger size="sm" className="w-[124px]" aria-label="协议筛选">
                <SelectValue placeholder="全部协议" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部协议</SelectItem>
                {protocols.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={enabledOnly} onCheckedChange={setEnabledOnly} aria-label="仅显示已启用节点" />
              仅启用
            </label>
            {filtering ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={resetFilters}>
                清空筛选
              </Button>
            ) : null}
          </div>
        </div>

        {loading && nodes.length === 0 ? (
          <div className="space-y-1.5">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : error && nodes.length === 0 ? (
          <ErrorState error={error} title="节点列表加载失败" compact onRetry={onRetry} />
        ) : nodes.length === 0 ? (
          <EmptyState
            icon={Server}
            title="还没有节点"
            description="客户端接入依赖节点池：先添加订阅并同步，节点会自动出现在这里，然后用节点 ID 生成连接串。"
            compact
            action={
              <Button size="sm" onClick={onGoSubscriptions}>
                去添加订阅
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="没有匹配的节点"
            description="当前筛选条件下没有节点。清空搜索词或切换地区 / 协议后再试。"
            compact
            action={
              <Button size="sm" variant="outline" onClick={resetFilters}>
                清空筛选
              </Button>
            }
          />
        ) : (
          <div className="scrollbar-thin max-h-[420px] space-y-1 overflow-y-auto pr-1" role="listbox" aria-label="节点列表">
            {filtered.map((node) => {
              const active = node.id === selectedId
              const regionCode = nodeRegion(node)
              const state = nodeState(node)
              const meta = stateMeta(state)
              const supported = node.protocolSupported !== false
              return (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid={"clients-node-" + node.id}
                  onClick={() => onSelect(node.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    active && "border-primary/40 bg-accent",
                  )}
                >
                  <Dot tone={meta.tone} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm font-medium", !supported && "text-muted-foreground line-through")}>
                      {node.displayName || node.id}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {node.id}
                      {node.username && node.username !== node.id ? " · " + node.username : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {node.status?.delayMs ? (
                      <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">{fmtMs(node.status.delayMs)}</span>
                    ) : null}
                    {regionCode ? (
                      <Badge variant="outline" className="hidden font-normal sm:inline-flex">
                        {countryLabel(regionCode)}
                      </Badge>
                    ) : null}
                    <Badge variant="secondary" className="font-normal">
                      {node.protocol || "—"}
                    </Badge>
                    {!supported ? (
                      <Badge variant="outline" className="border-warning/50 font-normal text-warning">
                        不可发布
                      </Badge>
                    ) : null}
                    {!node.enabled ? (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        已禁用
                      </Badge>
                    ) : null}
                    <Check className={cn("size-4 text-primary", active ? "opacity-100" : "opacity-0")} />
                  </div>
                </button>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          连接串由 <span className="font-mono">GET /api/nodes/:id/connection</span> 实时生成；密码只在响应里出现，不写入浏览器存储。
        </p>
      </CardContent>
    </Card>
  )
}
