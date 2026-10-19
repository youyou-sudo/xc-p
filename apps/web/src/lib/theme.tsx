import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

const STORAGE_KEY = "xcp-theme"

interface ThemeContextValue {
  mode: ThemeMode
  theme: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function storedMode(): ThemeMode {
  if (typeof window === "undefined") return "system"
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {
    /* 隐私模式 */
  }
  return "system"
}

function applyTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}

/** 首帧前落定主题，避免闪白；与 ThemeProvider 的存储键保持一致。 */
export const themeInitScript =
  '(function(){try{var m=localStorage.getItem("xcp-theme")||"system";' +
  'var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);' +
  'document.documentElement.classList.toggle("dark",d);' +
  'document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})();'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => storedMode())
  const [theme, setTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === "undefined") return "light"
    return mode === "system" ? systemTheme() : mode
  })

  useEffect(() => {
    const resolved: ResolvedTheme = mode === "system" ? systemTheme() : mode
    setTheme(resolved)
    applyTheme(resolved)
  }, [mode])

  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined" || !window.matchMedia) return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      const resolved: ResolvedTheme = mq.matches ? "dark" : "light"
      setTheme(resolved)
      applyTheme(resolved)
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 隐私模式 */
    }
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({ mode, theme, setMode }), [mode, theme, setMode])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    return {
      mode: "system",
      theme: "light",
      setMode: () => {},
    }
  }
  return ctx
}
