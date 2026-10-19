import { useRouter } from "@teyik0/furin/link"
import {
  Bell,
  Cable,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Radar,
  Radio,
  Rss,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "监控",
    items: [
      { to: "/", label: "概览", icon: LayoutDashboard },
      { to: "/nodes", label: "节点", icon: Server },
      { to: "/detect", label: "检测", icon: Radar },
      { to: "/gateway", label: "网关", icon: Radio },
      { to: "/events", label: "事件与审计", icon: Bell },
    ],
  },
  {
    label: "配置",
    items: [
      { to: "/subscriptions", label: "订阅", icon: Rss },
      { to: "/runtime", label: "运行配置", icon: GitBranch },
      { to: "/settings", label: "系统设置", icon: Settings },
    ],
  },
  {
    label: "接入",
    items: [
      { to: "/clients", label: "客户端接入", icon: Cable },
      { to: "/credentials", label: "API Key", icon: KeyRound },
    ],
  },
]

export interface RouteMeta {
  title: string
}

const ROUTE_TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.label])),
)

/** 当前逻辑路径（去掉 query/hash），侧栏与顶栏共用。 */
export function usePathname(): string {
  const router = useRouter()
  return (router.currentHref ?? "/").split("?")[0]?.split("#")[0] ?? "/"
}

export function routeMeta(pathname: string): RouteMeta {
  const clean = pathname.split("?")[0] ?? pathname
  return { title: ROUTE_TITLES[clean] ?? "xc-p" }
}

export const APP_NAME = "xc-p"
export const APP_TAGLINE = "Xray 节点池管理面板"
export const PANEL_VERSION = "0.4.0"
