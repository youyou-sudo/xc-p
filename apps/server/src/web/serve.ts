import { extname } from "node:path"
import { ASSET_FILES, PAGE_HTML, SHELL_HTML, WEB_ASSET_COUNT } from "./assets.generated"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

 const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>404 · xc-p</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: "Inter", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif;
    background: #fbfbfd; color: #1c1c22; }
  .card { max-width: 440px; text-align: center; }
  .mark { width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 16px; background: #4f46e5;
    color: #fff; display: grid; place-items: center; font: 700 22px ui-monospace, monospace; }
  .code { font: 500 13px ui-monospace, monospace; color: #6b7280; margin: 0 0 6px; }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { font-size: 14px; line-height: 1.6; color: #52525b; margin: 0 0 24px; }
  .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  a { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 10px;
    font-size: 14px; text-decoration: none; border: 1px solid #e4e4e7; color: inherit; }
  a.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  a:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #111114; color: #f4f4f5; }
    p { color: #a1a1aa; }
    a { border-color: #2e2e35; }
    a.primary { background: #6366f1; border-color: #6366f1; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">s</div>
    <p class="code">404</p>
    <h1>页面不存在</h1>
    <p>这个地址没有对应的面板页面，可能是链接已过期或路由拼写有误。</p>
    <div class="actions">
      <a class="primary" href="/">返回概览</a>
      <a href="/login">去登录</a>
    </div>
  </main>
</body>
</html>`


function htmlResponse(request: Request, html: string, cache = "no-store"): Response {
  const etag = 'W/"' + Bun.hash(html).toString(16) + '"'
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cache } })
  }
  return new Response(html, {
    headers: { "content-type": MIME[".html"]!, "cache-control": cache, etag },
  })
}

function assetResponse(request: Request, path: string, type: string, cache: string): Response {
  const file = Bun.file(path)
  const etag = 'W/"' + file.size.toString(16) + "-" + Math.round(file.lastModified).toString(16) + '"'
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cache } })
  }
  return new Response(file, {
    headers: {
      "content-type": type,
      "cache-control": cache,
      etag,
      "last-modified": new Date(file.lastModified).toUTCString(),
    },
  })
}

function assetCache(path: string): string {
  if (path.startsWith("/_client/")) return "public, max-age=31536000, immutable"
  return "no-cache"
}

function typeOf(path: string): string {
  const ext = extname(path).toLowerCase()
  return MIME[ext] ?? "application/octet-stream"
}

/**
 * 面板静态资源端点（PANEL.md §12.1）：
 * - /            → 构建时渲染的 index.html 端点（内存字符串）
 * - /login 等    → 每个页面各自的 SSG HTML（首帧与 hydration 一致）
 * - /_client/*   → 内容哈希资源，长缓存 immutable
 * - 其余无扩展名路径 → SPA 壳（客户端路由接管，404 由 Furin 边界渲染）
 * - 带扩展名但不存在 → 404，绝不回落 HTML（否则模块加载会拿到 HTML）
 */
export function serveWebAsset(pathname: string, request: Request): Response {
  if (!isWebBuilt()) return buildRequiredResponse()
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return new Response("Bad Request", { status: 400 })
  }
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "")

  const asset = ASSET_FILES[path]
  if (asset) return assetResponse(request, asset, typeOf(path), assetCache(path))

  const page = PAGE_HTML[path]
  if (page) return htmlResponse(request, page)

  if (path === "/index.html") {
    const root = PAGE_HTML["/"]
    if (root) return htmlResponse(request, root)
  }

  if (extname(path)) {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "资源不存在：" + path } }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    })
  }

  // 未知前端路由：返回内置 404 文档（Furin 静态壳在未匹配路由时不会渲染内容）
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { "content-type": MIME[".html"]!, "cache-control": "no-store" },
  })
}

const BUILD_REQUIRED_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>面板尚未构建 · xc-p</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#fbfbfd;color:#1c1c22;
    font-family:"Inter","PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif}
  .card{max-width:560px}
  h1{font-size:22px;margin:0 0 8px}
  p{font-size:14px;line-height:1.7;color:#52525b;margin:0 0 16px}
  pre{background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:12px 14px;font-size:13px;overflow:auto}
  code{font-family:ui-monospace,monospace}
  @media (prefers-color-scheme:dark){body{background:#111114;color:#f4f4f5}p{color:#a1a1aa}pre{background:#1a1a1f;border-color:#2e2e35}}
</style></head>
<body><main class="card">
  <h1>面板前端尚未构建</h1>
  <p>控制面已经启动，但嵌入的前端产物不存在。先构建 Furin 前端，再重启服务即可：</p>
  <pre><code>bun run web:build
bun run start</code></pre>
  <p>开发前端时可以用 <code>bun run web:dev</code>（端口 3100，自动代理 /api 到本服务）。</p>
</main></body></html>`

export function isWebBuilt(): boolean {
  return WEB_ASSET_COUNT > 0 && SHELL_HTML.length > 0 && Object.keys(PAGE_HTML).length > 0
}

export function buildRequiredResponse(): Response {
  return new Response(BUILD_REQUIRED_HTML, {
    status: 503,
    headers: { "content-type": MIME[".html"]!, "cache-control": "no-store" },
  })
}
