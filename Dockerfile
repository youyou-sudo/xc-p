# 不声明 `# syntax=`：本文件只用内置前端就完全支持的指令
# （COPY --from/--chown、HEALTHCHECK、VOLUME、FROM --platform=$BUILDPLATFORM）。
# 声明 syntax 会让每次构建都从 Docker Hub 拉取前端镜像，在受限网络里会直接失败。

# ---------------------------------------------------------------------------
# Build stage.
#
# Bun cross-compiles (`bun build --compile --target=bun-linux-<arch>`), so this
# stage deliberately runs on the *build* platform ($BUILDPLATFORM, normally
# amd64) and emits a foreign-arch binary. Buildx therefore needs no QEMU
# emulation for linux/amd64 + linux/arm64.
#
# One script produces the whole product: scripts/build-exe.ts generates the
# shared API types, builds the Furin frontend and embeds it, downloads the
# matching Xray release (SHA2-256 verified from the .dgst), and compiles
# everything into a single executable. Nothing but that binary is kept.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-slim AS build

# Predefined build arg. BuildKit only exposes TARGETARCH to a stage once it is
# declared here, and build-exe.ts needs it to pick the cross-compile target.
ARG TARGETARCH

# Optional download mirror for the Xray release (e.g. https://ghfast.top/).
# Empty is safe: build-exe.ts treats an empty mirror as "use the GitHub URL".
ARG XRAY_DOWNLOAD_MIRROR

# Playwright is a devDependency for scripts/verify/web-e2e.ts, which never runs
# during an image build. Skipping its browser download saves ~500 MB of CI time.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    XRAY_DOWNLOAD_MIRROR=${XRAY_DOWNLOAD_MIRROR} \
    NODE_ENV=production

WORKDIR /app

# 1) Workspace manifests only, so this layer survives source-only edits.
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/api-client/package.json ./packages/api-client/
RUN bun install --frozen-lockfile

# 2) Source. Note that apps/server/src/web/assets.generated.ts MUST stay in the
#    build context: `bun run api:types` reaches it transitively from app.ts and
#    tsc fails with TS2307 without it. Step 3 regenerates it before compiling.
COPY tsconfig.base.json tsconfig.api-dts.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps

# 3) TARGETARCH (amd64|arm64) is understood directly by parseBuildTarget, which
#    maps it to both the Bun --target flag and the Xray release asset.
RUN bun run scripts/build-exe.ts \
      --target=bun-linux-$TARGETARCH \
      --outfile=out/xc-p

# distroless has no shell or mkdir, so stage the writable data dir here and copy
# it in below with the right ownership.
RUN mkdir -p /staged-data

# ---------------------------------------------------------------------------
# Runtime stage: distroless (no shell, no package manager) + the single binary.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/base-debian12

LABEL org.opencontainers.image.title="xc-p" \
      org.opencontainers.image.description="Xray-core 节点池管理面板"

WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app/out/xc-p /app/xc-p
COPY --from=build --chown=nonroot:nonroot /staged-data /data

# PANEL_HOST defaults to localhost in apps/server/src/config.ts, which would make
# the panel unreachable from outside the container. Override it here.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8080 \
    TZ=Asia/Shanghai

# Every port xc-p binds is well above 1024 (panel 8080, gateway 7890, xray api 8501,
# node inbound pool 24000-28999), so unprivileged execution is safe.
USER nonroot

VOLUME ["/data"]

# 8080 = panel + REST API, 7890 = the single-port gateway clients connect to.
EXPOSE 8080
EXPOSE 7890

# Paired with the `healthcheck` subcommand in apps/server/src/index.ts: the
# distroless base has no curl/wget/shell, so the probe has to ship inside the
# binary. start-period covers the first Xray extraction + data-plane boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/app/xc-p", "healthcheck"]

ENTRYPOINT ["/app/xc-p"]

# I have nothing but my burger and I want nothing more
