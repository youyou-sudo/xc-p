/**
 * 节点 ID 生成（PANEL.md §7.4）：`{region}{seq}`。
 *
 * - region 来自节点名里的国家关键词 / 旗帜 emoji / 机场常见写法（香港/HK -> hk）
 * - 识别不到时用 n + 序号（n07），面板可一键改名
 * - 冲突追加序号：hk01 已占用 -> hk01-2；已存在的 fingerprint 永不重新生成 ID（由调用方保证）
 */

export const DEFAULT_REGION_FALLBACK = 'n'
export const MIN_SEQ_DIGITS = 2

 /**
 * 地区别名表。键为内部 region 码，值为「出现在名称里的候选串」。
 * 顺序敏感：先长后短，避免 港 抢在 香港 之前、IN 抢在 IND 之前。
 */
const REGION_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['hk', ['香港', 'hongkong', 'hong kong', '🇭🇰', 'hk', 'hkg', '港', '深港', '沪港', '京港', 'cmi', 'hkt', 'hkbn', 'pccw']],
  ['mo', ['澳门', 'macao', 'macau', '🇲🇴', 'mo', 'mfm']],
  ['tw', ['台湾', '臺灣', '台北', '台中', '新北', '彰化', 'taiwan', 'taipei', '🇹🇼', 'tw', 'tpe', 'cht', 'hinet']],
  ['jp', ['日本', '东京', '東京', '大阪', '埼玉', '名古屋', 'japan', 'tokyo', 'osaka', '🇯🇵', 'jp', 'jpn', 'nrt', 'kix']],
  ['kr', ['韩国', '韓國', '首尔', '首爾', 'korea', 'seoul', '🇰🇷', 'kr', 'kor', 'icn']],
  ['sg', ['新加坡', '狮城', '獅城', 'singapore', '🇸🇬', 'sg', 'sgp']],
  ['us', ['美国', '美國', '洛杉矶', '洛杉磯', '圣何塞', '聖何塞', '西雅图', '纽约', '芝加哥', '达拉斯', '凤凰城', '硅谷',
    'united states', 'america', 'los angeles', 'san jose', 'seattle', 'new york', 'chicago', 'dallas', 'phoenix',
    '🇺🇸', 'us', 'usa', 'lax', 'sjc', 'sea', 'nyc', 'ord', 'dfw']],
  ['ca', ['加拿大', '多伦多', '蒙特利尔', '温哥华', 'canada', 'toronto', 'montreal', 'vancouver', '🇨🇦', 'ca', 'can', 'yyz', 'yvr']],
  ['gb', ['英国', '英國', '伦敦', '倫敦', 'united kingdom', 'britain', 'london', '🇬🇧', 'gb', 'uk', 'lhr']],
  ['de', ['德国', '德國', '法兰克福', '法蘭克福', 'germany', 'frankfurt', '🇩🇪', 'de', 'deu', 'fra']],
  ['fr', ['法国', '法國', '巴黎', 'france', 'paris', '🇫🇷', 'fr', 'fra', 'cdg']],
  ['nl', ['荷兰', '荷蘭', '阿姆斯特丹', 'netherlands', 'amsterdam', '🇳🇱', 'nl', 'nld', 'ams']],
  ['ru', ['俄罗斯', '俄羅斯', '莫斯科', '圣彼得堡', 'russia', 'moscow', '🇷🇺', 'ru', 'rus', 'svo']],
  ['au', ['澳大利亚', '澳洲', '悉尼', '墨尔本', 'australia', 'sydney', 'melbourne', '🇦🇺', 'au', 'aus', 'syd']],
  ['in', ['印度', '孟买', '班加罗尔', 'india', 'mumbai', 'bangalore', '🇮🇳', 'in', 'ind', 'bom']],
  ['id', ['印尼', '印度尼西亚', '雅加达', 'indonesia', 'jakarta', '🇮🇩', 'id', 'idn']],
  ['my', ['马来西亚', '馬來西亞', '吉隆坡', 'malaysia', 'kuala lumpur', '🇲🇾', 'my', 'mys', 'kul']],
  ['th', ['泰国', '泰國', '曼谷', 'thailand', 'bangkok', '🇹🇭', 'th', 'tha', 'bkk']],
  ['vn', ['越南', '胡志明', '河内', 'vietnam', 'hanoi', '🇻🇳', 'vn', 'vnm', 'sgn']],
  ['ph', ['菲律宾', '菲律賓', '马尼拉', 'philippines', 'manila', '🇵🇭', 'ph', 'phl', 'mnl']],
  ['tr', ['土耳其', '伊斯坦布尔', 'turkey', 'istanbul', '🇹🇷', 'tr', 'tur', 'ist']],
  ['ae', ['阿联酋', '迪拜', 'emirates', 'dubai', '🇦🇪', 'ae', 'are', 'dxb']],
  ['ch', ['瑞士', '苏黎世', 'switzerland', 'zurich', '🇨🇭', 'ch', 'che', 'zrh']],
  ['se', ['瑞典', '斯德哥尔摩', 'sweden', 'stockholm', '🇸🇪', 'se', 'swe', 'arn']],
  ['fi', ['芬兰', '芬蘭', '赫尔辛基', 'finland', 'helsinki', '🇫🇮', 'fi', 'fin', 'hel']],
  ['no', ['挪威', '奥斯陆', 'norway', 'oslo', '🇳🇴', 'no', 'nor', 'osl']],
  ['dk', ['丹麦', '哥本哈根', 'denmark', 'copenhagen', '🇩🇰', 'dk', 'dnk', 'cph']],
  ['pl', ['波兰', '华沙', '華沙', 'poland', 'warsaw', '🇵🇱', 'pl', 'pol', 'waw']],
  ['ie', ['爱尔兰', '都柏林', 'ireland', 'dublin', '🇮🇪', 'ie', 'irl', 'dub']],
  ['it', ['意大利', '米兰', '罗马', 'italy', 'milan', 'rome', '🇮🇹', 'it', 'ita', 'mxp']],
  ['es', ['西班牙', '马德里', 'spain', 'madrid', '🇪🇸', 'es', 'esp', 'mad']],
  ['br', ['巴西', '圣保罗', 'brazil', 'sao paulo', '🇧🇷', 'br', 'bra', 'gru']],
  ['ar', ['阿根廷', '布宜诺斯艾利斯', 'argentina', 'buenos aires', '🇦🇷', 'ar', 'arg', 'eze']],
  ['mx', ['墨西哥', 'mexico', '🇲🇽', 'mx', 'mex']],
  ['za', ['南非', '约翰内斯堡', 'south africa', 'johannesburg', '🇿🇦', 'za', 'zaf', 'jnb']],
  ['eg', ['埃及', '开罗', 'egypt', 'cairo', '🇪🇬', 'eg', 'egy', 'cai']],
  ['ng', ['尼日利亚', 'nigeria', 'lagos', '🇳🇬', 'ng', 'nga', 'los']],
  ['cn', ['中国', '中國', '内地', '回国', '回國', 'china', 'mainland', '🇨🇳', 'cn', 'chn']],
  ['lt', ['立陶宛', 'lithuania', '🇱🇹', 'lt', 'ltu']],
  ['lv', ['拉脱维亚', 'latvia', '🇱🇻', 'lv', 'lva']],
  ['ee', ['爱沙尼亚', 'estonia', '🇪🇪', 'ee', 'est']],
  ['ua', ['乌克兰', 'ukraine', 'kyiv', '🇺🇦', 'ua', 'ukr']],
  ['ro', ['罗马尼亚', 'romania', 'bucharest', '🇷🇴', 'ro', 'rou']],
  ['bg', ['保加利亚', 'bulgaria', 'sofia', '🇧🇬', 'bg', 'bgr']],
  ['gr', ['希腊', 'greece', 'athens', '🇬🇷', 'gr', 'grc']],
  ['pt', ['葡萄牙', 'portugal', 'lisbon', '🇵🇹', 'pt', 'prt']],
  ['cz', ['捷克', 'czech', 'prague', '🇨🇿', 'cz', 'cze']],
  ['at', ['奥地利', 'austria', 'vienna', '🇦🇹', 'at', 'aut']],
  ['be', ['比利时', 'belgium', 'brussels', '🇧🇪', 'be', 'bel']],
  ['hu', ['匈牙利', 'hungary', 'budapest', '🇭🇺', 'hu', 'hun']],
  ['kz', ['哈萨克斯坦', 'kazakhstan', 'almaty', '🇰🇿', 'kz', 'kaz']],
  ['sa', ['沙特', '利雅得', 'saudi', 'riyadh', '🇸🇦', 'sa', 'sau']],
  ['il', ['以色列', 'israel', 'tel aviv', '🇮🇱', 'il', 'isr']],
  ['nz', ['新西兰', '新西蘭', '奥克兰', 'new zealand', 'auckland', '🇳🇿', 'nz', 'nzl', 'akl']],
  ['cl', ['智利', 'chile', 'santiago', '🇨🇱', 'cl', 'chl']],
  ['co', ['哥伦比亚', 'colombia', 'bogota', '🇨🇴', 'co', 'col']],
  ['pe', ['秘鲁', 'peru', 'lima', '🇵🇪', 'pe', 'per']],
  ['pk', ['巴基斯坦', 'pakistan', 'karachi', '🇵🇰', 'pk', 'pak']],
  ['bd', ['孟加拉', 'bangladesh', 'dhaka', '🇧🇩', 'bd', 'bgd']],
  ['np', ['尼泊尔', 'nepal', 'kathmandu', '🇳🇵', 'np', 'npl']],
  ['lk', ['斯里兰卡', 'sri lanka', 'colombo', '🇱🇰', 'lk', 'lka']],
  ['kh', ['柬埔寨', 'cambodia', 'phnom penh', '🇰🇭', 'kh', 'khm']],
  ['mm', ['缅甸', 'myanmar', 'yangon', '🇲🇲', 'mm', 'mmr']],
  ['la', ['老挝', 'laos', 'vientiane', '🇱🇦', 'la', 'lao']],
  ['mn', ['蒙古', 'mongolia', 'ulaanbaatar', '🇲🇳', 'mn', 'mng']],
  ['ir', ['伊朗', 'iran', 'tehran', '🇮🇷', 'ir', 'irn']],
  ['iq', ['伊拉克', 'iraq', 'baghdad', '🇮🇶', 'iq', 'irq']],
  ['am', ['亚美尼亚', 'armenia', 'yerevan', '🇦🇲', 'am', 'arm']],
  ['ge', ['格鲁吉亚', 'georgia', 'tbilisi', '🇬🇪', 'ge', 'geo']],
  ['md', ['摩尔多瓦', 'moldova', 'chisinau', '🇲🇩', 'md', 'mda']],
  ['rs', ['塞尔维亚', 'serbia', 'belgrade', '🇷🇸', 'rs', 'srb']],
  ['hr', ['克罗地亚', 'croatia', 'zagreb', '🇭🇷', 'hr', 'hrv']],
  ['sk', ['斯洛伐克', 'slovakia', 'bratislava', '🇸🇰', 'sk', 'svk']],
  ['si', ['斯洛文尼亚', 'slovenia', 'ljubljana', '🇸🇮', 'si', 'svn']],
]

/** 旗帜 emoji -> 地区码（两个区域指示符号组合直接对应 ISO 3166-1 alpha-2） */
function regionFromFlagEmoji(name: string): string | undefined {
  const m = /[\u{1F1E6}-\u{1F1FF}]{2}/u.exec(name)
  if (!m) return undefined
  const chars = Array.from(m[0])
  return chars.map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 97)).join('')
}

/** 预编译别名正则：ASCII 别名加词边界，中文/emoji 直接子串匹配 */
const ALIAS_RES: ReadonlyArray<readonly [string, RegExp]> = REGION_ALIASES.flatMap(([region, aliases]) =>
  aliases.map((alias) => {
    const isAscii = /^[\x20-\x7e]+$/.test(alias)
    const body = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = isAscii ? '(?<![a-z0-9])' + body + '(?![a-z0-9])' : body
    return [region, new RegExp(pattern, isAscii ? 'i' : 'u')] as const
  }),
)

/** 从订阅名里识别地区键（hk/jp/us/...；识别不到返回 undefined） */
export function regionKey(name: string): string | undefined {
  if (!name) return undefined
  const text = name.trim()
  if (!text) return undefined
  // 1) 旗帜 emoji 优先级最高：显式且无歧义
  const flag = regionFromFlagEmoji(text)
  if (flag) return flag
  // 2) 关键词表（顺序敏感，先长后短）
  for (const [region, re] of ALIAS_RES) {
    if (re.test(text)) return region
  }
  return undefined
}

/** 把任意外部 region 串规范成节点 ID 前缀；非法/空 -> n */
export function normalizeRegion(region: string | undefined | null): string {
  if (!region) return DEFAULT_REGION_FALLBACK
  const s = String(region).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!s) return DEFAULT_REGION_FALLBACK
  return s.slice(0, 4)
}

/** 序号格式化：默认最少 2 位（1 -> 01，12 -> 12，100 -> 100） */
export function formatSeq(seq: number, digits = MIN_SEQ_DIGITS): string {
  const n = Math.max(1, Math.trunc(Number.isFinite(seq) ? seq : 1))
  return String(n).padStart(digits, '0')
}

/** PANEL.md §7.4：{region}{seq}，冲突追加序号；existing 为大写无关的已用集合 */
export function allocateNodeId(region: string | undefined, existing: Set<string>, seqStart = 1): string {
  const prefix = normalizeRegion(region)
  const used = new Set<string>()
  for (const id of existing) used.add(String(id).trim().toLowerCase())

  const start = Number.isFinite(seqStart) && seqStart > 0 ? Math.trunc(seqStart) : 1
  let candidate = ''
  for (let i = start; i < start + 100000; i++) {
    candidate = prefix + formatSeq(i)
    if (!used.has(candidate)) return candidate
  }
  // 极端兜底：序号空间被占满时用碰撞后缀
  for (let i = 2; i < 100000; i++) {
    candidate = prefix + formatSeq(start) + '-' + i
    if (!used.has(candidate)) return candidate
  }
  throw new Error('无法为 region=' + prefix + ' 分配节点 ID')
}

/** 便捷封装：为一批节点按顺序分配 ID（保持输入顺序，内部维护已用集合） */
export function allocateNodeIds(regions: (string | undefined)[], existing: Set<string> = new Set()): string[] {
  const used = new Set<string>(existing)
  const out: string[] = []
  for (const r of regions) {
    const id = allocateNodeId(r, used)
    used.add(id)
    out.push(id)
  }
  return out
}
