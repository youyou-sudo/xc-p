import { useMemo, useState } from "react"
import { Search, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/common/empty-state"
import { SectionCard } from "@/components/common/section-card"
import { fmtNumber, fmtPercent } from "@/lib/format"
import type { AggregateRow, KickPayload } from "./types"

interface AggregateTableProps {
  kind: "node" | "user" | "ip"
  title: string
  description: string
  rows: AggregateRow[]
  loading: boolean
  emptyTitle: string
  emptyDescription: string
  onKick: (payload: KickPayload, what: string, affected: number) => void
}

const KIND_LABEL: Record<AggregateTableProps["kind"], string> = {
  node: "节点",
  user: "用户",
  ip: "IP",
}

/** 按节点 / 用户名 / IP 聚合的活跃连接表，每行可一次断开该分组的全部连接。 */
export function AggregateTable({
  kind,
  title,
  description,
  rows,
  loading,
  emptyTitle,
  emptyDescription,
  onKick,
}: AggregateTableProps) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? rows.filter((row) => row.key.toLowerCase().includes(needle)) : rows
  }, [rows, query])
  const total = useMemo(() => rows.reduce((sum, row) => sum + row.count, 0), [rows])

  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        <div className="relative w-full sm:w-52">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={"搜索" + KIND_LABEL[kind]}
            className="h-8 pl-8"
            aria-label={"搜索" + KIND_LABEL[kind]}
          />
        </div>
      }
    >
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title={query.trim() ? "没有匹配的" + KIND_LABEL[kind] : emptyTitle} description={query.trim() ? "换个关键词试试。" : emptyDescription} compact />
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{KIND_LABEL[kind]}</TableHead>
                <TableHead>连接数</TableHead>
                <TableHead className="hidden sm:table-cell">占比</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const share = total > 0 ? row.count / total : 0
                return (
                  <TableRow key={row.key}>
                    <TableCell className="max-w-64">
                      <span className="block truncate font-mono text-xs" title={row.key}>
                        {row.key}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{fmtNumber(row.count)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: Math.max(2, share * 100) + "%" }} />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtPercent(share, 0)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={() =>
                          onKick(
                            kind === "node" ? { nodeId: row.key } : kind === "user" ? { username: row.key } : { ip: row.key },
                            KIND_LABEL[kind] + " " + row.key,
                            row.count,
                          )
                        }
                      >
                        <Unplug data-icon="inline-start" />
                        全部断开
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  )
}
