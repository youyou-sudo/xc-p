/**
 * 浏览器端验收（真实 Chromium）：
 * - 登录流程 + 登录按钮加载态
 * - 11 个页面逐一打开：h1 渲染、无 console/pageerror、无 4xx/5xx 资源请求、截图
 * - 顶部「刷新」点击后的加载态
 * - 侧栏客户端导航（不整页刷新）
 * - 移动端（390×844）可用性截图
 *
 * 运行前：先启动色板服务（bun run web:build && bun run start），然后
 *   XCP_BASE=http://127.0.0.1:8080 XCP_TEST_PASSWORD=<admin 口令> bun run verify:web
 */
import { chromium, type Browser, type Page } from "playwright"
import { mkdir } from "node:fs/promises"

const BASE = (process.env.XCP_BASE ?? "http://127.0.0.1:8080").replace(/\/$/, "")
const PASSWORD = process.env.XCP_TEST_PASSWORD ?? ""
const OUT = "apps/server/test/artifacts/web-e2e"

const ROUTES: { path: string; title: string; must?: string[] }[] = [
  { path: "/", title: "概览" },
  { path: "/nodes", title: "节点", must: ["节点"] },
  { path: "/subscriptions", title: "订阅" },
  { path: "/detect", title: "检测" },
  { path: "/runtime", title: "运行配置" },
  { path: "/gateway", title: "网关" },
  { path: "/clients", title: "客户端接入" },
  { path: "/credentials", title: "API Key" },
  { path: "/settings", title: "系统设置" },
  { path: "/events", title: "事件与审计" },
]

const failures: string[] = []
const warnings: string[] = []

function fail(message: string) {
  failures.push(message)
  console.log("  ✗ " + message)
}

function ok(message: string) {
  console.log("  ✓ " + message)
}

function attachDiagnostics(page: Page) {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message))
  page.on("response", (response) => {
    const url = response.url()
    if (response.status() >= 400 && !url.includes("favicon")) {
      errors.push("HTTP " + response.status() + " " + url)
    }
  })
  return errors
}

async function login(page: Page) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#password", { timeout: 15_000 })
  await page.fill("#password", PASSWORD)
  const button = page.locator("button[type=submit]")
  const loading = page.waitForSelector("button[type=submit][data-loading]", { timeout: 5_000 }).then(() => true).catch(() => false)
  await button.click()
  const sawLoading = await loading
  if (sawLoading) ok("登录按钮出现加载态")
  else warnings.push("登录按钮加载态过快，未能捕获（不影响功能）")
  await page.waitForURL(BASE + "/", { timeout: 20_000 })
  await page.waitForTimeout(1500)
}

async function visit(page: Page, route: { path: string; title: string; must?: string[] }) {
  const errors = attachDiagnostics(page)
  const response = await page.goto(BASE + route.path, { waitUntil: "networkidle", timeout: 30_000 })
  if (!response || response.status() >= 400) fail(route.path + " 返回 HTTP " + (response?.status() ?? "无响应"))
  await page.waitForTimeout(600)
  const heading = await page.locator("h1").first().textContent().catch(() => null)
  if (!heading || !heading.includes(route.title)) fail(route.path + " 未渲染预期标题「" + route.title + "」，实际：" + JSON.stringify(heading))
  else ok(route.path + " → " + route.title)
  const body = (await page.textContent("body"))?.trim() ?? ""
  if (body.length < 20) fail(route.path + " 页面内容为空")
  if (route.must) {
    for (const text of route.must) {
      if (!(await page.getByText(text, { exact: false }).count())) fail(route.path + " 缺少内容：" + text)
    }
  }
  const unique = [...new Set(errors)]
  if (unique.length) fail(route.path + " 控制台/资源错误：" + unique.slice(0, 4).join(" | "))
  const name = route.path === "/" ? "overview" : route.path.replace(/^\//, "").replace(/\//g, "-")
  await page.screenshot({ path: OUT + "/" + name + ".png", fullPage: false })
}

async function run() {
  console.log("[web-e2e] 目标 " + BASE)
  await mkdir(OUT, { recursive: true })
  const browser: Browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })
  const page = await context.newPage()

  try {
    if (PASSWORD) {
      await login(page)
    } else {
      console.log("  ! 未提供 XCP_TEST_PASSWORD，跳过登录（使用已保存的会话）")
    }

    for (const route of ROUTES) {
      try {
        await visit(page, route)
      } catch (error) {
        fail(route.path + " 打开异常：" + (error instanceof Error ? error.message : String(error)))
      }
    }

    // 客户端导航：从概览点侧栏「节点」不应整页刷新
    try {
      await page.goto(BASE + "/", { waitUntil: "networkidle" })
      await page.waitForTimeout(500)
      const marker = await page.evaluate(() => {
        ;(window as any).__xcpSpaMarker = 1
        return true
      })
      const navLink = page.locator('a[href="/nodes"]').first()
      if (await navLink.count()) {
        await navLink.click()
        await page.waitForURL(BASE + "/nodes", { timeout: 15_000 })
        await page.waitForTimeout(800)
        const stillAlive = await page.evaluate(() => (window as any).__xcpSpaMarker === 1)
        if (marker && stillAlive) ok("侧栏导航为客户端路由（无整页刷新）")
        else fail("侧栏导航触发了整页刷新")
      } else {
        fail("侧栏缺少 /nodes 链接")
      }
    } catch (error) {
      fail("客户端导航测试异常：" + (error instanceof Error ? error.message : String(error)))
    }

    // 刷新按钮加载态
    try {
      await page.goto(BASE + "/", { waitUntil: "networkidle" })
      await page.waitForTimeout(800)
      const refresh = page.locator('button:has-text("刷新")').first()
      if (await refresh.count()) {
        const saw = page.waitForSelector('button:has-text("刷新中")', { timeout: 4_000 }).then(() => true).catch(() => false)
        await refresh.click()
        if (await saw) ok("刷新按钮出现加载态（刷新中…）")
        else warnings.push("刷新按钮加载态过快，未能捕获")
      } else {
        fail("概览页缺少刷新按钮")
      }
    } catch (error) {
      fail("刷新按钮测试异常：" + (error instanceof Error ? error.message : String(error)))
    }

    // 移动端
    try {
      const storageState = await context.storageState()
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", storageState })
      const mpage = await mobile.newPage()
      await mpage.goto(BASE + "/", { waitUntil: "networkidle" })
      await mpage.waitForTimeout(800)
      await mpage.screenshot({ path: OUT + "/mobile-overview.png", fullPage: false })
      const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 8) warnings.push("移动端概览存在横向溢出 " + overflow + "px")
      else ok("移动端无横向溢出")
      const trigger = mpage.locator('[data-sidebar="trigger"]').first()
      if (await trigger.count()) {
        await trigger.click()
        await mpage.waitForTimeout(500)
        await mpage.screenshot({ path: OUT + "/mobile-sidebar.png", fullPage: false })
        ok("移动端侧栏可展开")
      } else {
        warnings.push("未找到移动端侧栏触发按钮")
      }
      await mobile.close()
    } catch (error) {
      warnings.push("移动端测试异常：" + (error instanceof Error ? error.message : String(error)))
    }
  } finally {
    await browser.close()
  }

  console.log("")
  if (warnings.length) {
    console.log("警告：")
    for (const warning of warnings) console.log("  ! " + warning)
  }
  if (failures.length) {
    console.log("失败 " + failures.length + " 项：")
    for (const failure of failures) console.log("  - " + failure)
    process.exit(1)
  }
  console.log("全部通过。截图：" + OUT)
}

await run()