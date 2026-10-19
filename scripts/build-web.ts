/**
 * 构建 Furin 前端并以 “embed” 方式嵌入控制面：
 * 1. 在 apps/web 执行 furin build --target static；
 * 2. 读取 apps/web/dist，生成 apps/server/src/web/assets.generated.ts：
 *    - HTML 用 `with { type: "text" }` 内联为字符串（index.html 端点直接返回内存内容）；
 *    - JS/CSS/字体等用 `with { type: "file" }`，bun build --compile 时进入可执行文件。
 */
import { readdir, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const webDir = join(root, "apps", "web")
const distDir = join(webDir, "dist")
const outFile = join(root, "apps", "server", "src", "web", "assets.generated.ts")

const t0 = Date.now()
console.log("[web] furin build --target static …")
const build = Bun.spawn(["bun", "run", "build"], { cwd: webDir, stdout: "inherit", stderr: "inherit" })
const code = await build.exited
if (code !== 0) {
  console.error("[web] furin build 失败，退出码 " + code)
  process.exit(code)
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name
    if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), rel)))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

const files = (await walk(distDir)).sort()
if (!files.includes("index.html")) {
  console.error("[web] dist/index.html 缺失，构建输出不完整")
  process.exit(1)
}

const pages: { route: string; ident: string }[] = []
const assets: { url: string; ident: string }[] = []
const imports: string[] = []
let shellIdent = ""

let seq = 0
const ident = () => "f" + seq++

for (const rel of files) {
  const id = ident()
  const spec = "../../../web/dist/" + rel
  const isHtml = rel.endsWith(".html")
  imports.push(isHtml ? `import ${id} from "${spec}" with { type: "text" }` : `import ${id} from "${spec}" with { type: "file" }`)
  if (rel === "index.html") pages.push({ route: "/", ident: id })
  else if (rel.endsWith("/index.html")) pages.push({ route: "/" + rel.slice(0, -"/index.html".length), ident: id })
  if (rel === "404.html") {
    shellIdent = id
    continue
  }
  if (!isHtml) assets.push({ url: "/" + rel, ident: id })
}

const shell = shellIdent || pages.find((page) => page.route === "/")!.ident

const body = [
  "// 由 scripts/build-web.ts 自动生成，请勿手改。",
  "// HTML 为内联字符串（type text）；其它资源为 file import，bun build --compile 时会被嵌入。",
  ...imports,
  "",
  "export const PAGE_HTML: Record<string, string> = {",
  ...pages.map((page) => `  "${page.route}": ${page.ident} as unknown as string,`),
  "}",
  "",
  "export const SHELL_HTML: string = " + shell + " as unknown as string",
  "",
  "export const ASSET_FILES: Record<string, string> = {",
  ...assets.map((asset) => `  "${asset.url}": ${asset.ident},`),
  "}",
  "",
  "export const WEB_BUILD_AT = " + JSON.stringify(Date.now()),
  "export const WEB_ASSET_COUNT = " + assets.length,
  "",
].join("\n")

await mkdir(join(root, "apps", "server", "src", "web"), { recursive: true })
await writeFile(outFile, body, "utf8")

console.log(
  "[web] 已嵌入 " +
    assets.length +
    " 个资源、" +
    pages.length +
    " 个 HTML 端点 → apps/server/src/web/assets.generated.ts（" +
    ((Date.now() - t0) / 1000).toFixed(1) +
    "s）",
)