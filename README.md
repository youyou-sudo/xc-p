# xc-p

Xray-core 节点池管理面板：**订阅 → 检测 → 发布 → 面板 / API** 一体，打包成**单个可执行文件**。

控制面用 Bun + Elysia + SQLite 存期望状态，数据面交给 Xray-core。
单端口网关（HTTP CONNECT / SOCKS5）把「用户名 = 节点 ID」映射到每个节点的环回入站；
节点增删通过 Xray 运行时 API 热生效，**不需要重启、不影响已有连接**。

## 能力

- **订阅**：Xray / sing-box JSON、Clash YAML、base64 或明文链接列表；定时同步，带重试、ETag 与去重。
- **检测**：三阶段判定——网关可达 → 经该节点发请求 → 出口 IP 确认。
- **发布**：期望状态渲染成 Xray 配置 diff，热应用；带快照回滚与漂移对账修复。
- **网关**：单端口同时接受 HTTP 代理与 SOCKS5，首字节分流。
- **面板**：11 个页面（Furin + React 19 + shadcn/ui），构建产物内嵌进二进制。
- **API**：面板 API、服务 API（API Key scope）、SSE 事件流、`/api/health`。

## 快速开始

### Docker（推荐）

```bash
docker build -t xc-p .
docker run -d --name xc-p \
  -p 8080:8080 -p 7890:7890 \
  -v xc-p-data:/data \
  -e ADMIN_PASSWORD='你的口令' \
  xc-p
```

镜像是 distroless + 单文件二进制，以 `nonroot` 运行，Xray 已按目标平台内嵌。
持久化数据（SQLite、证书、解出的 Xray、日志）都在 `/data`；健康检查用二进制自带的
`xc-p healthcheck` 子命令。

### 源码运行

需要 [Bun](https://bun.sh) 和一份 Xray 二进制（放到 `.tools/xray[.exe]`，或设 `XRAY_BINARY`）。

```bash
bun install
DATA_DIR=./data PANEL_PORT=8080 ADMIN_PASSWORD='你的口令' bun run start
```

`bun run start` 会先构建前端并嵌入控制面，再启动；已构建过可用 `bun run start:fast` 跳过重复构建。

| 地址 | 说明 |
| --- | --- |
| <http://127.0.0.1:8080> | 面板（首屏 `/login`） |
| `<节点ID>:<密码>@127.0.0.1:7890` | 单端口网关入口 |

## 登录

- 用户名 `admin`（`ADMIN_USERNAME` 可覆盖）
- 口令 `ADMIN_PASSWORD` 的值；**未设置时为 `change-me-on-first-run`，请务必改掉**

账号只在数据库为空时创建一次，之后只存 argon2id 哈希。忘记口令不必删库：

```bash
bun run admin:password "你的新口令"   # 重置并吊销全部会话
```

## 配置

配置只有两个入口：**引导参数**（环境变量，见 `.env.example`）与**面板「系统设置」**（落库，启动时被引导参数覆盖）。

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `./data` | 持久化目录（SQLite / 证书 / Xray / 日志） |
| `PANEL_HOST` | `localhost` | 面板监听地址；对外访问需 `0.0.0.0`（Docker 镜像已设） |
| `PANEL_PORT` | `8080` | 面板 + REST API 端口 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名（仅首次创建生效） |
| `ADMIN_PASSWORD` | `change-me-on-first-run` | 管理员口令（仅首次创建生效） |
| `XRAY_BINARY` | `xray` | 外部 Xray 路径；打包版默认用内嵌版本 |
| `TZ` | `Asia/Shanghai` | 会话与日志展示时区 |
| `LOG_LEVEL` | `info` | 面板日志级别 |
| `XCP_API` | `http://127.0.0.1:3000` | 仅前端开发：`/api` 反代到的控制面地址 |

其余参数（网关监听、Xray 日志、检测与同步策略等）都在面板「系统设置」里改。

## 构建单文件可执行

```bash
bun run build:exe                             # 当前平台 → dist/xc-p[.exe]
bun run build:exe -- --target=bun-linux-x64   # 交叉编译（也支持 arm64 / darwin / windows）
bun run build:exe -- --xray-version=v26.3.27  # 换 Xray 版本
bun run build:exe -- --fetch-only             # 只下载解出 Xray 到 .cache/xray（CI 预热）
XRAY_DOWNLOAD_MIRROR=https://ghfast.top/ bun run build:exe   # GitHub 拉不动时走镜像
```

流程是：构建前端 → 内嵌 → 按目标平台下载 [Xray-core](https://github.com/XTLS/Xray-core/releases)
发行包并按官方 `.dgst` 校验 SHA2-256 → `bun build --compile` 打成单文件。
运行时把内嵌的 `xray[.exe]` 解出到 `DATA_DIR/bin`（哈希一致则复用），优先级高于 PATH 上的旧版本；
删掉该目录下次启动会自动重建。

## 项目结构

```text
apps/server/     Elysia 控制面 + 数据面引擎（订阅、同步、检测、渲染与热应用、网关）
apps/web/        Furin + React 19 + shadcn/ui 面板
packages/api-client/  前后端共享的 Eden Treaty 客户端与 App 类型
scripts/         构建、验收、排障脚本
```

后端按业务域拆成 `modules/<feature>/`（控制器 + service + TypeBox 模型），全局错误与请求头走
`plugins/`，鉴权用 session macro 声明式保护。前端不手写 `fetch`：`eden.api.nodes.get({ query: { limit: 50 } })`
的路径、参数与响应类型全部由后端导出，共享类型通过 `bun run api:types` 生成。

## 常用命令

```bash
bun run dev            # 构建前端并以 watch 模式启动控制面
bun run web:dev        # 前端 HMR（默认 3100，需先起控制面）
bun run typecheck:all  # 前后端类型检查
bun test               # 单元 / 集成测试
bun run verify:api     # 面板与服务 API 全端点冒烟
bun run verify:all     # 端到端验收（需真实 Xray）
```

CI：push 到 `master` 触发 [release.yml](.github/workflows/release.yml)，先过 `typecheck` + `test` 门禁，
再产出各平台单文件 + `SHA256SUMS.txt` 并发到 GitHub Release；[deploy.yml](.github/workflows/deploy.yml)
推送多架构镜像到 GHCR。

## 排障

**端口被占用（EADDRINUSE）** —— Windows 的 Hyper-V / WSL 会保留一段动态端口
（`netsh int ipv4 show excludedportrange protocol=tcp`）。换一个区间外的端口即可，例如
`PANEL_PORT=8899 DATA_DIR=./data bun run start:fast`；网关端口在「系统设置 → 网关」里改。

**面板打不开 / 提示前端未构建** —— 先跑 `bun run web:build`，确认生成
`apps/server/src/web/assets.generated.ts`，再强制刷新（Ctrl/Cmd + Shift + R）。
前端开发请用 `bun run web:dev`，不要直接改 `apps/web/dist`。

## 许可

Xray-core 为 MPL-2.0，作为独立进程分发。本仓库代码遵循项目自身约定。
