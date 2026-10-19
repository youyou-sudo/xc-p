import type { ConnectionStrings } from "@/lib/domain"

export type ConnectionFormatId = "http" | "socks5" | "curl" | "docker" | "env" | "clash"

export interface ConnectionFormat {
  id: ConnectionFormatId
  label: string
  /** Tab 下的一句中文说明：这个格式给谁用、贴到哪里。 */
  description: string
  code: (connection: ConnectionStrings) => string
}

export const CONNECTION_FORMATS: ConnectionFormat[] = [
  {
    id: "http",
    label: "HTTP",
    description: "HTTP(S) 代理地址：浏览器、系统代理或大多数 SDK 直接填这一条。密码就是节点的凭据，请当密码保管。",
    code: (connection) => connection.http,
  },
  {
    id: "socks5",
    label: "SOCKS5",
    description: "SOCKS5 地址。socks5h 表示 DNS 解析也在代理解析，避免本地 DNS 泄漏。",
    code: (connection) => connection.socks5,
  },
  {
    id: "curl",
    label: "curl",
    description: "在终端里验证该节点出口是否生效：返回的 IP 应为节点出口 IP。",
    code: (connection) => connection.curl,
  },
  {
    id: "docker",
    label: "Docker",
    description: "容器环境变量：可写进 docker-compose 的 environment，或用 -e 逐个传入。服务端按数组返回，这里按多行展示。",
    code: (connection) => connection.docker.join("\n"),
  },
  {
    id: "env",
    label: "环境变量",
    description: "shell 的 export 片段或 .env 内容；NO_PROXY 保留内网直连，避免面板自身流量走代理。",
    code: (connection) => connection.env,
  },
  {
    id: "clash",
    label: "Clash",
    description: "Clash / Mihomo 的 proxies 片段，合并到配置文件的 proxies 数组即可。",
    code: (connection) => connection.clash,
  },
]

/** 「复制全部格式」用的文本：每个格式带中文标题，便于贴进工单或文档。 */
export function allFormatsText(nodeId: string, connection: ConnectionStrings): string {
  return CONNECTION_FORMATS.map((format) => "# " + format.label + "（" + nodeId + "）\n" + format.code(connection)).join("\n\n")
}
