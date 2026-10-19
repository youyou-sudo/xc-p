/**
 * 订阅子系统的类型契约（见 PANEL.md §7.3、docs/IMPL-CONTRACTS.md §2）。
 * 本模块的所有解析/归一化函数都是纯函数：不读文件、不联网、不写库。
 */

export type Protocol =
  | 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan'
  | 'hysteria2' | 'tuic' | 'socks' | 'http'

/** PANEL.md §7.3 的统一内部模型；sourceSubscriptionId 由调用方注入 */
export interface NodeInput {
  protocol: Protocol
  server: string
  port: number
  credential: string
  params: Record<string, unknown>
  name: string
  raw: string
  sourceSubscriptionId: string
}

export interface ParseErrorSample {
  lineNo: number
  rawSnippet: string
  errorKind: string
  errorMsg: string
}

export interface ParseResult {
  /** 命中的格式：xray|singbox|clash|base64|links|json_array */
  format: string
  nodes: NodeInput[]
  errors: ParseErrorSample[]
}

export type SubFormatHint = 'auto' | 'base64' | 'clash' | 'singbox' | 'xray' | 'links'

/** 归一化结果：入库所需的一切 */
export interface NormalizedNode {
  protocol: Protocol
  server: string
  port: number
  credential: string
  params: Record<string, unknown>
  name: string
  raw: string
  /** sha1(protocol|server|port|credential) */
  fingerprint: string
  /** params 规范化排序后的 sha1 */
  paramsHash: string
  /** 是否可被本 Xray 构建发布（PANEL.md D9） */
  protocolSupported: boolean
  /** 不含 tag 的 Xray outbound（protocol/settings/streamSettings/...） */
  outbound: Record<string, unknown>
}

/** 解析辅助：单条候选节点（协议之外全部可选，由各解析器补齐后统一校验） */
export interface CandidateNode {
  protocol: string
  server?: string
  port?: number | string
  credential?: string
  params?: Record<string, unknown>
  name?: string
  raw?: string
}

/**
 * 单条候选的解析结果。失败时 `ok:false` 并给出错误分类。
 * `protocol` 总是尽力填上，便于错误样本定位。
 */
export type ParseOne =
  | { ok: true; node: NodeInput }
  | { ok: false; protocol: string; errorKind: string; errorMsg: string }

