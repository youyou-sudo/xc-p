import { eden, setUnauthorizedHandler, unwrap } from "./api"
import { createStore, useStore } from "./store"

export type SessionStatus = "loading" | "authed" | "anon"

export interface SessionState {
  status: SessionStatus
  username: string
}

const sessionStore = createStore<SessionState>({ status: "loading", username: "" })

export function useSession(): SessionState {
  return useStore(sessionStore)
}

let bootPromise: Promise<void> | null = null

/** 首次加载校验会话；401 时由 Eden 的 onResponse 统一清空。 */
export function bootstrapSession(force = false): Promise<void> {
  if (bootPromise && !force) return bootPromise
  bootPromise = (async () => {
    try {
      const r = await unwrap(eden.api.auth.me.get())
      sessionStore.set(r.authenticated ? { status: "authed", username: r.username ?? "admin" } : { status: "anon", username: "" })
    } catch {
      sessionStore.set({ status: "anon", username: "" })
    }
  })()
  return bootPromise
}

export async function login(username: string, password: string): Promise<void> {
  const r = await unwrap(eden.api.auth.login.post({ username, password }))
  sessionStore.set({ status: "authed", username: r.username ?? username })
}

export async function logout(): Promise<void> {
  try {
    await unwrap(eden.api.auth.logout.post())
  } finally {
    sessionStore.set({ status: "anon", username: "" })
  }
}

setUnauthorizedHandler(() => {
  sessionStore.set({ status: "anon", username: "" })
})
