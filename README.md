# xc-p · Xray-core 节点池管理面板

用 **Bun + Elysia** 做控制面、**SQLite** 存期望状态、**Xray-core** 做数据面、
**单端口网关**把「用户名 = 节点 ID」映射到 Xray 的每节点环回入站，
通过 **Xray 运行时 API（HandlerService / RoutingService）热增删 outbound / inbound / 路由规则**
实现「新增节点不影响已有连接」——不需要多进程分片、蓝绿部署与端口切换。

设计文档：[`PANEL.md`](./PANEL.md)（权威）。
实现合规扫描（逐条对照 + 偏差 + 实测证据）：[`docs/PANEL-COMPLIANCE.md`](./docs/PANEL-COMPLIANCE.md)。

## Monorepo 结构

仓库是 **Bun workspaces monorepo**，按「应用 / 共享包」分层：

```text
xc-p/                       # 工作区根：只放工作区配置、共享脚本与文档
  apps/
    server/                 # @xc-p/server：Elysia 控制面 + 数据面引擎
      src/
        index.ts            # 启动入口（bootstrap）
        app.ts              # 组合根：plugins + modules → App 类型
        plugins/            # 全局生命周期插件（errors / request-id / session）
        modules/            # 业务模块：controller(index) + service + model
          auth/ subscriptions/ nodes/ settings/ runtime/ keys/
          jobs/ events/ gateway/ metrics/ health/ v1/ web/
        core/ sub/ sync/ detect/ xray/ publish/ gateway/ jobs/   # 领域引擎
        web/                # Furin embed 产物的 Elysia 端点
      test/                 # 单元/集成测试
    web/                    # @xc-p/web：Furin + React 19 + shadcn/ui 面板
  packages/
    api-client/             # @xc-p/api-client：前后端共享的 Eden Treaty 客户端
  scripts/                  # 构建、验收、运维脚本
  docs/                     # 实现/验收/前端/后端说明
  data/                     # 运行时数据（gitignore）
```

后端结构遵循 [Elysia 最佳实践](https://elysiajs.com/essential/best-practice)：
**每个业务域一个 `modules/<feature>/`**，包含控制器（`index.ts`）、服务（`service.ts`）
与 TypeBox 模型（`model.ts`）；全局错误/请求头通过 `plugins/` 以 `as: 'global'` 注册；
鉴权使用 session macro（`{ requireSession: true }`）声明式保护路由。详见
[`docs/BACKEND.md`](./docs/BACKEND.md)。

## 端到端类型（Eden Treaty）

- 后端 [`apps/server/src/app.ts`](./apps/server/src/app.ts) 组合出 Elysia 应用并导出
  `export type App = ReturnType<typeof buildApp>`。
- 前端不再手写 `fetch('/api/...')`：通过 [Eden Treaty](https://elysiajs.com/eden/overview)
  调用 `eden.api.nodes.get({ query: { limit: 50 } })`，路径、参数与响应类型全部来自后端定义。
- 共享包从**生成的后端声明文件**读取 `App` 类型（前端 tsc 不会误检查后端源码）：

```bash
bun run api:types   # 生成 packages/api-client/types/**（web:typecheck / web:build 会自动执行）
```

## 首次登录

- **用户名**：`admin`（可用启动环境变量 `ADMIN_USERNAME` 覆盖）
- **口令**：由首次启动时的 `ADMIN_PASSWORD` 初始化；**未设置时使用默认口令 `change-me-on-first-run`**

> 管理员账号只在数据库为空时创建一次。之后改 `ADMIN_PASSWORD` 不会生效（口令只存 argon2id 哈希）。
> 忘记口令时不需要删库：

```bash
bun run admin:password "你的新口令"        # 重置，并吊销全部现有会话
```

也可以在登录后于「系统设置 → 管理员口令」里修改（会校验旧口令，并吊销其它会话）。

## 快速开始

前端是 **Furin + React 19 + shadcn/ui**，构建产物以 **embed** 方式嵌入控制面
（`bun run web:build` → `apps/server/src/web/assets.generated.ts`），由控制面 Elysia 以
`index.html` 端点提供；不再依赖 `public/` 静态目录。

打包版还会在构建时**按目标平台内嵌 Xray 二进制**，运行时解出到 `DATA_DIR/bin` 并校验 SHA256
（见下一节）；源码运行（未打包）则回退到外部 Xray。

```bash
bun install              # 工作区根安装（apps/* + packages/*）
bun run start            # 先构建 Furin 前端并嵌入控制面，再启动控制面

# 源码运行需要外部 Xray：放到 ./.tools/xray[.exe]，或显式指定 XRAY_BINARY
DATA_DIR=./data PANEL_PORT=8080 ADMIN_PASSWORD=change-me \
  XRAY_BINARY=/path/to/xray bun run start
# 面板：http://127.0.0.1:8080  （首屏 /login）
# 单端口入口：http://<节点ID>:<密码>@127.0.0.1:7890

# 前端热更新开发（Furin dev server，自动代理 /api 到控制面）
XCP_API=http://127.0.0.1:8080 bun run web:dev

# 已构建过前端时可跳过重复构建（生产/容器二次启动）
bun run start:fast
```

> 根脚本都以仓库根为工作目录运行（`DATA_DIR` 默认 `./data`）。直接在
> `apps/server` 下运行 `bun run start` 时，数据目录会是 `apps/server/data`，请显式传
> `DATA_DIR`。

## 打包单文件可执行（内嵌 Xray）

`bun run build:exe` 会：

1. 读取 `--target`（省略 = 当前构建机）确定要打包的平台：`bun-windows-x64`、`bun-linux-x64`、
   `bun-linux-arm64`、`bun-darwin-x64`、`bun-darwin-arm64` 等；
2. 构建 Furin 前端并嵌入控制面；
3. 从 [XTLS/Xray-core](https://github.com/XTLS/Xray-core/releases) 下载该平台发行包
   （默认 `v26.3.27`，`--xray-version` 可换），用 `.dgst` 的 SHA2-256 校验 zip，再取出 `xray[.exe]`；
4. 用 `bun build --compile` 把控制面与 Xray 打进**一个可执行文件**。

```bash
bun run build:exe                             # 当前平台 → dist/xc-p[.exe]
bun run build:exe -- --target=bun-linux-x64   # 交叉编译 → dist/xc-p-linux-x64
bun run build:exe -- --target=bun-linux-arm64 --xray-version=v26.3.27
bun run build:exe -- --fetch-only             # 只下载并解出 Xray 到 .cache/xray（CI 预热；等价 bun run xray:fetch）
XRAY_DOWNLOAD_MIRROR=https://ghfast.top/ bun run build:exe   # GitHub 慢时用镜像（也支持 {url} 模板）
```

- 运行时把内嵌的 `xray[.exe]` 解出到 `DATA_DIR/bin/`（SHA256 一致则复用），**内嵌版本优先于 PATH 上的旧 xray**；
- 删除 `DATA_DIR/bin` 后下次启动会自动重建；`settings.xray.binary` / `XRAY_BINARY` 仍可显式覆盖（本地开发或 external 模式）；
- 版本升级 = 改 `--xray-version` 重新打包；面板不再提供「版本固定」设置。

## Docker

镜像是 distroless + 单文件：前端与对应平台的 Xray 都已内嵌，以 `nonroot` 运行。

```bash
docker build -t xc-p .
docker run -d --name xc-p \
  -p 8080:8080 -p 7890:7890 \
  -v xc-p-data:/data \
  -e ADMIN_PASSWORD='你的口令' \
  xc-p
```

- 面板在 `8080`，网关在 `7890`；持久化数据（SQLite、证书、解出的 Xray）都在 `/data` 卷里。
- 镜像自带 `HEALTHCHECK`，执行 `xc-p healthcheck`。distroless 没有 curl/wget/shell，
  所以探针是二进制自带的子命令；直接跑二进制也可以用它做存活探测。
- 镜像里设了 `PANEL_HOST=0.0.0.0`；直接跑二进制时该变量缺省 `localhost`（只监听本机）。
- 多架构：`linux/amd64` 与 `linux/arm64` 由同一台 amd64 构建机交叉编译
  （Dockerfile 把构建阶段固定在 `$BUILDPLATFORM`），所以 buildx 不需要 QEMU。

## CI（GitHub Actions）

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| [`.github/workflows/release.yml`](./.github/workflows/release.yml) | push 到 `master`（忽略 `*.md`、`docs/**`、`.agents/**`）或手动 | 6 个平台单文件 + `SHA256SUMS.txt` → GitHub Release |
| [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) | push 到 `master` 或手动 | 多架构镜像 → GHCR（`latest` 与 `sha-<短哈希>`），可选触发部署 webhook |

- **版本号**：默认每次 push 自增 patch（基于最近的 `v*.*.*` tag）；手动触发可选
  `patch` / `minor` / `major` / `custom`。对已有 tag 重跑只覆盖同名资产，不会产生重复 Release。
- **发布前门禁**：`bun run typecheck` + `bun run test`。注意「Xray 渲染门禁」在找不到二进制时
  会静默跳过，所以 CI 先用 `bun run scripts/build-exe.ts --target=bun-linux-x64 --fetch-only`
  拉一份并经 `XRAY_BIN` 指过去，让它真的跑起来。
- **冒烟测试**：只有 linux-x64，在**空目录、不带任何环境变量**下启动，轮询内置默认端口，
  断言 `/api/health` 返回真实报告（`panel=ok`），再跑一次 `xc-p healthcheck`。
- **可选配置**：仓库变量 `XRAY_DOWNLOAD_MIRROR`（如 `https://ghfast.top/`）用于 GitHub 拉不动
  Xray 发行包时走镜像；仓库密钥 `DEPLOY_WEBHOOK_URL` 未设置时 deploy 步骤只告警跳过，镜像照常推送。

## 验证

```bash
bun test                                  # 订阅解析 + Xray 渲染门禁 + 网关 + 打包目标映射（依赖本机 Xray/openssl）
bun run scripts/p0-hot-apply-check.ts     # P0 可行性 V1~V6 + 1000 次 ado/rmo 长稳
bun run scripts/verify/smoke-api.ts       # 面板 / 服务 API 全端点冒烟
bun run scripts/verify/run-all.ts         # 验收 AC-1~AC-18（真 Xray，离线可复现）
bun run typecheck:all                     # 后端 + 前端类型检查（含生成 API 类型）
bun run web:typecheck                     # 只检查前端（会先 api:types）
bun run web:build                         # Furin 静态构建 + embed（会先 api:types）
XCP_BASE=http://127.0.0.1:8080 XCP_TEST_PASSWORD=<口令> bun run verify:web  # 真浏览器验收
```

报告产物：[`docs/P0-REPORT.md`](./docs/P0-REPORT.md)、[`docs/VERIFY-REPORT.md`](./docs/VERIFY-REPORT.md)。

## 目录

```text
apps/server/src/core/     DB / 迁移 / settings / crypto / 事件 / 路由表 / 连接表
apps/server/src/sub/      订阅解析（6 种格式 + 13 fixture）
apps/server/src/sync/     SyncJob（取回/重试/ETag/去重/消失恢复）
apps/server/src/detect/   三阶段检测（网关可达 → 经节点请求 → 出口确认）
apps/server/src/xray/     cli 通道 / 渲染 / 端口池 / ApplyPlan / apply engine / 对账 / 进程托管
apps/server/src/publish/  快照与安全阀、PublishJob、回滚
apps/server/src/gateway/  L4 网关（HTTP CONNECT + SOCKS5，同端口首字节分流）
apps/server/src/modules/  面板 API + 服务 API（API Key scope）+ SSE（按业务域拆分）
apps/server/src/web/      Furin embed 产物的 Elysia 端点（index.html / 页面 HTML / 内容哈希资源）
apps/web/                 @xc-p/web：Furin + React 19 + shadcn/ui 面板（11 个页面）
packages/api-client/      前后端共享的 Eden Treaty 客户端与 App 类型
scripts/                  构建、P0 与验收脚本（见 docs/IMPL-CONTRACTS.md）
```

## 节点删除、漂移与延迟退休

- 「已消失」节点不会自动从数据库删除：同步只标记 `missing_since`，到期后 `enabled=0`，
  旧 tag 还要等延迟退休窗口结束才 `rmo`。
- 面板现在支持：节点抽屉「删除节点」（需输入节点 ID）、节点页「清理已消失 (N)」批量清理；
  删除会自动提交一次对账，清理数据面残留 tag。
- 漂移（drift）= 数据面里既不在期望状态、也不在 applied_nodes 里的 tag；
  `pending_retire` 中的 tag 属于正常过渡态，不再显示为漂移；
  「对账并修复」会清理真正的孤儿 tag，退休失败会 60 秒后重试，启动时也会补跑。
- 机制、表结构与排查 SQL 见 [`docs/NODE-LIFECYCLE.md`](./docs/NODE-LIFECYCLE.md)。

## 排障：端口被占用 / EADDRINUSE

Windows 上 Hyper-V / WSL 会保留一段动态端口（`netsh int ipv4 show excludedportrange protocol=tcp`）。
如果默认 `8080` 落在保留区间，换一个区间外的端口即可，例如：

```bash
PANEL_PORT=8899 DATA_DIR=./data bun run start:fast
```

网关 `gateway.listen`（默认 `0.0.0.0:7890`）同理，可在「系统设置 → 网关」里修改并保存（会自动重建 listener）。

## 排障：面板打不开 / 显示「面板前端尚未构建」

1. 先执行 `bun run web:build`，确认生成 `apps/server/src/web/assets.generated.ts`；未构建时 Elysia 返回 503 并给出命令。
2. 强制刷新：Windows Ctrl + Shift + R，macOS Cmd + Shift + R。HTML 为 `no-store`，
   `/_client/*` 为内容哈希的 `immutable`，正常情况下不会缓存旧脚本。
3. 前端开发请用 `bun run web:dev`（Furin HMR，3100），不要直接改 `apps/web/dist`。
4. 打开浏览器控制台（F12）；前端实现、构建与验证细节见 [`docs/FRONTEND.md`](./docs/FRONTEND.md)。

## 许可

Xray-core 为 MPL-2.0，作为独立进程分发。本仓库代码遵循项目自身约定。
