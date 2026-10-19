import { Elysia } from 'elysia'
import type { AppContext } from './context'
import { errorPlugin } from './plugins/errors'
import { requestIdPlugin } from './plugins/request-id'
import { createSessionPlugin } from './plugins/session'
import { authModule } from './modules/auth'
import { subscriptionsModule } from './modules/subscriptions'
import { createSubscriptionsService } from './modules/subscriptions/service'
import { nodesModule } from './modules/nodes'
import { createNodesService } from './modules/nodes/service'
import { settingsModule } from './modules/settings'
import { runtimeModule } from './modules/runtime'
import { keysModule } from './modules/keys'
import { jobsModule } from './modules/jobs'
import { eventsModule } from './modules/events'
import { gatewayModule } from './modules/gateway'
import { metricsModule } from './modules/metrics'
import { healthModule } from './modules/health'
import { v1Module } from './modules/v1'
import { webModule } from './modules/web'

/**
 * 控制面组合根（Elysia 最佳实践：modules/<feature> 下按 controller + service + model 拆分）。
 *
 * - 全局生命周期（错误映射、request-id）以 as: 'global' 插件注册；
 * - 会话鉴权通过 session macro（{ requireSession: true }）声明式保护路由；
 * - 必须保持链式 .use()/.get()，否则 Elysia 会丢失路由类型，Eden 客户端无法推导。
 */
export function buildApp(ctx: AppContext) {
  const session = createSessionPlugin(ctx.auth)
  const subscriptions = createSubscriptionsService(ctx)
  const nodes = createNodesService(ctx)

  return new Elysia({ name: 'xc-p' })
    .use(errorPlugin)
    .use(requestIdPlugin)
    .use(authModule(ctx, session))
    .use(subscriptionsModule(ctx, session, subscriptions))
    .use(nodesModule(ctx, session, nodes))
    .use(settingsModule(ctx, session, subscriptions))
    .use(runtimeModule(ctx, session))
    .use(keysModule(ctx, session))
    .use(jobsModule(ctx, session))
    .use(eventsModule(ctx, session))
    .use(gatewayModule(ctx, session))
    .use(metricsModule(ctx))
    .use(healthModule(ctx))
    .use(v1Module(ctx, subscriptions))
    .use(webModule())
}

/** 控制面 Elysia 应用类型：供 @xc-p/api-client 的 Eden Treaty 复用。 */
export type App = ReturnType<typeof buildApp>

// I have nothing but my burger and I want nothing more
