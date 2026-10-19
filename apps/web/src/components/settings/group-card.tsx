// I have nothing but my burger and I want nothing more
import { RotateCcw, Save } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { LoadingButton } from "@/components/common/loading-button"
import { cn } from "@/lib/utils"
import { FieldControl } from "./field-control"
import {
  fieldMatches,
  formKey,
  type FormState,
  type FormValue,
  type SettingsField,
  type SettingsGroup,
} from "./schema"

interface SettingsGroupCardProps {
  group: SettingsGroup
  form: FormState
  errors: Record<string, string>
  dirty: boolean
  changedCount: number
  errorCount: number
  saving: boolean
  query: string
  onChange: (path: string, value: FormValue) => void
  onSave: () => void
  onReset: () => void
}

export function SettingsGroupCard({
  group,
  form,
  errors,
  dirty,
  changedCount,
  errorCount,
  saving,
  query,
  onChange,
  onSave,
  onReset,
}: SettingsGroupCardProps) {
  const Icon = group.icon
  const searching = query.trim() !== ""
  const fields: SettingsField[] = searching ? group.fields.filter((field) => fieldMatches(field, query)) : group.fields

  return (
    <Card
      className={cn("gap-0 overflow-hidden py-0 shadow-xs transition-colors", dirty && "border-warning/50")}
      data-testid={"settings-group-" + group.key}
    >
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Icon className="size-4 text-primary" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{group.title}</h3>
            {dirty ? (
              <Badge variant="outline" className="gap-1.5 border-warning/50 font-normal text-warning">
                <span className="size-1.5 rounded-full bg-warning" />
                {changedCount} 项未保存
              </Badge>
            ) : null}
            {errorCount > 0 ? (
              <Badge variant="outline" className="border-destructive/40 font-normal text-destructive">
                {errorCount} 项待修正
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{group.description}</p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        {searching && fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">本组没有匹配「{query.trim()}」的设置项。</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <FieldControl
                key={field.path}
                group={group.key}
                field={field}
                value={form[formKey(group.key, field.path)] ?? (field.type === "boolean" ? false : "")}
                error={errors[formKey(group.key, field.path)]}
                disabled={saving}
                onChange={(value) => onChange(field.path, value)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <LoadingButton
            size="sm"
            loading={saving}
            loadingText="保存中…"
            disabled={!dirty || errorCount > 0}
            onClick={onSave}
          >
            <Save data-icon="inline-start" />
            保存本组
          </LoadingButton>
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={onReset}>
            <RotateCcw data-icon="inline-start" />
            重置
          </Button>
          <span className={cn("text-xs", dirty ? "text-warning" : "text-muted-foreground")}>
            {errorCount > 0
              ? "有字段未通过校验，修正后才能保存"
              : dirty
                ? "修改只在点击「保存本组」后提交并立即生效"
                : "与服务端当前值一致"}
          </span>
        </div>
      </div>
    </Card>
  )
}
