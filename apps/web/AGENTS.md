# xc-p 前端（apps/web/）开发约定与参考

> 本文件是并行开发契约。**先读本文件，再读同目录的参考实现**。
> 设计权威：仓库根 `PANEL.md` §12；组件与字段以本目录当前实现为准。

## 1. 技术栈与目录

- Furin（`@teyik0/furin`）+ React 19 + Elysia（dev server 内）+ Tailwind v4 + shadcn/ui。
- 视觉一律使用 **shadcn 默认样式**：主题 token、字体、圆角沿用 `globals.css` 的默认 slate 主题，不自定义品牌色/字体/渐变；状态色只用语义 token（`success/warning/destructive`）。
- 仓库是 **Bun workspaces monorepo**：`apps/web/` 是 `@xc-p/web` 工作区，API 客户端在 `packages/api-client`。
- 所有页面都是 **SSG 静态页面**（`mode: "ssg"`），**没有服务端 loader**；数据一律在浏览器里通过 **Eden Treaty**（`eden.api.*`）拉取。
- 生产构建：`bun run build`（`furin build --target static`）产出 `apps/web/dist`，再由 `apps/server` 的 Elysia 以 index.html 端点提供。
- 开发：`bun run dev`（端口 3100）→ `/api`、`/v1` 反向代理到控制面（默认 `http://127.0.0.1:3000`，可用 `XCP_API` 覆盖，见 `apps/web/src/server.ts`）。

```
apps/web/src/
  pages/
    root.tsx               文档根（ThemeProvider / ConfirmProvider / Toaster）
    login.tsx              登录（无外壳）
    (app)/_route.tsx       鉴权守卫 + 应用外壳
    (app)/index.tsx        概览  ← 参考实现
    (app)/nodes.tsx        节点
    (app)/subscriptions.tsx
    (app)/detect.tsx
    (app)/runtime.tsx
    (app)/gateway.tsx
    (app)/clients.tsx
    (app)/credentials.tsx
    (app)/settings.tsx
    (app)/events.tsx
  components/ui/           shadcn 组件（CLI 安装，不要手改；未引用的已移除）
  components/layout/       外壳（Lead 所有）
  components/common/       共享业务组件（Lead 所有）
  lib/                     api / session / health / stream / jobs / store / hooks / format / domain（Lead 所有）
```

**写作用域**：每人只改自己负责的 `pages/(app)/xxx.tsx` 和 `components/<page>/…`。
不要改 `lib/**`、`components/common/**`、`components/ui/**`、`components/layout/**`、`globals.css`、`package.json`、`src/server.ts`。
需要共享改动时给 Lead 发消息，Lead 来改。

## 2. 页面骨架（必须照抄结构）

```tsx
import { defineRoute } from "@teyik0/furin"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "页面名 · xc-p" }] }))
  .page(() => <PageName />)

export function PageName() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="…" description="…" updatedAt={…} onRefresh={…} refreshing={…} actions={…} />
      {/* 内容 */}
    </div>
  )
}
```

- 路由文件名决定 URL；不要新增 `pages/(app)/` 之外的页面（除自己的 page 文件）。
- 页面 = 纯客户端组件；`useEffect` / 浏览器 API 没问题。
- 标题用 `PageHeader`，不要自己写 h1 样式。

## 3. 基础库（全部已实现，直接用）

### 请求 `@/lib/api`（Elysia Eden Treaty）
```ts
import { eden, unwrap, startJob, describeError } from "@/lib/api"

// eden 是端到端类型安全的 Eden Treaty 客户端；路径与响应类型来自后端 App
await unwrap(eden.api.nodes.get({ query: { limit: 50 } }))
await unwrap(eden.api.nodes({ id }).rotate.post())
await unwrap(eden.api.nodes["check-batch"].post({ depth: "full" }))
const { jobId } = await startJob(eden.api.subscriptions["sync-all"].post())

ApiError { status, code, message, requestId }
describeError(err): string
normalizeNode(node)  // 把 node.status.* 拍平
```
- `unwrap()`：成功返回 data，失败抛 `ApiError`；**不要再手写 fetch/路径字符串**。
- GET 的取消信号放进 `fetch: { signal }`；查询参数里的 `undefined` 会被 Eden 跳过。
- 所有请求默认 `credentials: "same-origin"`；401 会自动清会话并跳登录。
- 错误必须用 `describeError` 展示，不要拼 `[object Object]`。
- 新增后端路由后运行 `bun run api:types`（或 `bun run web:typecheck`）刷新类型。

### 数据加载 `@/lib/hooks`
```ts
const res = useResource<T>(key, (signal) => unwrap(eden.api.x.get({ fetch: { signal } })), { pollMs?, enabled? })
// res: { data, error, loading, refreshing, updatedAt, refresh, setData }
```
- **首次加载**用 `loading` 渲染骨架；**刷新**用 `refreshing`，保留旧数据。
- 单个接口失败不要整页崩：`error && !data` 时在对应卡片里渲染 `<ErrorState error onRetry={refresh} />`。
- 轮询只在需要时用（列表 15–30s，详情不用）。

```ts
const { run, pending, error } = useAction(async () => { … })
```
- 所有**点击后发请求**的动作必须用 `useAction` + `LoadingButton`（或按钮内 `Spinner`），保证加载态。
- 长任务（返回 jobId）用 `useJobAction`（`@/lib/use-job`）：
```ts
const job = useJobAction({ label: "同步", start: () => startJob(eden.api.subscriptions["sync-all"].post()), onDone: refresh })
<LoadingButton loading={job.pending} onClick={() => void job.run()}>同步</LoadingButton>
{job.progress ? <JobProgress job={job.progress} onCancel={job.cancel} /> : null}
```
- 其他 hooks：`useNow(ms)`、`useDebounced(value, ms)`、`useCopy()`。

### 实时 / 全局状态 `@/lib/session`、`@/lib/health`、`@/lib/stream`、`@/lib/jobs`
```ts
import { useSession } from "@/lib/session"      // { status, username }
import { useHealth, refreshHealth } from "@/lib/health" // HealthReport | null
import { useStreamState, subscribeStream } from "@/lib/stream" // { connected, lastEventAt }
import { watchJob, cancelJob } from "@/lib/jobs"
const stream = useStreamState()     // 实时通道状态
subscribeStream((msg) => …)         // 实时事件流
watchJob(jobId, { label, onProgress, onDone, onFail }) // 一般用 useJobAction 即可
```

### 格式化 `@/lib/format`
`fmtTime / fmtDate / fmtRelative / fmtMs / fmtDuration / fmtUptime / fmtNumber / fmtPercent / fmtBytes`
`stateMeta(state) -> { label, tone }`；`eventTone(level)`；`toneBgClass / toneTextClass`
- 相对时间用 `<RelativeTime ts={…} />`；绝对时间用 `<TimeText ts={…} />`。
- 状态色只用语义类：`text-success`、`text-warning`、`text-destructive`、`bg-success/10` 等。

### 共享组件 `@/components/common/*`
| 组件 | 用途 |
| --- | --- |
| `PageHeader` | 标题/说明/更新时间/刷新/主操作 |
| `StatCard` | 顶部统计卡（支持 loading / onClick） |
| `StatusBadge` / `Dot` | 状态徽章 / 状态圆点 |
| `EmptyState` | 空态（必须给出下一步动作） |
| `ErrorState` | 错误 + 重试 |
| `LoadingButton` | 任何异步按钮（loading + loadingText） |
| `useConfirm` | 危险操作二次确认（见下） |
| `DataTable` | 通用表格：loading 骨架、空态、排序、行点击 |
| `SectionCard` / `InfoGrid` | 卡片容器 / 键值网格 |
| `CodeBlock` / `CopyButton` | 代码块 / 复制（含已复制态） |
| `RelativeTime` / `TimeText` | 相对/绝对时间 |
| `JobProgress` | 长任务进度条（含取消） |

### 危险操作确认（必须）

```ts
const confirm = useConfirm()
const ok = await confirm({
  title: "删除订阅？",
  description: "删除后该订阅的节点将标记为消失，不会立即删除已有节点。",
  details: <>影响：{item.nodeCount} 个节点 · 下次同步不再包含</>,
  destructive: true,
  confirmText: "删除",
  action: async () => { await unwrap(eden.api.subscriptions({ id: item.id }).delete()) }, // 弹窗内执行并显示加载态
})
```
- 重启数据面必须 `requireText: "RESTART"`，并在 `details` 写明「将断开 N 条连接」。
- 回滚、轮换密码、踢线、吊销 Key 都要确认并展示影响面。

### 交互细则（验收会逐条检查）

1. **每个可点击的异步动作都有加载态**：按钮 `disabled` + 旋转图标 + 文案（如「同步中…」）。不要出现「点了没反应」。
2. 首次进入页面显示骨架屏，不显示空白或只有一行「加载中」。
3. 每个数据区域独立降级：一个接口失败不影响其它卡片。
4. 空态说明「为什么空 + 下一步做什么」，并给按钮。
5. 成功/失败都有 toast（`toast.success` / `toast.error`），错误信息可读。
6. 表格支持搜索/筛选/排序/分页中至少适用的项；移动端可读（次要列 `hidden md:table-cell`）。
7. 不写死颜色值；用语义色 token（`text-success` 等）。
8. 按钮内图标用 `data-icon="inline-start"` / `inline-end"`；等宽高用 `size-*`。
9. 文案中文、术语与 PANEL.md 一致（节点/订阅/发布/对账/退休/隔离）。
10. 响应式：`sm/md/lg` 断点；抽屉用 `Sheet`，确认用 `useConfirm`。

## 4. 后端 API 速查（`apps/server/src/modules/*/index.ts`，全部需要登录 Cookie）

> 调用一律走 Eden：`unwrap(eden.api.<分组>...)`。下表的路径用于对照后端路由，
> 路径参数写成调用形式（`/api/nodes/:id/rotate` → `eden.api.nodes({ id }).rotate.post()`）。

| 页面 | 端点 |
| --- | --- |
| 订阅 | GET/POST `/api/subscriptions`；PATCH/DELETE `/api/subscriptions/:id`；GET `/api/subscriptions/:id/runs`；POST `/api/subscriptions/preview` `{text,formatHint}`；POST `/api/subscriptions/:id/test`；POST `/api/subscriptions/:id/sync`（job）；POST `/api/subscriptions/sync-all`（job） |
| 节点 | GET `/api/nodes?limit&cursor&q&state&protocol&country&enabled&supported&missing&sort`；PATCH `/api/nodes/:id`；POST `/api/nodes/:id/rotate`；POST `/api/nodes/:id/disconnect`；GET `/api/nodes/:id/checks`；GET `/api/nodes/:id/connection`；POST `/api/nodes/:id/check`；POST `/api/nodes/check-batch`（job） |
| 检测 | 同节点 check 接口；策略在 `/api/settings` 的 `detect` 段；GET `/api/jobs?kind=detect`；GET `/api/events` |
| 运行 | GET `/api/runtime/status`；GET `/api/runtime/revisions`；POST `/api/runtime/publish` `{dryRun}`（job）；POST `/api/runtime/rollback` `{revisionId}`（job）；POST `/api/runtime/reconcile` `{dryRun}`（job）；POST `/api/runtime/restart`（job，返回 activeConns）；POST `/api/runtime/node/:id/rebuild`（job） |
| 网关 | GET `/api/gateway/connections` → `{active, byNode, byIp, stats, recent}`；POST `/api/gateway/kick` `{nodeId?,username?,ip?,connId?}` |
| 客户端 | GET `/api/nodes`（取节点）；GET `/api/nodes/:id/connection` → `{http, socks5, curl, docker[], env, clash}`；设置里的 `direct` |
| API Key | GET `/api/keys` → `{items, scopes}`；POST `/api/keys` `{name, scopes[], ipAllowlist?, rateLimit?}`；DELETE `/api/keys/:id` |
| 设置 | GET `/api/settings` → `{settings}`；PATCH `/api/settings`（部分更新）；POST `/api/settings/test` |
| 事件 | GET `/api/events?level&kind&nodeId&limit&cursor`；GET `/api/audit?kind=xray_apply_ops`；GET `/api/apply-ops`；GET `/api/jobs`；GET `/api/jobs/:id`；POST `/api/jobs/:id/cancel` |

响应形状直接由 Eden 从 `apps/server/src/app.ts` 推导（`unwrap` 的返回类型）；如需手写类型，优先用
`ReturnType`/`Awaited` 从客户端推导，而不是重复定义接口。

## 5. 自测

```bash
bun run web:typecheck              # 必须 0 error（会先运行 api:types 生成共享类型）
bun run web:build                  # 或 cd apps/web && bun run build：页面能静态渲染
```

开发服务器：`XCP_API=http://127.0.0.1:8080 bun run web:dev`（默认 `http://localhost:3100`，账号 `admin` / `ADMIN_PASSWORD`）。
浏览器验证脚本在 `/tmp/uitest`（playwright 1.63）：
```ts
import { chromium } from "playwright"
const b = await chromium.launch(); const p = await (await b.newContext()).newPage()
await p.goto("http://localhost:3100/login"); await p.fill("#password", "web-test-123"); await p.click("button[type=submit]")
await p.waitForTimeout(1500); await p.goto("http://localhost:3100/TODO"); await p.screenshot({ path: "shot.png" })
```
`cd /tmp/uitest && bun your-test.ts`。

## 6. 交付标准

- 页面在 1440×900 与 390×844 下都可用。
- 所有按钮/操作均有加载态、错误可读、成功有反馈。
- 不引入新的 npm 依赖（除非 Lead 同意）；不修改后端。
- 完成后给 Lead 发一条消息：路由、已验证的交互、遗留问题。