import { useMemo, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import { Info, KeyRound, Plus, Search, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/common/page-header"
import { DataTable, type DataTableColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime, TimeText } from "@/components/common/relative-time"
import { useConfirm } from "@/components/common/confirm-dialog"
import { CreateKeyDialog } from "@/components/credentials/create-key-dialog"
import { isKeyActive, type ApiKeyItem, type KeysResponse } from "@/components/credentials/types"
import { eden, unwrap } from "@/lib/api"
import { fmtNumber } from "@/lib/format"
import { useNow, useResource } from "@/lib/hooks"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "API Key · xc-p" }] }))
  .page(() => <CredentialsPage />)

const STATUS_ALL = "__all__"
const STATUS_ACTIVE = "active"
const STATUS_REVOKED = "revoked"

type SortKey = "name" | "createdAt" | "lastUsedAt"

export function CredentialsPage() {
  const confirm = useConfirm()
  const now = useNow(30_000)
  const keys = useResource<KeysResponse>("credentials:keys", (signal) => unwrap(eden.api.keys.get({ fetch: { signal } })), {
    pollMs: 30_000,
  })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState(STATUS_ALL)
  const [sortKey, setSortKey] = useState<SortKey>("createdAt")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const items = useMemo(() => keys.data?.items ?? [], [keys.data])
  const scopes = useMemo(() => keys.data?.scopes ?? [], [keys.data])
  const activeCount = items.filter((item) => isKeyActive(item, now)).length

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = items.filter((item) => {
      if (status === STATUS_ACTIVE && !isKeyActive(item, now)) return false
      if (status === STATUS_REVOKED && isKeyActive(item, now)) return false
      if (!needle) return true
      const haystack = [item.name, item.prefix, ...(item.scopes ?? []), ...(item.ipAllowlist ?? [])].join(" ").toLowerCase()
      return haystack.includes(needle)
    })
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name, "zh-CN")
      const av = sortKey === "createdAt" ? a.createdAt : a.lastUsedAt ?? 0
      const bv = sortKey === "createdAt" ? b.createdAt : b.lastUsedAt ?? 0
      return av - bv
    })
    return sortDir === "asc" ? sorted : sorted.reverse()
  }, [items, now, query, sortDir, sortKey, status])

  const filtering = query.trim() !== "" || status !== STATUS_ALL

  const onSortChange = (key: string) => {
    if (key !== "name" && key !== "createdAt" && key !== "lastUsedAt") return
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "name" ? "asc" : "desc")
    }
  }

  const revoke = async (key: ApiKeyItem) => {
    await confirm({
      title: "吊销 API Key？",
      description: "吊销立即生效且不可恢复，只能重新创建。",
      details: (
        <div className="space-y-1 text-xs">
          <p>
            名称：<span className="font-medium">{key.name}</span>
          </p>
          <p>
            前缀：<span className="font-mono">{key.prefix}</span>
          </p>
          <p>
            scope：<span className="font-mono">{key.scopes.join(", ") || "—"}</span>
          </p>
          <p className="text-muted-foreground">影响：使用该 Key 的服务 API 调用会立即返回 401；面板会话不受影响。</p>
        </div>
      ),
      destructive: true,
      confirmText: "吊销 Key",
      action: async () => {
        await unwrap(eden.api.keys({ id: key.id }).delete())
        toast.success("已吊销「" + key.name + "」")
        keys.refresh()
      },
    })
  }

  const columns: DataTableColumn<ApiKeyItem>[] = [
    {
      key: "name",
      header: "名称",
      sortable: true,
      cell: (key) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{key.name || "—"}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{key.prefix}…</p>
          <div className="mt-1 flex flex-wrap items-center gap-1 md:hidden">
            {key.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-normal text-muted-foreground">
                {scope}
              </Badge>
            ))}
            <span className="text-[11px] text-muted-foreground">
              · {key.lastUsedAt ? <RelativeTime ts={key.lastUsedAt} /> : "从未使用"}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: "scopes",
      header: "Scope",
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (key) =>
        key.scopes.length ? (
          <div className="flex flex-wrap gap-1">
            {key.scopes.map((scope) => (
              <Badge
                key={scope}
                variant="outline"
                className={
                  "font-normal " + (scope === "admin" ? "border-warning/50 text-warning" : "text-muted-foreground")
                }
              >
                {scope}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: "allowlist",
      header: "IP 白名单",
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (key) => {
        const list = key.ipAllowlist ?? []
        if (!list.length) return <span className="text-xs text-muted-foreground">不限</span>
        const visible = list.slice(0, 2).join(", ")
        return (
          <span className="font-mono text-[11px]" title={list.join("\n")}>
            {visible}
            {list.length > 2 ? " +" + (list.length - 2) : ""}
          </span>
        )
      },
    },
    {
      key: "rate",
      header: "限流",
      className: "hidden lg:table-cell",
      headClassName: "hidden lg:table-cell",
      cell: (key) =>
        key.rateLimitPerMin > 0 ? (
          <span className="text-xs tabular-nums">{fmtNumber(key.rateLimitPerMin)}/分</span>
        ) : (
          <span className="text-xs text-muted-foreground">不限</span>
        ),
    },
    {
      key: "lastUsedAt",
      header: "最近使用",
      sortable: true,
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (key) =>
        key.lastUsedAt ? (
          <span className="text-xs">
            <RelativeTime ts={key.lastUsedAt} />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">从未</span>
        ),
    },
    {
      key: "createdAt",
      header: "创建时间",
      sortable: true,
      className: "hidden md:table-cell",
      headClassName: "hidden md:table-cell",
      cell: (key) => (
        <span className="text-xs text-muted-foreground">
          <TimeText ts={key.createdAt} />
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (key) => {
        if (key.revokedAt) {
          return (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              已吊销
            </Badge>
          )
        }
        if (key.expiresAt && key.expiresAt < now) {
          return (
            <Badge variant="outline" className="border-destructive/40 font-normal text-destructive">
              已过期
            </Badge>
          )
        }
        return (
          <Badge variant="outline" className="border-success/40 font-normal text-success">
            <ShieldCheck data-icon="inline-start" className="size-3" />
            有效
          </Badge>
        )
      },
    },
    {
      key: "actions",
      header: "操作",
      className: "w-px text-right",
      headClassName: "w-px text-right",
      cell: (key) =>
        isKeyActive(key, now) ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => void revoke(key)}
          >
            吊销
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">已失效</span>
        ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API Key"
        description="服务 API 走 Authorization: Bearer &lt;key&gt;。库里只存 sha256 哈希，明文仅在创建响应中出现一次。"
        updatedAt={keys.updatedAt || undefined}
        onRefresh={keys.refresh}
        refreshing={keys.refreshing}
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus data-icon="inline-start" />
            新建 Key
          </Button>
        }
      />

      <Alert>
        <Info />
        <AlertTitle>Key 的属性创建后不可修改</AlertTitle>
        <AlertDescription>
          scope、IP 白名单与限流都写死在创建时（服务端未提供 PATCH）；需要调整请新建一个 Key，并吊销旧的。吊销不可恢复。
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称 / 前缀 / scope / IP"
              aria-label="搜索 API Key"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger size="sm" className="w-[122px]" aria-label="状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={STATUS_ALL}>全部状态</SelectItem>
              <SelectItem value={STATUS_ACTIVE}>仅有效</SelectItem>
              <SelectItem value={STATUS_REVOKED}>仅已吊销</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            共 {fmtNumber(items.length)} 个 · {fmtNumber(activeCount)} 个有效
            {filtering && rows.length !== items.length ? " · 筛选出 " + rows.length + " 个" : ""}
          </span>
        </div>

        {keys.error && !keys.data ? (
          <ErrorState error={keys.error} title="API Key 列表加载失败" onRetry={keys.refresh} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(key) => key.id}
            loading={keys.loading && !keys.data}
            loadingRows={5}
            sort={sortKey}
            sortDir={sortDir}
            onSortChange={onSortChange}
            empty={
              <EmptyState
                icon={KeyRound}
                title={items.length === 0 ? "还没有 API Key" : "没有匹配的 Key"}
                description={
                  items.length === 0
                    ? "创建后明文 secret 只显示一次；服务 API 用 Authorization: Bearer <key> 调用。"
                    : "当前搜索或状态筛选下没有结果，试试清空筛选。"
                }
                action={
                  items.length === 0 ? (
                    <Button size="sm" onClick={() => setDialogOpen(true)}>
                      <Plus data-icon="inline-start" />
                      新建 Key
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setQuery("")
                        setStatus(STATUS_ALL)
                      }}
                    >
                      清空筛选
                    </Button>
                  )
                }
              />
            }
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          提示：<span className="font-mono">/v1/*</span> 接口用 API Key 鉴权；面板会话用 HttpOnly Cookie，两者完全分离。scope 为{" "}
          <span className="font-mono">admin</span> 的 Key 等价于运维权限，请只放在本机或 CI 的密钥库。
        </p>
      </div>

      <CreateKeyDialog
        open={dialogOpen}
        scopes={scopes}
        onOpenChange={setDialogOpen}
        onCreated={keys.refresh}
      />
    </div>
  )
}
