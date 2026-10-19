import { Elysia } from "elysia"
import { furin } from "@teyik0/furin"

/**
 * 开发用 Furin 服务器：页面走 Furin 的 HMR，/api 与 /v1 反向代理到 xc-p 控制面，
 * 这样浏览器始终同源，Cookie 会话与 SSE 都能原样工作。
 */
const API_TARGET = (process.env.XCP_API ?? "http://127.0.0.1:3000").replace(/\/$/, "")
const port = Number(process.env.PORT ?? 3100)

const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "host",
  "content-length",
  "content-encoding",
])

async function proxy(request: Request, pathname: string, body: unknown): Promise<Response> {
  const url = new URL(request.url)
  const target = API_TARGET + pathname + url.search
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!DROP_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  })
  headers.set("host", new URL(API_TARGET).host)
  const method = request.method.toUpperCase()
  const init: RequestInit = { method, headers, redirect: "manual" }
  if (method !== "GET" && method !== "HEAD") {
    if (body === undefined || body === null) init.body = ""
    else if (typeof body === "string") init.body = body
    else if (body instanceof Blob) init.body = body
    else init.body = JSON.stringify(body)
  }
  try {
    const upstream = await fetch(target, init)
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      if (!DROP_HEADERS.has(key.toLowerCase())) responseHeaders.append(key, value)
    })
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (error) {
    console.error("[proxy]", method, pathname, error)
    return Response.json({ error: { code: "proxy_error", message: String(error) } }, { status: 502 })
  }
}

const app = new Elysia()
  .use(await furin({ pagesDir: "./src/pages" }))
  .all("/api/*", ({ request, body }: { request: Request; body: unknown }) => proxy(request, new URL(request.url).pathname, body))
  .all("/v1/*", ({ request, body }: { request: Request; body: unknown }) => proxy(request, new URL(request.url).pathname, body))
  .listen(port)

console.log("Furin dev server → http://localhost:" + app.server?.port + "（API 代理 → " + API_TARGET + "）")
