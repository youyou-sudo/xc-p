import { Fragment, type ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface TableColumn<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  className?: string
  headClassName?: string
}

interface ExpandableTableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  loadingRows?: number
  expandedKey: string | null
  onToggle: (key: string) => void
  renderExpanded: (row: T) => ReactNode
  empty?: ReactNode
  dense?: boolean
}

/** 可展开行表格：点击行展开详情，展开行不参与 hover。 */
export function ExpandableTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingRows = 8,
  expandedKey,
  onToggle,
  renderExpanded,
  empty,
  dense,
}: ExpandableTableProps<T>) {
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader className="bg-card">
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead key={column.key} className={cn(dense && "h-9 py-2", column.headClassName)}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, index) => (
              <TableRow key={"skeleton-" + index}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={cn(dense && "py-2", column.className)}>
                    <Skeleton className="h-4 w-full max-w-40" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const key = rowKey(row)
              const open = expandedKey === key
              return (
                <Fragment key={key}>
                  <TableRow
                    className="cursor-pointer"
                    data-state={open ? "selected" : undefined}
                    onClick={() => onToggle(key)}
                  >
                    {columns.map((column) => (
                      <TableCell key={column.key} className={cn(dense && "py-2", column.className)}>
                        {column.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {open ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={columns.length} className="whitespace-normal bg-muted/20 p-3">
                        {renderExpanded(row)}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
