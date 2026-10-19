import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { fieldId, type FormValue, type SettingsField, type SettingsGroupKey } from "./schema"

interface FieldControlProps {
  group: SettingsGroupKey
  field: SettingsField
  value: FormValue
  error?: string
  disabled?: boolean
  onChange: (value: FormValue) => void
}

/** 单个设置项控件：布尔用 Switch，枚举用 Select，数组用逐行 Textarea，其余 Input。 */
export function FieldControl({ group, field, value, error, disabled, onChange }: FieldControlProps) {
  const id = fieldId(group, field.path)
  const invalid = !!error
  const wide = field.wide === true

  if (field.type === "boolean") {
    return (
      <Field
        orientation="horizontal"
        data-invalid={invalid}
        className="items-center rounded-lg border px-3 py-2.5 sm:col-span-2"
      >
        <FieldContent>
          <FieldTitle>{field.label}</FieldTitle>
          {field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
          <FieldError>{error}</FieldError>
        </FieldContent>
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          aria-label={field.label}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </Field>
    )
  }

  if (field.type === "enum") {
    const options = field.options ?? []
    const current = String(value ?? "") || options[0]?.value || ""
    return (
      <Field data-invalid={invalid} className={cn(wide && "sm:col-span-2")}>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Select value={current} disabled={disabled} onValueChange={(next) => onChange(next)}>
          <SelectTrigger id={id} className="w-full" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  if (field.type === "textarea" || field.type === "lines") {
    return (
      <Field data-invalid={invalid} className={cn((wide || field.type === "lines") && "sm:col-span-2")}>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Textarea
          id={id}
          rows={field.type === "lines" ? 4 : 3}
          value={String(value ?? "")}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={invalid}
          className={field.type === "lines" ? "font-mono text-xs" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    )
  }

  return (
    <Field data-invalid={invalid} className={cn(wide && "sm:col-span-2")}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        type={field.type === "number" ? "number" : "text"}
        inputMode={field.type === "number" ? "numeric" : undefined}
        value={String(value ?? "")}
        placeholder={field.placeholder}
        disabled={disabled}
        aria-invalid={invalid}
        min={field.min}
        max={field.max}
        step={field.step ?? (field.type === "number" ? "any" : undefined)}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}
