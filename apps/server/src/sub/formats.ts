/**
 * 格式识别与分发（PANEL.md §7.2）。纯函数：不读文件、不联网、不写库。
 *
 * 顺序：xray/v2ray JSON -> sing-box JSON -> Clash YAML -> base64 链接列表 -> 明文链接列表 -> JSON 节点数组。
 * 「命中即停」的判定标准是**成功产出至少一个节点**；产出 0 个节点的分支会继续往下尝试，
 * 这样「整体 base64 里裹着 YAML」之类的畸形订阅也能被救回来。
 */

import { tryBase64Decode, unfoldText } from './b64'
import { looksLikeClash, parseClashYaml } from './clash'
import { isLinkLine, parseLinkFragments, parseLinkLines } from './links'
import { looksLikeSingBoxConfig, looksLikeXrayConfig, parseXrayConfig } from './xray-json'
import { parseJsonNodeArray, parseSingBoxConfig } from './singbox'
import type { ParseErrorSample, ParseResult, SubFormatHint } from './types'

const MAX_SNIPPET = 160

function snippet(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET) + '...' : t
}

function toSamples(
  errors: { lineNo: number; raw: string; errorKind: string; errorMsg: string }[],
): ParseErrorSample[] {
  return errors.map((e) => ({
    lineNo: e.lineNo,
    rawSnippet: snippet(e.raw),
    errorKind: e.errorKind,
    errorMsg: e.errorMsg,
  }))
}

export function looksLikeJson(body: string): boolean {
  const t = body.trim()
  if (!t) return false
  const first = t[0]
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

 /** 按 PANEL.md §7.2 的顺序尝试，命中即停。hint!=='auto' 时只尝试该格式。 */
export function parseSubscription(
  body: string,
  hint: SubFormatHint,
  sourceSubscriptionId: string,
): ParseResult {
  const text = unfoldText(body)
  if (!text) {
    return {
      format: 'links',
      nodes: [],
      errors: [{ lineNo: 0, rawSnippet: '', errorKind: 'empty_body', errorMsg: '订阅体为空' }],
    }
  }
  if (hint !== 'auto') return parseWithHint(text, hint, sourceSubscriptionId)

  const tried: ParseErrorSample[] = []

  /* 1) JSON 家族：xray / sing-box / 节点数组 */
  if (looksLikeJson(text)) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      tried.push({
        lineNo: 0,
        rawSnippet: snippet(text),
        errorKind: 'bad_json',
        errorMsg: err instanceof Error ? err.message : String(err),
      })
      json = undefined
    }
    if (json !== undefined) {
      if (looksLikeXrayConfig(json)) {
        const r = parseXrayConfig(json, sourceSubscriptionId)
        if (r.nodes.length) {
          return { format: 'xray', nodes: r.nodes, errors: toSamples(r.errors) }
        }
        tried.push(...toSamples(r.errors))
      } else if (looksLikeSingBoxConfig(json)) {
        const r = parseSingBoxConfig(json, sourceSubscriptionId)
        if (r.nodes.length) {
          return { format: 'singbox', nodes: r.nodes, errors: toSamples(r.errors) }
        }
        tried.push(...toSamples(r.errors))
      } else if (Array.isArray(json)) {
        const r = parseJsonNodeArray(json, sourceSubscriptionId)
        if (r.nodes.length) {
          return { format: 'json_array', nodes: r.nodes, errors: toSamples(r.errors) }
        }
        tried.push(...toSamples(r.errors))
      } else {
        tried.push({
          lineNo: 0,
          rawSnippet: snippet(text),
          errorKind: 'format_unknown',
          errorMsg: 'JSON 顶层既不是 outbounds 容器，也不是节点数组',
        })
      }
    }
  }

  /* 2) Clash / mihomo YAML */
  if (looksLikeClash(text)) {
    const r = parseClashYaml(text, sourceSubscriptionId)
    if (r.nodes.length) {
      return { format: 'clash', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    tried.push(...toSamples(r.errors))
  }

  /* 3) 整体 base64 编码的链接列表 */
  const decoded = tryBase64Decode(text)
  if (decoded && decoded.includes('://')) {
    const r = parseLinkLines(decoded, { sourceSubscriptionId })
    if (r.nodes.length) {
      return { format: 'base64', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    tried.push(...toSamples(r.errors))
  }

  /* 4) 明文链接列表 */
  if (text.split('\n').some((l) => isLinkLine(l))) {
    const r = parseLinkLines(text, { sourceSubscriptionId })
    if (r.nodes.length) {
      return { format: 'links', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    tried.push(...toSamples(r.errors))
  }

  /* 5) 兜底 A：混合内容里逐行捞链接（能解析多少算多少） */
  const fragments = parseLinkFragments(text, { sourceSubscriptionId })
  if (fragments.nodes.length) {
    return {
      format: 'links',
      nodes: fragments.nodes,
      errors: fragments.rejected.map((r) => ({
        lineNo: r.lineNo,
        rawSnippet: snippet(r.raw),
        errorKind: 'bad_link',
        errorMsg: '不是受支持的分享链接或 JSON 节点',
      })),
    }
  }

  /* 6) 兜底 B：单行 JSON 对象组成的列表（每行一个节点对象） */
  const jsonLines = parseJsonLines(text, sourceSubscriptionId)
  if (jsonLines) return jsonLines

  /* 7) 全部失败：保留样本，调用方按 format_unknown 处理 */
  return {
    format: 'unknown',
    nodes: [],
    errors: tried.length
      ? tried
      : [{
        lineNo: 0,
        rawSnippet: snippet(text),
        errorKind: 'format_unknown',
        errorMsg: '未命中任何已知订阅格式',
      }],
  }
}

function parseWithHint(
  text: string,
  hint: Exclude<SubFormatHint, 'auto'>,
  sourceSubscriptionId: string,
): ParseResult {
  switch (hint) {
    case 'xray': {
      const json = safeJson(text)
      if (json === undefined || !looksLikeXrayConfig(json)) {
        return fail('xray', text, 'bad_json', '不是合法的 Xray/v2ray JSON 配置')
      }
      const r = parseXrayConfig(json, sourceSubscriptionId)
      return { format: 'xray', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    case 'singbox': {
      const json = safeJson(text)
      if (json === undefined || !looksLikeSingBoxConfig(json)) {
        return fail('singbox', text, 'bad_json', '不是合法的 sing-box JSON 配置')
      }
      const r = parseSingBoxConfig(json, sourceSubscriptionId)
      return { format: 'singbox', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    case 'clash': {
      if (!looksLikeClash(text)) {
        return fail('clash', text, 'bad_yaml', '不是 Clash/mihomo YAML（缺少 proxies:）')
      }
      const r = parseClashYaml(text, sourceSubscriptionId)
      return { format: 'clash', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    case 'base64': {
      const decoded = tryBase64Decode(text)
      if (!decoded || !decoded.includes('://')) {
        return fail('base64', text, 'bad_base64', '整体 base64 解码失败或解码后不含链接')
      }
      const r = parseLinkLines(decoded, { sourceSubscriptionId })
      return { format: 'base64', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    case 'links': {
      const r = parseLinkLines(text, { sourceSubscriptionId })
      if (!r.nodes.length && !r.errors.length) {
        return fail('links', text, 'format_unknown', '没有找到明文分享链接')
      }
      return { format: 'links', nodes: r.nodes, errors: toSamples(r.errors) }
    }
    default:
      return fail('unknown', text, 'unsupported_format', '未知的格式提示：' + String(hint))
  }
}

/**
 * 兜底 B：每行一个 JSON 对象的订阅（部分自建面板这么发）。
 * 成功率太低时返回 undefined，让调用方走「整体识别失败」。
 */
function parseJsonLines(text: string, sourceSubscriptionId: string): ParseResult | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return undefined
  if (!lines.every((l) => l.startsWith('{'))) return undefined
  const entries: Record<string, unknown>[] = []
  const errors: ParseErrorSample[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象')
      entries.push(parsed as Record<string, unknown>)
    } catch (err) {
      errors.push({
        lineNo: i + 1,
        rawSnippet: snippet(lines[i]),
        errorKind: 'bad_json',
        errorMsg: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (!entries.length) return undefined
  const r = parseJsonNodeArray(entries, sourceSubscriptionId)
  if (!r.nodes.length) return undefined
  return { format: 'json_array', nodes: r.nodes, errors: toSamples(r.errors).concat(errors) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function fail(format: string, text: string, errorKind: string, errorMsg: string): ParseResult {
  return {
    format,
    nodes: [],
    errors: [{ lineNo: 0, rawSnippet: snippet(text), errorKind, errorMsg }],
  }
}