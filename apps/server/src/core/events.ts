import type { Db } from './db'

export type EventLevel = 'info' | 'warn' | 'error'

export interface AppEvent {
  id?: number
  at: number
  level: EventLevel
  kind: string
  nodeId?: string | null
  subscriptionId?: string | null
  revisionId?: string | null
  message: string
  detail?: unknown
}

export type EventListener = (e: AppEvent) => void

/** 面板「事件」页与 SSE 推送源（PANEL.md §6.6 / §15） */
export class EventBus {
  private listeners = new Set<EventListener>()
  private recent: AppEvent[] = []

  constructor(private db: Db) {}

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  recentEvents(limit = 100): AppEvent[] {
    return this.recent.slice(-limit).reverse()
  }

  emit(e: Omit<AppEvent, 'at'> & { at?: number }): AppEvent {
    const ev: AppEvent = { ...e, at: e.at ?? Date.now() }
    try {
      const r = this.db.run(
        'INSERT INTO events (at, level, kind, node_id, subscription_id, revision_id, message, detail_json) VALUES (?,?,?,?,?,?,?,?)',
        [ev.at, ev.level, ev.kind, ev.nodeId ?? null, ev.subscriptionId ?? null, ev.revisionId ?? null, ev.message, ev.detail === undefined ? null : JSON.stringify(ev.detail)],
      )
      ev.id = r.lastInsertRowid
    } catch {
      /* 事件落库失败不应中断业务 */
    }
    this.recent.push(ev)
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500)
    for (const fn of this.listeners) {
      try {
        fn(ev)
      } catch {
        /* 单个订阅者异常不影响其它 */
      }
    }
    return ev
  }

  info(kind: string, message: string, extra: Partial<AppEvent> = {}) {
    return this.emit({ level: 'info', kind, message, ...extra })
  }
  warn(kind: string, message: string, extra: Partial<AppEvent> = {}) {
    return this.emit({ level: 'warn', kind, message, ...extra })
  }
  error(kind: string, message: string, extra: Partial<AppEvent> = {}) {
    return this.emit({ level: 'error', kind, message, ...extra })
  }
}
