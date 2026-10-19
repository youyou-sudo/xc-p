import { useCallback, useEffect, useRef, useState } from "react"

export interface ResourceState<T> {
  data: T | null
  error: unknown
  loading: boolean
  refreshing: boolean
  updatedAt: number
}

export interface Resource<T> extends ResourceState<T> {
  refresh: () => void
  setData: (data: T) => void
}

/**
 * 统一数据加载：首次加载显示骨架，刷新时保留旧数据；可选轮询（页面隐藏时暂停）。
 */
export function useResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  options: { pollMs?: number; enabled?: boolean } = {},
): Resource<T> {
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const { pollMs, enabled = true } = options
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: enabled,
    refreshing: false,
    updatedAt: 0,
  })

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, loading: false, refreshing: false }))
      return
    }
    const controller = new AbortController()
    let alive = true
    setState((prev) => ({
      ...prev,
      loading: prev.data === null,
      refreshing: prev.data !== null,
      error: null,
    }))
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (!alive) return
        setState({ data, error: null, loading: false, refreshing: false, updatedAt: Date.now() })
      })
      .catch((error) => {
        if (!alive || controller.signal.aborted) return
        setState((prev) => ({ ...prev, loading: false, refreshing: false, error }))
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [key, nonce, enabled])

  useEffect(() => {
    if (!enabled || !pollMs) return
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      setNonce((n) => n + 1)
    }
    const timer = setInterval(tick, pollMs)
    return () => clearInterval(timer)
  }, [enabled, pollMs])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((data: T) => {
    setState((prev) => ({ ...prev, data, updatedAt: Date.now() }))
  }, [])

  return { ...state, refresh, setData }
}

/** 按钮级异步动作：pending 状态直接驱动加载态。 */
export function useAction<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const run = useCallback(async (...args: Args): Promise<R> => {
    setPending(true)
    setError(null)
    try {
      return await fnRef.current(...args)
    } catch (caught) {
      setError(caught)
      throw caught
    } finally {
      setPending(false)
    }
  }, [])

  return { run, pending, error }
}

/** 定时刷新的 “现在”，用于相对时间展示。 */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = useCallback(async (text: string, key = "default") => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
    setCopied(key)
    setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600)
  }, [])
  return { copy, copied }
}

