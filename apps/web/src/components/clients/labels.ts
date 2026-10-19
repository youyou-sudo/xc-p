/** 客户端接入页的中文文案映射：国家/地区码与网关认证模式。 */

const COUNTRY_LABELS: Record<string, string> = {
  HK: "香港",
  MO: "澳门",
  TW: "台湾",
  JP: "日本",
  KR: "韩国",
  SG: "新加坡",
  US: "美国",
  CA: "加拿大",
  GB: "英国",
  DE: "德国",
  FR: "法国",
  NL: "荷兰",
  RU: "俄罗斯",
  AU: "澳大利亚",
  IN: "印度",
  ID: "印尼",
  MY: "马来西亚",
  TH: "泰国",
  VN: "越南",
  PH: "菲律宾",
  TR: "土耳其",
  AE: "阿联酋",
  CH: "瑞士",
  SE: "瑞典",
  FI: "芬兰",
  NO: "挪威",
  DK: "丹麦",
  PL: "波兰",
  IE: "爱尔兰",
  IT: "意大利",
  ES: "西班牙",
  BR: "巴西",
  AR: "阿根廷",
  MX: "墨西哥",
  ZA: "南非",
  EG: "埃及",
  NG: "尼日利亚",
  CN: "中国",
  LT: "立陶宛",
  LV: "拉脱维亚",
  EE: "爱沙尼亚",
  UA: "乌克兰",
  RO: "罗马尼亚",
  BG: "保加利亚",
  GR: "希腊",
  PT: "葡萄牙",
  CZ: "捷克",
  AT: "奥地利",
  BE: "比利时",
  HU: "匈牙利",
  KZ: "哈萨克斯坦",
  SA: "沙特",
  IL: "以色列",
  NZ: "新西兰",
  CL: "智利",
  CO: "哥伦比亚",
  PE: "秘鲁",
  PK: "巴基斯坦",
  BD: "孟加拉",
  NP: "尼泊尔",
  LK: "斯里兰卡",
  KH: "柬埔寨",
  MM: "缅甸",
  LA: "老挝",
  MN: "蒙古",
  IR: "伊朗",
  IQ: "伊拉克",
}

export function countryLabel(code?: string | null): string {
  if (!code) return ""
  const key = code.toUpperCase()
  return COUNTRY_LABELS[key] ?? key
}

/** 节点 ID 前缀（hk01 → HK）；region 优先，其次 countryCode。 */
export function nodeRegion(node: { region?: string | null; countryCode?: string | null }): string {
  const region = node.region?.trim()
  if (region) return region.toUpperCase()
  return node.countryCode?.trim().toUpperCase() ?? ""
}

export function authModeLabel(mode?: string): { label: string; tone: "ok" | "degraded"; hint: string } {
  if (mode === "username-only") {
    return { label: "宽松", tone: "degraded", hint: "仅校验用户名（不推荐公网暴露）" }
  }
  return { label: "严格", tone: "ok", hint: "用户名 + 密码" }
}
