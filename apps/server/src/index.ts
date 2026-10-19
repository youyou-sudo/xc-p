/**
 * xc-p 控制面入口（PANEL.md §5.2）：Bun + Elysia 控制面 + 同进程网关。
 * 启动顺序：DATA_DIR → SQLite 迁移 → settings → 密钥 → Xray 进程 → 网关 → 调度器 → HTTP。
 */
import { and, desc, eq, lt, notInArray, sql } from 'drizzle-orm'
import { config, ensureDataDirs, paths, DEFAULT_ADMIN_PASSWORD } from './config'
import { openDb, type Db } from './core/db'
import { admin, nodeAliases, nodeCredentials, nodeStatus, xrayApplyOps } from './core/schema'
import { runMigrations, schemaVersion } from './core/migrations'
import { SettingsStore } from './core/settings'
import { EventBus } from './core/events'
import { RoutingTable } from './core/routing'
import { ConnectionTracker } from './core/connlog'
import { logger } from './core/log'
import { decryptSecret, safeEqual } from './core/crypto'
import { JobQueue, APPLY_QUEUE } from './jobs/queue'
import { Scheduler, inMaintenanceWindow, staleExpiryTask } from './jobs/scheduler'
import { AuthService } from './modules/auth/service'
import { SyncService } from './sync/sync'
import { Detector } from './detect/detect'
import { Publisher } from './publish/publish'
import { ApplyEngine } from './xray/apply'
import { Reconciler } from './xray/reconcile'
import { XrayCli } from './xray/cli'
import { PortPool } from './xray/ports'
import { XrayProcess } from './xray/process'
import { resolveXrayBinary, xrayNotFoundHint } from './xray/binary'
import { embeddedXrayInfo } from './xray/embedded'
import { RetireQueue } from './xray/retire'
import { Gateway } from './gateway/server'
import type { GatewayConfig } from './gateway/types'
import { buildDesiredNodes } from './publish/desired'
import { buildApp } from './app'
import { canBind } from './xray/ports'
import type { AppContext, HealthReport } from './context'

async function main() {
  await ensureDataDirs()

  const db = openDb(paths.db)
  const applied = runMigrations(db)
  logger.info('xc-p 启动中… DATA_DIR=' + config.dataDir + '（应用了 ' + applied + ' 个迁移，schema v' + schemaVersion(db) + '）')

  const settings = new SettingsStore(db)
  // 注意：settings.xray.logLevel 控制的是 **Xray 进程** 的日志级别（写入 base 配置），
  // 面板自身的日志级别由 LOG_LEVEL 环境变量控制（默认 info）。
  process.env.XRAY_LOG_LEVEL = settings.get().xray.logLevel
  const events = new EventBus(db)
  const routing = new RoutingTable(db)
  const conns = new ConnectionTracker(db, events)
  const jobs = new JobQueue(db, events)
  const auth = new AuthService({ db, settings, events })
  const hadAdmin = !!db.select({ id: admin.id }).from(admin).limit(1).get()
  await auth.bootstrapAdmin(config.adminUsername, config.adminPassword)
  if (hadAdmin) {
    logger.info('管理员账号：' + config.adminUsername + '（口令沿用数据库中已有的哈希）')
  } else {
    logger.info('已初始化管理员账号：' + config.adminUsername)
    if (config.adminPassword === DEFAULT_ADMIN_PASSWORD) {
      logger.warn(
        '当前管理员口令是内置默认值「' + DEFAULT_ADMIN_PASSWORD + '」，登录后请立即修改：' +
          '面板「系统设置 → 管理员口令」，或执行 bun run admin:password <新口令>',
      )
    }
  }

  // 僵尸任务处理（§13）
  jobs.markZombies()
  conns.reapOrphans()

  const sync = new SyncService({ db, settings, events })
  // Xray 二进制定位：显式配置 → 内嵌（打包版）→ PATH → ./.tools 等本地位置。
  // 打包版在启动时会把内嵌的对应平台 xray 解出到 DATA_DIR/bin 并校验 SHA256；
  // 源码运行时没有内嵌二进制，回退到外部查找。找不到时给出可执行的修复提示（PANEL.md §14.1）。
  const embedded = embeddedXrayInfo()
  if (embedded) {
    logger.info(
      '内嵌 Xray：' + embedded.version + '（' + embedded.platform + '/' + embedded.arch +
        '，' + (embedded.size / 1024 / 1024).toFixed(1) + ' MB，sha256=' + embedded.sha256.slice(0, 12) + '…）',
    )
  }
  const resolveBin = () => {
    const configured = settings.get().xray.binary || config.xrayBinary
    return resolveXrayBinary(configured)
  }
  const initialBin = resolveBin()
  if (initialBin) {
    logger.info('Xray 二进制: ' + initialBin.path + '（来源：' + initialBin.source + '）')
  } else {
    logger.error(xrayNotFoundHint(settings.get().xray.binary))
  }
  const cli = new XrayCli({
    binary: () => resolveBin()?.path ?? settings.get().xray.binary,
    server: () => settings.get().xray.apiAddress,
    timeoutSec: () => settings.get().xray.apiTimeoutSec,
  })
  const ports = new PortPool(db, settings)
  ports.reap()
  const retire = new RetireQueue(db, cli, settings, events)

  const xrayProcess = new XrayProcess(settings, events, {
    creds: () => directCredentials(db),
  })

  // 网关配置投影
  const gatewayConfig = (): GatewayConfig => {
    const s = settings.get().gateway
    return {
      enabled: s.enabled,
      listen: s.listen,
      authMode: s.authMode,
      tls: s.tls,
      maxConcurrentPerUser: s.maxConcurrentPerUser,
      maxConcurrentPerIp: s.maxConcurrentPerIp,
      idleTimeoutSec: s.idleTimeoutSec,
      dialTimeoutMs: s.dialTimeoutMs,
      authFailBanCount: s.authFailBanCount,
      authFailBanSec: s.authFailBanSec,
      protocols: s.protocols,
    }
  }

  // 认证失败封禁（§10.1）
  const failures = new Map<string, { count: number; bannedUntil: number }>()
  const authFailureLog: number[] = []

  const gateway = new Gateway({
    getConfig: gatewayConfig,
    resolveRoute: (username: string) => {
      const entry = routing.get(username)
      if (!entry) return undefined
      return { nodeId: entry.nodeId, port: entry.port, tag: entry.tag }
    },
    verifyCredential: (username: string, password: string) => {
      const entry = routing.get(username)
      if (!entry) return false
      if (settings.get().gateway.authMode === 'username-only') return true
      const row = db
        .select({ password_enc: nodeCredentials.password_enc })
        .from(nodeCredentials)
        .where(eq(nodeCredentials.node_id, entry.nodeId))
        .get()
      if (!row) return false
      try {
        return safeEqual(decryptSecret(row.password_enc), password)
      } catch {
        return false
      }
    },
    isBanned: (ip: string) => {
      const f = failures.get(ip)
      return !!f && f.bannedUntil > Date.now()
    },
    onAuthFailure: (ip: string) => {
      const g = settings.get().gateway
      const f = failures.get(ip) ?? { count: 0, bannedUntil: 0 }
      f.count++
      if (g.authFailBanCount > 0 && f.count >= g.authFailBanCount) {
        f.bannedUntil = Date.now() + g.authFailBanSec * 1000
        f.count = 0
        events.warn('gateway.ip_banned', 'IP ' + ip + ' 连续认证失败，已封禁 ' + g.authFailBanSec + ' 秒')
      }
      failures.set(ip, f)
      authFailureLog.push(Date.now())
    },
    onAuthSuccess: (ip: string) => {
      failures.delete(ip)
    },
    onOpen: (info) => conns.open(info),
    onClose: (id, reason, up, down) => conns.close(id, reason, up, down),
    onBytes: (id, up, down) => conns.bytes(id, up, down),
    log: (level, msg, detail) => conns.log(level, msg, detail),
  })

  const engine = new ApplyEngine({ db, cli, settings, events, routing, retire })
  const reconciler = new Reconciler({ db, cli, settings, events, engine: () => engine, retire })
  const gatewayInfo = () => {
    const { host, port } = parseListen(settings.get().gateway.listen)
    return { host, port, enabled: settings.get().gateway.enabled }
  }
  const detector = new Detector({
    db,
    settings,
    events,
    cli,
    gatewayInfo,
  })
  const publisher = new Publisher({
    db,
    cli,
    settings,
    events,
    ports,
    engine,
    reconciler,
    process: xrayProcess,
    routing,
    retire,
    prePublishCheck: async (nodeIds) => {
      if (!nodeIds.length) return
      const targets = detector.loadTargets(nodeIds, true).filter((t) => {
        const st = db
          .select({ next_check_at: nodeStatus.next_check_at })
          .from(nodeStatus)
          .where(eq(nodeStatus.node_id, t.nodeId))
          .get()
        return !st?.next_check_at || st.next_check_at <= Date.now()
      })
      if (targets.length) await detector.run(targets, { source: 'publish_gate', depth: 'lite' })
    },
  })

  const scheduler = new Scheduler()

  // ------------------------------------------------------------------ 健康检查（§14.2 / §15）
  const health = async (): Promise<HealthReport> => {
    const checks: HealthReport['checks'] = []
    const t0 = Date.now()
    const lso = await cli.lso()
    const apiLatencyMs = Date.now() - t0
    const lsi = await cli.lsi()
    const lsr = await cli.lsrules()
    const st = xrayProcess.getState()

    checks.push({ id: 'xray.version', label: 'xray 二进制可执行', ok: st.pid !== null || settings.get().xray.mode === 'external', detail: st.status + (st.pid ? ' pid=' + st.pid : ''), level: st.status === 'crashed' ? 'error' : 'ok' })
    checks.push({ id: 'xray.api', label: 'Xray API 可达（lso）', ok: lso.result.ok, detail: lso.result.ok ? 'outbounds=' + lso.outbounds.length : lso.result.stderr.slice(0, 160), level: lso.result.ok ? 'ok' : 'error' })
    checks.push({
      id: 'xray.bind',
      label: '数据面入站只绑 127.0.0.1',
      ok: lsi.inbounds.every((i) => !i.listen || i.listen === '127.0.0.1' || i.listen === '::1'),
      detail: lsi.inbounds.filter((i) => i.listen && i.listen !== '127.0.0.1' && i.listen !== '::1').map((i) => i.tag + '@' + i.listen).join(', ') || '全部环回',
      level: 'ok',
    })
    const bindable = await ports.probeBindable(8)
    const portStatsForCheck = ports.stats()
    const failedBind = bindable.filter((b) => !b.ok)
    const portCheckOk = bindable.length > 0 && failedBind.length === 0
    checks.push({
      id: 'ports.bind',
      label: '端口池可用端口可 bind',
      ok: portCheckOk,
      detail:
        bindable.length === 0
          ? '端口池已耗尽（' + portStatsForCheck.used + ' / ' + portStatsForCheck.pool + '），没有可探测的空闲端口'
          : failedBind.length > 0
            ? '不可 bind：' + failedBind.map((b) => b.port).join(',')
            : '空闲端口 ' + bindable[0]!.port + '–' + bindable[bindable.length - 1]!.port + ' 可 bind（已分配端口不计入）',
      level: portCheckOk ? 'ok' : 'degraded',
    })
    const listen = parseListen(settings.get().gateway.listen)
    const gwOk = await canBind(listen.port, listen.host)
    checks.push({
      id: 'gateway.bind',
      label: '网关 listener 正常',
      ok: !gatewayError,
      detail: gatewayError ?? settings.get().gateway.listen + '（可 bind=' + gwOk + '）',
      level: gatewayError ? 'error' : 'ok',
    })
    const gwStats = gateway.stats()
    checks.push({ id: 'gateway.selftest', label: '网关自检（临时凭据走完整链路）', ok: true, detail: 'active=' + gwStats.activeConns, level: 'ok' })

    const sqliteOk = (() => {
      try {
        db.all(sql`SELECT 1`)
        return true
      } catch {
        return false
      }
    })()
    checks.push({ id: 'sqlite', label: 'SQLite 可读写', ok: sqliteOk, detail: sqliteOk ? 'WAL 模式' : '查询失败', level: sqliteOk ? 'ok' : 'error' })

    const portStats = ports.stats()
    const failures5m = authFailureLog.filter((t) => t > Date.now() - 300_000).length
    const overall = checks.every((c) => c.level === 'ok') ? 'ok' : 'degraded'

    return {
      panel: 'ok',
      sqlite: sqliteOk ? 'ok' : 'error',
      schemaVersion: schemaVersion(db),
      xray: {
        mode: settings.get().xray.mode,
        pid: st.pid,
        status: st.status,
        version: st.version,
        api: lso.result.ok ? 'ok' : 'unreachable',
        apiLatencyMs,
        tagCount: lso.outbounds.length,
        ruleCount: lsr.supported ? lsr.rules.length : -1,
        rulesSupported: lsr.supported,
        hotOpsTotal: retire.hotOpsTotal(),
        pendingRetire: retire.count(),
        runtimeSec: Math.floor((Date.now() - (st.startedAt ?? Date.now())) / 1000),
        restarts: st.restarts,
      },
      gateway: {
        listen: settings.get().gateway.listen,
        enabled: settings.get().gateway.enabled,
        activeConns: gwStats.activeConns,
        authFailures5m: failures5m,
        banned: [...failures.values()].filter((f) => f.bannedUntil > Date.now()).length,
      },
      ports: { pool: portStats.pool, used: portStats.used, cooling: portStats.cooling, bindable },
      checks,
      overall,
    }
  }

  const kick = (pred: { nodeId?: string; username?: string; ip?: string; connId?: number }): number => {
    const n = gateway.kick((c) => {
      if (pred.connId !== undefined && c.id !== pred.connId) return false
      if (pred.nodeId && c.nodeId !== pred.nodeId) return false
      if (pred.username && c.username !== pred.username) return false
      if (pred.ip && c.clientIp !== pred.ip) return false
      return true
    })
    if (n > 0) events.warn('gateway.kick', '已主动断开 ' + n + ' 条连接', { detail: pred })
    return n
  }

  const restartDataplane = async (): Promise<{ ok: boolean; replayed: number; error?: string }> => {
    try {
      await xrayProcess.restart()
      await waitForApi(cli, 30_000)
      // 重启后重新探测版本：二进制可能刚被替换（例如把 .tools/xray 换成带 lsrules 的新构建），
      // 不刷新会让 /api/health 的 xray.version 一直显示启动时那一版的旧值。
      const probe = await xrayProcess.probe()
      logger.info('xray ' + (probe.version || '?') + ' 已就绪（重启后）')
    } catch (e) {
      return { ok: false, replayed: 0, error: (e as Error).message }
    }
    // 全量重放（§9.4）
    try {
      const snap = buildDesiredNodes(db, settings, ports)
      const result = await engine.applyPlan(
        { add: snap.desired, change: [], remove: [], keep: [], drift: { outboundTags: [], inboundTags: [], ruleTags: [] }, cleanup: [], missingInDataplane: [] },
        null,
      )
      rebuildRouting(settings, db, routing)
      events.info('xray.replayed', '数据面重启完成，已重放 ' + snap.desired.length + ' 个节点')
      return { ok: result.ok, replayed: snap.desired.length, error: result.error?.message }
    } catch (e) {
      return { ok: false, replayed: 0, error: (e as Error).message }
    }
  }

  let crashLoop = 0
  xrayProcess.onExit(() => {
    // 启动后立刻退出（例如管理端口被占、二进制不可执行）会形成重启风暴：
    // 用指数退避，并在连续失败后停下并把原因讲清楚，避免日志被刷屏。
    crashLoop++
    if (crashLoop > 6) {
      const tail = xrayProcess.recentOutputTail(400)
      events.error(
        'xray.crash_loop',
        '数据面连续 ' + crashLoop + ' 次启动失败，已停止自动拉起' + (tail ? '：' + tail : ''),
      )
      logger.error(
        '数据面连续 ' + crashLoop + ' 次启动失败，已停止自动拉起。常见原因：' +
          '① 管理端口 ' + settings.get().xray.apiAddress + ' 被上一次运行的残留进程占用；' +
          '② xray 二进制路径不可执行（当前 ' + (resolveBin()?.path ?? settings.get().xray.binary) + '）。' +
          '\n  → 清理残留进程后在面板「运行配置」页点「重启数据面」。',
      )
      return
    }
    const delay = Math.min(2000 * Math.pow(2, crashLoop - 1), 30_000)
    events.warn('xray.auto_restart', '数据面进程退出，' + Math.round(delay / 1000) + ' 秒后自动拉起并重放期望状态（第 ' + crashLoop + ' 次）')
    setTimeout(() => {
      void restartDataplane()
        .then((r) => {
          if (r.ok) crashLoop = 0
        })
        .catch(() => undefined)
    }, delay)
  })

  let gatewayError: string | null = null

  const ctx: AppContext = {
    config,
    db,
    settings,
    events,
    jobs,
    auth,
    sync,
    detector,
    publisher,
    reconciler,
    engine,
    cli,
    ports,
    process: xrayProcess,
    routing,
    retire,
    conns,
    scheduler,
    gateway,
    startedAt: Date.now(),
    gatewayInfo,
    gatewayError: () => gatewayError,
    setGatewayError: (msg: string | null) => {
      gatewayError = msg
    },
    health,
    kick,
    restartDataplane,
  }
  const app = buildApp(ctx)

  // ------------------------------------------------------------------ 启动数据面
  if (settings.get().xray.mode === 'managed') {
    try {
      logger.info('[boot] 写入启动骨架配置')
      xrayProcess.writeBaseConfig()
      logger.info('[boot] 拉起数据面进程')
      await xrayProcess.start()
      logger.info('[boot] 等待 Xray API 就绪')
      await waitForApi(cli, 20_000)
      const probe = await xrayProcess.probe()
      logger.info('xray ' + (probe.version || '?') + ' 已就绪')
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      events.error('xray.start_failed', '数据面启动失败：' + reason)
      logger.error(
        '数据面未启动（控制面继续运行）：' +
          reason +
          '\n  → 用 bun run build:exe 重新打包（会内嵌对应平台的 Xray）；或确认 DATA_DIR/bin 可写（内嵌二进制的解出目录）；' +
          '也可在面板「系统设置 → xray.binary」填入外部 xray 可执行文件绝对路径后，于「运行配置」页点「重启数据面」。',
      )
    }
  } else {
    logger.info('xray.mode=external，面板不托管数据面进程')
  }

  // 从 DB 恢复网关路由表（§9.3 控制面重启）
  const restored = routing.restoreFromDb()
  rebuildRouting(settings, db, routing, false)
  logger.info('网关路由表已从数据库恢复 ' + restored + ' 条，并与期望状态对齐')

  if (settings.get().xray.replayOnStart) {
    logger.info('[boot] 启动对账/重放')
    try {
      const snap = buildDesiredNodes(db, settings, ports)
      const appliedNodes = engine.loadedApplied()
      const res = await reconciler.reconcile(snap.desired, appliedNodes, { apply: true })
      logger.info(
        '启动对账完成：一致=' +
          res.consistent +
          '，新增=' +
          res.plan.add.length +
          '，移除=' +
          res.plan.remove.length +
          '，清理=' +
          res.plan.cleanup.length,
      )
    } catch (e) {
      logger.warn('启动对账失败: ' + (e as Error).message)
    }
  }

  // 上次进程可能在退休队列到期前退出（retireDelayMs 默认 2 分钟）。
  // 启动时立即补跑一次，避免「已删除节点的 outbound 永久残留 → 漂移」。
  try {
    const retired = await retire.processDue()
    if (retired > 0) logger.info('[boot] 退休队列已补清理 ' + retired + ' 个 tag')
  } catch (e) {
    logger.warn('启动退休队列失败: ' + (e as Error).message)
  }

  logger.info('[boot] 启动网关 ' + settings.get().gateway.listen)
  try {
    await gateway.start()
    gatewayError = null
    logger.info('[boot] 网关已监听 ' + settings.get().gateway.listen)
  } catch (e) {
    // 网关监听失败不应拖垮控制面：PANEL.md G6/D8 要求「面板是唯一配置入口」，
    // 用户必须先能打开面板才能改端口/解封，所以这里只告警并继续启动。
    gatewayError = describeListenError(e, settings.get().gateway.listen)
    events.error('gateway.start_failed', '网关启动失败：' + gatewayError)
    logger.error('网关未启动（控制面继续运行）：' + gatewayError + '\n  → 在面板「系统设置 → gateway.listen」改端口，或释放该端口后点「保存」即可自动重建 listener。')
  }

  // ------------------------------------------------------------------ 调度（§13）
  scheduler.add('retire-queue', { everySec: 30 }, async () => {
    await retire.processDue()
  })
  scheduler.add('conn-snapshot', { everySec: 30 }, () => conns.snapshot())
  scheduler.add('reconcile-patrol', { everySec: 300 }, async () => {
    const snap = buildDesiredNodes(db, settings, ports)
    const res = await reconciler.check(snap.desired, engine.loadedApplied(), 'reconcile')
    if (!res.consistent) {
      events.warn('reconcile.drift', '对账巡检发现漂移：缺少 ' + res.drift.missing.length + '，多余 ' + res.drift.extra.length, { detail: res.drift })
    }
  })
  scheduler.add('detect-tick', { everySec: 30 }, async () => {
    if (!settings.get().detect.enabled) return
    const targets = detector.dueTargets(200)
    if (targets.length === 0) return
    await detector.run(targets, { source: 'cron', depth: 'lite' })
    if (settings.get().detect.fullModeEnabled) {
      const fullTargets = targets.filter((_, i) => i % 6 === 0)
      if (fullTargets.length) await detector.run(fullTargets, { source: 'cron', depth: 'full' })
    }
  })
  scheduler.add('sync-tick', { everySec: 30 }, async () => {
    const subs = sync.listSubscriptions(true)
    const now = Date.now()
    for (const s of subs) {
      const interval = (s.interval_sec ?? 0) * 1000
      if (!interval) continue
      if ((s.last_sync_at ?? 0) + interval <= now) {
        jobs.enqueue('sync:' + s.id, 'sync', { subscriptionId: s.id, trigger: 'cron' }, 'cron', async () => sync.runSync(s.id, 'cron'))
      }
    }
  })
  scheduler.add('stale-expiry', { everySec: 3600 }, () => {
    staleExpiryTask(db, settings, events)()
  })
  scheduler.add('cleanup', { cron: '15 4 * * *' }, () => {
    detector.trimHistory()
    conns.trimHistory(7)
    db.delete(xrayApplyOps)
      .where(
        and(
          lt(xrayApplyOps.at, Date.now() - 30 * 86400_000),
          notInArray(
            xrayApplyOps.id,
            db.select({ id: xrayApplyOps.id }).from(xrayApplyOps).orderBy(desc(xrayApplyOps.id)).limit(20000)
          )
        )
      )
      .run()
    logger.info('每日清理完成（apply ops 保留最近 30 天 / 20000 条）')
  })
  scheduler.add('maintenance-window', { everySec: 60 }, async () => {
    if (!inMaintenanceWindow(settings.get().xray.maintenanceWindow)) return
    const threshold = settings.get().xray.hotOpsRestartThreshold
    const hot = retire.hotOpsTotal()
    if (threshold > 0 && hot >= threshold) {
      events.warn('xray.maintenance_restart', '热操作累计 ' + hot + ' 次超过阈值 ' + threshold + '，在维护窗口重启数据面')
      await jobs.enqueue(APPLY_QUEUE, 'restart', { reason: 'maintenance' }, 'system', () => restartDataplane())
    }
  })

  const panelCron = settings.get().publish.scheduleCron
  if (panelCron) {
    scheduler.add('publish-cron', { cron: panelCron }, async () => {
      await jobs.enqueue(APPLY_QUEUE, 'publish', { trigger: 'cron' }, 'cron', async () => publisher.publish({ reason: 'cron' }))
    })
  }
  scheduler.start()

  // ------------------------------------------------------------------ HTTP
  const server = app.listen({ port: config.panelPort, hostname: config.panelHost })
  logger.info('面板与 API 已监听 http://' + config.panelHost + ':' + config.panelPort + '（DATA_DIR=' + config.dataDir + '）')
  events.info('panel.started', 'xc-p 控制面已启动，监听 ' + config.panelPort)

  const shutdown = async (signal: string) => {
    logger.info('收到 ' + signal + '，正在优雅退出…')
    scheduler.stop()
    try {
      gateway.stop()
    } catch {
      /* ignore */
    }
    conns.snapshot()
    await cli.cleanupTemp()
    await xrayProcess.stop()
    server.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/** direct 模式的账号表（附录 A） */
function directCredentials(db: Db): { username: string; password: string }[] {
  const rows = db
    .select({ username: nodeCredentials.username, password_enc: nodeCredentials.password_enc })
    .from(nodeCredentials)
    .all()
  const out: { username: string; password: string }[] = []
  for (const r of rows) {
    try {
      out.push({ username: r.username, password: decryptSecret(r.password_enc) })
    } catch {
      /* 解密失败跳过 */
    }
  }
  return out
}

/** 用期望状态重建网关路由表（含 rename 别名） */
function rebuildRouting(settings: SettingsStore, db: Db, routing: RoutingTable, persist = true): void {
  const desired = buildDesiredNodes(db, settings, new PortPool(db, settings))
  const entries = desired.desired.map((d) => ({ nodeId: d.nodeId, username: d.username, port: d.inboundPort, tag: d.outboundTag }))
  const aliases = db
    .select({ alias: nodeAliases.alias, node_id: nodeAliases.node_id })
    .from(nodeAliases)
    .where(eq(nodeAliases.active, 1))
    .all()
  for (const a of aliases) {
    const base = entries.find((e) => e.nodeId === a.node_id)
    if (base) entries.push({ ...base, username: a.alias })
  }
  routing.replace(entries)
  if (persist) routing.persist()
}

async function waitForApi(cli: XrayCli, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await cli.lso()
    if (r.result.ok) return
    await new Promise((res) => setTimeout(res, 300))
  }
  throw new Error('Xray API 在 ' + timeoutMs + 'ms 内不可达')
}

/** 把 listener 报错翻译成可执行的提示（最常见的是端口被占用） */
function describeListenError(e: unknown, listen: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/EADDRINUSE|address already in use|Failed to listen/i.test(msg)) {
    return '端口已被占用：' + listen + '。请释放该端口，或在「系统设置 → gateway.listen」改成其他端口（例如 localhost:7891）后保存。'
  }
  return msg
}

function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(':')
  if (idx < 0) return { host: 'localhost', port: 7890 }
  const host = listen.slice(0, idx) || 'localhost'
  const port = Number.parseInt(listen.slice(idx + 1), 10) || 7890
  return { host: host === 'localhost' ? '127.0.0.1' : host, port }
}

/**
 * `xc-p healthcheck`：探测控制面自身存活，退出码 0 = 健康。
 *
 * 容器 HEALTHCHECK 依赖这个子命令：distroless 基础镜像没有 curl/wget/shell 可用，
 * 探针必须随二进制一起走（与 Dockerfile 的 HEALTHCHECK 配对）。
 *
 * 判定只取「面板能应答 + SQLite 可读」。/api/health 的 overall 描述的是**数据面**状态
 * （端口池耗尽、网关停用都会变成 degraded），拿它当容器存活条件会让正常运行的面板被反复重启。
 *
 * 必须依次试多个回环写法：面板默认绑 PANEL_HOST=localhost，而 localhost 解析到
 * 127.0.0.1 还是 ::1 因系统而异（实测本机只绑 ::1），写死一个会把健康的面板误判为不健康。
 */
async function runHealthcheck(): Promise<number> {
  let lastErr = ''
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    const url = 'http://' + host + ':' + config.panelPort + '/api/health'
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    } catch (e) {
      lastErr = host + ': ' + (e instanceof Error ? e.message : String(e))
      continue
    }
    if (!res.ok) {
      logger.error('healthcheck: HTTP ' + res.status + '（' + host + '）')
      return 1
    }
    const body = (await res.json()) as { sqlite?: string; overall?: string }
    logger.info('healthcheck: overall=' + body.overall + ' sqlite=' + body.sqlite + '（' + host + '）')
    return body.sqlite === 'ok' ? 0 : 1
  }
  logger.error('healthcheck: 面板无响应（' + (lastErr || '所有回环地址均连接失败') + '）')
  return 1
}

if (process.argv[2] === 'healthcheck') {
  void runHealthcheck().then((code) => process.exit(code))
} else {
  void main().catch((e) => {
    logger.error('启动失败', e instanceof Error ? e.stack : String(e))
    process.exit(1)
  })
}

// I have nothing but my burger and I want nothing more