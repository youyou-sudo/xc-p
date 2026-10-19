export type NodeState = 'unknown' | 'up' | 'degraded' | 'down' | 'quarantined'

export interface StateInput {
  prev: NodeState
  ok: boolean
  failStreak: number
  successStreak: number
  recoverAfter: number
  quarantineAfter: number
}

export interface StateOutput {
  state: NodeState
  failStreak: number
  successStreak: number
  recovered: boolean
}

/**
 * 状态机（PANEL.md §8.5）：
 * unknown --首次成功--> up --1~2 次失败--> degraded --fail_streak>=quarantineAfter--> quarantined
 *   |                                          ^
 *   +--首次失败--> down --recoverAfter 次成功---+ (recovered_at=now)
 */
export function nextState(input: StateInput): StateOutput {
  const { prev, ok } = input
  if (ok) {
    const successStreak = input.successStreak + 1
    const recovered = prev === 'down' || prev === 'degraded' || prev === 'quarantined'
    let state: NodeState
    if (prev === 'unknown') state = 'up'
    else if (prev === 'quarantined') state = successStreak >= input.recoverAfter ? 'up' : 'quarantined'
    else if (prev === 'down') state = successStreak >= input.recoverAfter ? 'up' : 'down'
    else if (prev === 'degraded') state = successStreak >= input.recoverAfter ? 'up' : 'degraded'
    else state = 'up'
    return { state, failStreak: 0, successStreak, recovered: recovered && state === 'up' }
  }

  const failStreak = input.failStreak + 1
  let state: NodeState
  if (prev === 'quarantined') state = 'quarantined'
  else if (failStreak >= input.quarantineAfter) state = 'quarantined'
  else if (prev === 'unknown') state = 'down'
  else if (prev === 'up') state = failStreak >= 2 ? 'degraded' : 'up'
  else state = prev === 'down' ? 'down' : 'degraded'
  return { state, failStreak, successStreak: 0, recovered: false }
}

/** 失败退避：min(interval, 60s * 2^fail_streak)，上限 1 小时（§8.4） */
export function backoffMs(baseIntervalSec: number, failStreak: number): number {
  const base = baseIntervalSec * 1000
  const backoff = 60_000 * Math.pow(2, Math.max(0, failStreak - 1))
  return Math.min(base, Math.min(backoff, 3_600_000))
}

/** 抖动：±jitterMs，避免整点雪崩（§8.4） */
export function withJitter(ms: number, jitterMs: number): number {
  if (jitterMs <= 0) return ms
  return ms + Math.floor((Math.random() * 2 - 1) * jitterMs)
}
