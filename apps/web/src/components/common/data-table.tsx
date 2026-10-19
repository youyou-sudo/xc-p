import type { ReactNode } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  className?: string
  headClassName?: string
  sortable?: boolean
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  loadingRows?: number
  empty?: ReactNode
  onRowClick?: (row: T) => void
  sort?: string
  sortDir?: "asc" | "desc"
  onSortChange?: (key: string) => void
  className?: string
  dense?: boolean
  rowClassName?: (row: T) => string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingRows = 6,
  empty,
  onRowClick,
  sort,
  sortDir = "asc",
  onSortChange,
  className,
  dense,
  rowClassName,
}: DataTableProps<T>) {
  return (
    <div className={cn("scrollbar-thin overflow-x-auto rounded-lg border", className)}>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const active = sort === column.key
              const sortable = column.sortable && onSortChange
              return (
                <TableHead key={column.key} className={cn(dense && "h-9 py-2", column.headClassName)}>
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange?.(column.key)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-sm text-xs font-medium transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      {column.header}
                      {active ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: loadingRows }).map((_, index) => (
                <TableRow key={"skeleton-" + index}>
                  {columns.map((column) => (
                    <TableCell key={column.key} className={cn(dense && "py-2", column.className)}>
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(onRowClick && "cursor-pointer", rowClassName?.(row))}
                >
                  {columns.map((column) => (
                    <TableCell key={column.key} className={cn(dense && "py-2", column.className)}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          {!loading && rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
