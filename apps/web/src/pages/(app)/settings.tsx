import { useEffect, useMemo, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import { Search, Settings2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { useConfirm } from "@/components/common/confirm-dialog"
import { SettingsGroupCard } from "@/components/settings/group-card"
import { PasswordCard } from "@/components/settings/password-card"
import { SelfCheckCard } from "@/components/settings/self-check-card"
import {
  fieldMatches,
  formKey,
  groupFormFromSettings,
  isGroupDirty,
  pickGroupForm,
  serializeGroup,
  SETTINGS_GROUPS,
  settingsToForm,
  type FormState,
  type FormValue,
  type SettingsGroup,
  type SettingsGroupKey,
} from "@/components/settings/schema"
import { describeError, eden, unwrap } from "@/lib/api"
import { useResource } from "@/lib/hooks"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "系统设置 · xc-p" }] }))
  .page(() => <SettingsPage />)

interface SettingsResponse {
  settings: Record<string, unknown>
}

const PAGE_TITLE = "系统设置"
const PAGE_SUMMARY = "集中管理面板、网关、数据面、订阅、检测与指标参数；每组独立保存，改完立即生效。"

export function SettingsPage() {
  const confirm = useConfirm()
  // 设置是服务端的弱类型配置包（Settings 接口），这里沿用页面既有的 Record 视图。
  const resource = useResource<SettingsResponse>("settings:root", async (signal) => {
    const data = await unwrap(eden.api.settings.get({ fetch: { signal } }))
    return data as unknown as SettingsResponse
  })
  const [form, setForm] = useState<FormState>({})
  const [baseline, setBaseline] = useState<FormState>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingGroup, setSavingGroup] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<SettingsGroupKey>("panel")
  const [query, setQuery] = useState("")

  // 首次加载与手动刷新时，用服务端值重置草稿与基线。
  useEffect(() => {
    if (!resource.data?.settings) return
    const next = settingsToForm(resource.data.settings)
    setForm(next)
    setBaseline(next)
    setErrors({})
  }, [resource.data])

  const dirtyGroups = useMemo(
    () => SETTINGS_GROUPS.filter((group) => isGroupDirty(group, form, baseline)),
    [baseline, form],
  )

  const matches = useMemo(
    () => SETTINGS_GROUPS.reduce((count, group) => count + group.fields.filter((field) => fieldMatches(field, query)).length, 0),
    [query],
  )
  const noMatches = query.trim() !== "" && matches === 0

  const changedCount = (group: SettingsGroup) =>
    group.fields.filter((field) => (form[formKey(group.key, field.path)] ?? "") !== (baseline[formKey(group.key, field.path)] ?? ""))
      .length

  const errorCount = (group: SettingsGroup) =>
    group.fields.filter((field) => !!errors[formKey(group.key, field.path)]).length

  const groupMatches = (group: SettingsGroup) => group.fields.filter((field) => fieldMatches(field, query)).length

  /** 搜索时当前分组无命中但其它分组有命中，就切到第一个有命中的分组（放在输入事件里，避免 effect 回弹）。 */
  const handleQueryChange = (value: string) => {
    setQuery(value)
    if (value.trim() === "") return
    const current = SETTINGS_GROUPS.find((group) => group.key === activeGroup)
    if (current && current.fields.some((field) => fieldMatches(field, value))) return
    const next = SETTINGS_GROUPS.find((group) => group.fields.some((field) => fieldMatches(field, value)))
    if (next) setActiveGroup(next.key)
  }

  const stripGroupErrors = (group: SettingsGroup) => {
    setErrors((prev) => {
      const next: Record<string, string> = {}
      for (const [key, message] of Object.entries(prev)) {
        if (!key.startsWith(group.key + ".")) next[key] = message
      }
      return next
    })
  }

  const handleChange = (group: SettingsGroup, path: string, value: FormValue) => {
    setForm((prev) => ({ ...prev, [formKey(group.key, path)]: value }))
    stripGroupErrors(group)
  }

  const persistGroup = async (group: SettingsGroup, values: Record<string, unknown>) => {
    setSavingGroup(group.key)
    try {
      const response = await unwrap(eden.api.settings.patch({ [group.key]: values }))
      const nextGroupForm = groupFormFromSettings(response.settings as unknown as Record<string, unknown>, group)
      setForm((prev) => ({ ...prev, ...nextGroupForm }))
      setBaseline((prev) => ({ ...prev, ...nextGroupForm }))
      stripGroupErrors(group)
      toast.success("「" + group.title + "」已保存并立即生效")
    } catch (caught) {
      toast.error("「" + group.title + "」保存失败", { description: describeError(caught) })
      throw caught
    } finally {
      setSavingGroup(null)
    }
  }

  const saveGroup = async (group: SettingsGroup) => {
    const serialized = serializeGroup(group, form)
    if (Object.keys(serialized.errors).length > 0) {
      setErrors((prev) => ({ ...prev, ...serialized.errors }))
      const first = Object.values(serialized.errors)[0]
      toast.error("「" + group.title + "」校验未通过", { description: first })
      return
    }
    if (!isGroupDirty(group, form, baseline)) {
      toast.info("「" + group.title + "」没有未保存的修改")
      return
    }

    if (group.key !== "gateway") {
      await persistGroup(group, serialized.values).catch(() => {})
      return
    }

    const nextListen = String(form[formKey("gateway", "listen")] ?? "")
    const prevListen = String(baseline[formKey("gateway", "listen")] ?? "")
    const enabled = form[formKey("gateway", "enabled")] === true
    const tls = form[formKey("gateway", "tls.enabled")] === true
    const authMode = String(form[formKey("gateway", "authMode")] ?? "strict")
    await confirm({
      title: "保存网关配置并重建 listener？",
      description: "网关配置的任何改动都会重建监听器，正在建立的连接会短暂中断。",
      details: (
        <div className="space-y-1 text-xs">
          <p>
            监听：<span className="font-mono">{prevListen || "—"}</span> → <span className="font-mono">{nextListen || "—"}</span>
          </p>
          <p>
            状态：{enabled ? "启用" : "禁用"} · TLS：{tls ? "开启" : "关闭"} · 认证：{authMode}
          </p>
          <p className="text-muted-foreground">
            影响：listener 重建期间新连接会失败约 1 秒，已建立的连接会被断开；客户端重试即可恢复。
          </p>
        </div>
      ),
      confirmText: "保存并重建",
      action: async () => {
        await persistGroup(group, serialized.values)
      },
    })
  }

  const resetGroup = (group: SettingsGroup) => {
    const groupBaseline = pickGroupForm(group, baseline)
    setForm((prev) => ({ ...prev, ...groupBaseline }))
    stripGroupErrors(group)
    toast.info("已把「" + group.title + "」重置为服务端当前值")
  }

  const resetAll = () => {
    setForm(baseline)
    setErrors({})
    toast.info("已放弃全部未保存修改")
  }

  const handleRefresh = async () => {
    if (dirtyGroups.length > 0) {
      const ok = await confirm({
        title: "放弃未保存的修改？",
        description: "重新加载会用服务端当前值覆盖所有未保存的改动。",
        destructive: true,
        confirmText: "放弃并刷新",
        action: async () => undefined,
      })
      if (!ok) return
    }
    resource.refresh()
  }

  const sortedDirtyTitles = dirtyGroups.map((group) => group.title).join("、")

  if (resource.error && !resource.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={PAGE_TITLE}
          description={PAGE_SUMMARY}
          onRefresh={resource.refresh}
          refreshing={resource.refreshing}
        />
        <ErrorState error={resource.error} title="设置加载失败" onRetry={resource.refresh} />
      </div>
    )
  }

  if (resource.loading && !resource.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={PAGE_TITLE} description={PAGE_SUMMARY} />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-3 rounded-xl border p-5">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
              {index === 0 ? <Skeleton className="h-24 w-full" /> : null}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={PAGE_TITLE}
        description="全部可调参数存于 settings 表并由服务端 schema 校验：面板是唯一配置入口，每组独立保存、立即生效，不需要改文件或重启容器。"
        updatedAt={resource.updatedAt || undefined}
        onRefresh={() => void handleRefresh()}
        refreshing={resource.refreshing}
      />

      {dirtyGroups.length > 0 ? (
        <Alert className="border-warning/40 bg-warning/10">
          <TriangleAlert className="text-warning" />
          <AlertTitle className="text-warning">有 {dirtyGroups.length} 组未保存修改</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
            <span>{sortedDirtyTitles}。改动只在点击各组「保存本组」后提交；切走页面前记得保存。</span>
            <Button variant="outline" size="sm" onClick={resetAll}>
              全部重置
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <SelfCheckCard />

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Settings2 className="size-4 text-primary" />
              参数分组
            </h2>
            <p className="text-xs text-muted-foreground">点击标签切换分组；每组只提交本组字段，不覆盖其它组。</p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder="搜索设置项（例如 并发、端口、cron）"
              aria-label="搜索设置项"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>

        {noMatches ? (
          <EmptyState
            icon={Search}
            title="没有匹配的设置项"
            description="换个关键词试试，例如「并发」「端口」「超时」「cron」。"
            compact
            action={
              <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                清空搜索
              </Button>
            }
          />
        ) : (
          <Tabs
            value={activeGroup}
            onValueChange={(value) => setActiveGroup(value as SettingsGroupKey)}
            className="gap-3"
          >
            <TabsList className="h-auto! w-full flex-wrap justify-start gap-1">
              {SETTINGS_GROUPS.map((group) => {
                const Icon = group.icon
                const matched = groupMatches(group)
                const dirty = dirtyGroups.some((item) => item.key === group.key)
                const groupErrors = errorCount(group)
                return (
                  <TabsTrigger key={group.key} value={group.key} className="flex-none">
                    <Icon />
                    {group.title}
                    {query.trim() === "" ? (
                      <>
                        {dirty ? <span aria-label="有未保存修改" className="size-1.5 rounded-full bg-warning" /> : null}
                        {groupErrors > 0 ? (
                          <span
                            aria-label={"有 " + groupErrors + " 项校验错误"}
                            className="size-1.5 rounded-full bg-destructive"
                          />
                        ) : null}
                      </>
                    ) : matched > 0 ? (
                      <span className="text-xs tabular-nums text-muted-foreground">{matched}</span>
                    ) : null}
                  </TabsTrigger>
                )
              })}
            </TabsList>

            {SETTINGS_GROUPS.map((group) => (
              <TabsContent key={group.key} value={group.key}>
                <SettingsGroupCard
                  group={group}
                  form={form}
                  errors={errors}
                  dirty={dirtyGroups.some((item) => item.key === group.key)}
                  changedCount={changedCount(group)}
                  errorCount={errorCount(group)}
                  saving={savingGroup === group.key}
                  query={query}
                  onChange={(path, value) => handleChange(group, path, value)}
                  onSave={() => void saveGroup(group)}
                  onReset={() => resetGroup(group)}
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      <PasswordCard />

      <p className="text-[11px] text-muted-foreground">
        安全提示：数据面管理口与 metrics 只应绑环回地址；网关若暴露公网，请开启 TLS 或在前置反代做 TLS 终止。设置变更会写入审计日志（settings.update）。
      </p>
    </div>
  )
}