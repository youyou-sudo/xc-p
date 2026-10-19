/**
 * 订阅解析测试（PANEL.md §7 + docs/IMPL-CONTRACTS.md §2）。
 * 全部用例都是纯函数调用：fixture 从磁盘读入后只走内存。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { base64Encode, normalizeBase64, tryBase64Decode } from '../src/sub/b64'
import { parseSubscription, looksLikeJson } from '../src/sub/formats'
import { parseLinkLine, parseLinkLines, splitHostPort } from '../src/sub/links'
import {
  PROTOCOL_SUPPORT_MATRIX, fingerprintOf, normalizeNode, normalizeNodes, paramsHashOf,
} from '../src/sub/normalize'
import { allocateNodeId, allocateNodeIds, formatSeq, normalizeRegion, regionKey } from '../src/sub/naming'
import type { NodeInput, Protocol, SubFormatHint } from '../src/sub/types'

const FIXTURES = join(import.meta.dir, 'fixtures', 'sub')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const node = (over: Partial<NodeInput> = {}): NodeInput => ({
  protocol: 'ss',
  server: 'e.example.com',
  port: 8388,
  credential: 'pw',
  params: {},
  name: 'n',
  raw: 'raw',
  sourceSubscriptionId: 'sub-1',
  ...over,
})

/* ============================================================ 基础工具 */

describe('base64 变体', () => {
  test('标准 / URL-safe / 缺 padding 都能解码', () => {
    const text = 'ss://aes-256-gcm:pw@h.example.com:8388#香港'
    const std = base64Encode(text)
    expect(tryBase64Decode(std)).toBe(text)
    expect(tryBase64Decode(std.replace(/\+/g, '-').replace(/\//g, '_'))).toBe(text)
    expect(tryBase64Decode(std.replace(/=+$/, ''))).toBe(text)
    expect(tryBase64Decode(std.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))).toBe(text)
  })

  test('非 base64 返回 undefined，而不是抛异常', () => {
    expect(tryBase64Decode('这不是 base64')).toBeUndefined()
    expect(tryBase64Decode('ss://plain@h:1')).toBeUndefined()
  })

  test('normalizeBase64 处理 URL-safe 与 padding', () => {
    expect(normalizeBase64('a-b_c')).toBe('a+b/c')
    expect(normalizeBase64('a-b_c')).toBe('a+b/c')
    expect(normalizeBase64('YWJj')).toBe('YWJj')
    expect(normalizeBase64('YWJjZA')).toBe('YWJjZA==')
    expect(normalizeBase64('YWJjZGU')).toBe('YWJjZGU=')
  })

  test('looksLikeJson 只认合法 JSON', () => {
    expect(looksLikeJson('{"outbounds":[]}')).toBe(true)
    expect(looksLikeJson('[1,2]')).toBe(true)
    expect(looksLikeJson('ss://x@y:1')).toBe(false)
    expect(looksLikeJson('{"a":')).toBe(false)
  })
})

describe('链接原语', () => {
  test('splitHostPort 支持域名、IPv4、[IPv6] 与缺端口', () => {
    expect(splitHostPort('h.example.com:8388')).toEqual({ host: 'h.example.com', port: 8388 })
    expect(splitHostPort('1.2.3.4:443')).toEqual({ host: '1.2.3.4', port: 443 })
    expect(splitHostPort('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 })
    expect(splitHostPort('nohost')).toEqual({ host: 'nohost', port: undefined })
    expect(splitHostPort('h.example.com:notaport')).toEqual({ host: 'h.example.com', port: undefined })
  })
})

/* ======================================================== 协议覆盖矩阵 */

describe('分享链接解析覆盖', () => {
  const cases: { proto: Protocol | 'ssr-outer'; line: string; server: string; port: number; credential: string }[] = [
    {
      proto: 'ss',
      line: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQxMjM@hk.example.com:8388#香港',
      server: 'hk.example.com', port: 8388, credential: 'password123',
    },
    {
      proto: 'ss',
      line: 'ss://' + base64Encode('aes-128-gcm:pw-legacy@jp.example.com:8389') + '#日本',
      server: 'jp.example.com', port: 8389, credential: 'pw-legacy',
    },
    {
      proto: 'ss',
      line: 'ss://' + base64Encode('2022-blake3-aes-128-gcm') + ':' + base64Encode('QUFBQUFBQUFBQUFBQUFBQQ==')
        + '@k.example.com:8390#SS2022-左右分别base64',
      server: 'k.example.com', port: 8390, credential: 'QUFBQUFBQUFBQUFBQUFBQQ==',
    },
    {
      proto: 'ssr',
      line: 'ssr://' + base64Encode('ssr.example.com:8388:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:cGFzc3dvcmQxMjM/')
        + '?remarks=' + Buffer.from('日本-SSR').toString('base64url'),
      server: 'ssr.example.com', port: 8388, credential: 'password123',
    },
    {
      proto: 'vmess',
      line: 'vmess://' + base64Encode(JSON.stringify({
        v: '2', ps: 'US-01', add: 'us.example.com', port: '443',
        id: 'b831381d-6324-4d53-ad4f-8cda48b30811', aid: '0', scy: 'auto',
        net: 'ws', type: 'none', host: 'us.example.com', path: '/vm', tls: 'tls', sni: 'us.example.com',
      })),
      server: 'us.example.com', port: 443, credential: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    },
    {
      proto: 'vmess',
      line: 'vmess://' + JSON.stringify({ add: 'us2.example.com', port: 8443, id: 'b831381d-6324-4d53-ad4f-8cda48b30812', net: 'grpc' }),
      server: 'us2.example.com', port: 8443, credential: 'b831381d-6324-4d53-ad4f-8cda48b30812',
    },
    {
      proto: 'vless',
      line: 'vless://11111111-1111-1111-1111-111111111111@sg.example.com:443?encryption=none&security=reality'
        + '&sni=www.microsoft.com&fp=chrome&pbk=' + 'A'.repeat(43) + '&sid=0123456789abcdef&flow=xtls-rprx-vision&type=tcp#SG',
      server: 'sg.example.com', port: 443, credential: '11111111-1111-1111-1111-111111111111',
    },
    {
      proto: 'vless',
      line: 'vless://22222222-2222-2222-2222-222222222222@jp.example.com:8443?encryption=none&security=tls'
        + '&type=ws&path=%2Fws&host=jp.example.com&alpn=h2%2Chttp%2F1.1#JP',
      server: 'jp.example.com', port: 8443, credential: '22222222-2222-2222-2222-222222222222',
    },
    {
      proto: 'vless',
      line: 'vless://33333333-3333-3333-3333-333333333333@de.example.com:2053?encryption=none&security=tls&type=grpc&serviceName=gsvc&mode=gun#DE',
      server: 'de.example.com', port: 2053, credential: '33333333-3333-3333-3333-333333333333',
    },
    {
      proto: 'trojan',
      line: 'trojan://trojan-pass@ca.example.com:443?security=tls&sni=ca.example.com&type=ws&path=%2Ftj&host=ca.example.com#CA',
      server: 'ca.example.com', port: 443, credential: 'trojan-pass',
    },
    {
      proto: 'hysteria2',
      line: 'hysteria2://hy2pass@nl.example.com:443?sni=nl.example.com&insecure=1&obfs=salamander&obfs-password=obfs#NL',
      server: 'nl.example.com', port: 443, credential: 'hy2pass',
    },
    {
      proto: 'hysteria2',
      line: 'hy2://hy2pass2@fi.example.com:8443?sni=fi.example.com&alpn=h3#FI',
      server: 'fi.example.com', port: 8443, credential: 'hy2pass2',
    },
    {
      proto: 'tuic',
      line: 'tuic://55555555-5555-5555-5555-555555555555:tuicpass@au.example.com:443?sni=au.example.com&congestion_control=bbr#AU',
      server: 'au.example.com', port: 443, credential: '55555555-5555-5555-5555-555555555555',
    },
    {
      proto: 'socks',
      line: 'socks5://sockuser:sockpass@tr.example.com:1080#TR',
      server: 'tr.example.com', port: 1080, credential: 'sockuser:sockpass',
    },
    {
      proto: 'http',
      line: 'http://httpuser:httppass@br.example.com:8080#BR',
      server: 'br.example.com', port: 8080, credential: 'httpuser:httppass',
    },
    {
      proto: 'http',
      line: 'https://secure@ch.example.com:8443?tls=1#CH',
      server: 'ch.example.com', port: 8443, credential: 'secure',
    },
  ]

  for (const c of cases) {
    test(c.proto + ' -> ' + c.server + ':' + c.port, () => {
      const r = parseLinkLine(c.line, { sourceSubscriptionId: 'sub-1' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.node.protocol).toBe(c.proto as typeof r.node.protocol)
      expect(r.node.server).toBe(c.server)
      expect(r.node.port).toBe(c.port)
      expect(r.node.credential).toBe(c.credential)
      expect(r.node.sourceSubscriptionId).toBe('sub-1')
      expect(r.node.raw).toBe(c.line)
    })
  }
})

/* ============================================================ ss 变体细节 */

describe('ss 的 SIP002 变体与 plugin', () => {
  test('method / password / plugin / pluginOpts 全部落到 params', () => {
    const line = 'ss://YWVzLTEyOC1nY206cGFzcw==@h.example.com:8392'
      + '?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dexample.com%3Bpath%3D%2Fws%3Btls#plugin'
    const r = parseLinkLine(line, { sourceSubscriptionId: 's' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.node.params.method).toBe('aes-128-gcm')
    expect(r.node.credential).toBe('pass')
    expect(r.node.params.plugin).toBe('v2ray-plugin')
    expect(r.node.params.pluginOpts).toEqual({ mode: 'websocket', host: 'example.com', path: '/ws', tls: 'true' })
  })

  test('method 与 password 分别 base64 的写法', () => {
    const line = 'ss://' + base64Encode('2022-blake3-aes-256-gcm') + ':' + base64Encode('cGFzc3dvcmQtMjAyMg==')
      + '@h.example.com:8390#t'
    const r = parseLinkLine(line, { sourceSubscriptionId: 's' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.node.params.method).toBe('2022-blake3-aes-256-gcm')
    expect(r.node.credential).toBe('cGFzc3dvcmQtMjAyMg==')
  })

  test('缺 method / uuid / password 一律判为坏行', () => {
    for (const bad of [
      'ss://not-valid-base64-at-all!!!@bad.example.com:8388#x',
      'ss://aes-256-gcm:pw@bad.example.com:notaport#x',
      'vmess://' + base64Encode(JSON.stringify({ add: 'a.example.com', port: '443' })) + '#nouuid',
      'vless://nope#nohost',
      'trojan://@h.example.com:443#nopass',
      'socks4://u:p@h.example.com:1080#socks4',
      'foo://whatever@x.example.com:1#unknown',
    ]) {
      const r = parseLinkLine(bad, { sourceSubscriptionId: 's' })
      expect(r.ok).toBe(false)
    }
  })
})

/* ================================================================ 各格式 */

describe('base64 整体编码', () => {
  test('标准 base64 订阅体', () => {
    const r = parseSubscription(read('base64-links.txt'), 'auto', 'sub-b64')
    expect(r.format).toBe('base64')
    expect(r.nodes.length).toBe(4)
    expect(r.errors).toEqual([])
    expect(r.nodes.map((n) => n.protocol)).toEqual(['ss', 'ss', 'vmess', 'vless'])
    expect(r.nodes.every((n) => n.sourceSubscriptionId === 'sub-b64')).toBe(true)
  })

  test('URL-safe + 无 padding 变体等价', () => {
    const std = parseSubscription(read('base64-links.txt'), 'auto', 's')
    const alt = parseSubscription(read('base64-urlsafe-nopad.txt'), 'auto', 's')
    expect(alt.format).toBe('base64')
    expect(alt.nodes.map((n) => normalizeNode(n).fingerprint))
      .toEqual(std.nodes.map((n) => normalizeNode(n).fingerprint))
  })

  test('hint=base64 时只走 base64', () => {
    expect(parseSubscription(read('base64-links.txt'), 'base64', 's').format).toBe('base64')
    expect(() => parseSubscription(read('links-plain.txt'), 'base64', 's')).not.toThrow()
    const r = parseSubscription(read('links-plain.txt'), 'base64', 's')
    expect(r.nodes.length).toBe(0)
    expect(r.errors[0]?.errorKind).toBe('bad_base64')
  })
})

describe('明文链接列表', () => {
  test('逐行解析并保留注释/空行语义', () => {
    const r = parseSubscription(read('links-plain.txt'), 'auto', 'sub-links')
    expect(r.format).toBe('links')
    expect(r.nodes.length).toBe(4)
    expect(r.errors).toEqual([])
  })

  test('覆盖全部协议', () => {
    const r = parseSubscription(read('links-all-protocols.txt'), 'auto', 'sub-all')
    expect(r.format).toBe('links')
    expect(r.errors).toEqual([])
    const protos = new Set(r.nodes.map((n) => n.protocol))
    for (const p of ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks', 'http'] as Protocol[]) {
      expect(protos.has(p)).toBe(true)
    }
  })

  test('ss 的 SIP002 变体各有独立结果', () => {
    const r = parseSubscription(read('links-ss-variants.txt'), 'auto', 's')
    expect(r.format).toBe('links')
    expect(r.nodes.length).toBe(6)
    expect(r.errors).toEqual([])
    expect(r.nodes[0].params.method).toBe('aes-256-gcm')
    expect(r.nodes[1].params.method).toBe('aes-128-gcm')
    expect(r.nodes[2].params.method).toBe('2022-blake3-aes-128-gcm')
    expect(r.nodes[3].params.plugin).toBe('obfs-local')
    expect(r.nodes[5].params.plugin).toBe('obfs-local')
  })
})

describe('含错误行的 fixture：错误只计数不失败', () => {
  test('混合坏行仍产出可用节点', () => {
    const r = parseSubscription(read('links-with-errors.txt'), 'auto', 'sub-err')
    expect(r.nodes.length).toBeGreaterThan(0)
    expect(r.errors.length).toBeGreaterThan(0)
    // 每个错误样本都要能定位到行
    for (const e of r.errors) {
      expect(e.lineNo).toBeGreaterThan(0)
      expect(e.errorKind.length).toBeGreaterThan(0)
      expect(e.errorMsg.length).toBeGreaterThan(0)
    }
    const kinds = new Set(r.errors.map((e) => e.errorKind))
    expect(kinds.has('bad_port') || kinds.has('bad_link')).toBe(true)
  })

  test('完全无法识别时返回 0 节点并给出 format_unknown', () => {
    const r = parseSubscription('这不是任何订阅格式\n真的不是', 'auto', 's')
    expect(r.nodes).toEqual([])
    expect(r.errors[0]?.errorKind).toBe('format_unknown')
  })

  test('空订阅体', () => {
    const r = parseSubscription('   \n  ', 'auto', 's')
    expect(r.nodes).toEqual([])
    expect(r.errors[0]?.errorKind).toBe('empty_body')
  })
})

describe('Clash / mihomo YAML', () => {
  test('proxies 列表全协议', () => {
    const r = parseSubscription(read('clash-proxies.yaml'), 'auto', 'sub-clash')
    expect(r.format).toBe('clash')
    const protos = new Set(r.nodes.map((n) => n.protocol))
    for (const p of ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks', 'http'] as Protocol[]) {
      expect(protos.has(p)).toBe(true)
    }
    expect(r.errors.length).toBe(2)
  })

  test('ss 的 cipher / 2022 密码 / plugin-opts 落到 params', () => {
    const r = parseSubscription(read('clash-proxies.yaml'), 'clash', 's')
    const ss2022 = r.nodes.find((n) => n.name.includes('2022'))!
    expect(ss2022.params.method).toBe('2022-blake3-aes-128-gcm')
    expect(ss2022.credential).toBe('QUFBQUFBQUFBQUFBQUFBQQ==')
    expect(ss2022.params.plugin).toBe('obfs')
    expect(ss2022.params.pluginOpts).toEqual({ mode: 'tls', host: 'www.bing.com' })
  })

  test('vmess 的 alterId / cipher / ws-opts / tls', () => {
    const r = parseSubscription(read('clash-proxies.yaml'), 'clash', 's')
    const vm = r.nodes.find((n) => n.name.includes('美国'))!
    expect(vm.params.alterId).toBe(0)
    expect(vm.params.security).toBe('auto')
    expect(vm.params.network).toBe('ws')
    expect(vm.params.path).toBe('/vm')
    expect(vm.params.host).toBe('us-vm.example.com')
    expect(vm.params.transportSecurity).toBe('tls')
    const grpcVm = r.nodes.find((n) => n.name.includes('德国'))!
    expect(grpcVm.params.alterId).toBe(64)
    expect(grpcVm.params.network).toBe('grpc')
    expect(grpcVm.params.serviceName).toBe('grpcsvc')
  })

  test('vless 的 reality / flow / fingerprint', () => {
    const r = parseSubscription(read('clash-proxies.yaml'), 'clash', 's')
    const reality = r.nodes.find((n) => n.name.includes('Reality'))!
    expect(reality.params.transportSecurity).toBe('reality')
    expect(reality.params.flow).toBe('xtls-rprx-vision')
    expect(reality.params.publicKey).toHaveLength(43)
    expect(reality.params.shortId).toBe('0123456789abcdef')
    expect(reality.params.fingerprint).toBe('chrome')
    expect(reality.params.sni).toBe('www.microsoft.com')
  })

  test('含错误行的 Clash 只计数', () => {
    const r = parseSubscription(read('clash-with-errors.yaml'), 'clash', 's')
    expect(r.format).toBe('clash')
    expect(r.nodes.length).toBe(2)
    expect(r.errors.length).toBe(4)
    expect(r.errors.map((e) => e.errorKind).sort()).toEqual(['bad_port', 'bad_protocol', 'missing_field', 'missing_field'])
  })

  test('hint=clash 对非 YAML 报 bad_yaml', () => {
    const r = parseSubscription('{"outbounds":[]}', 'clash', 's')
    expect(r.nodes).toEqual([])
    expect(r.errors[0]?.errorKind).toBe('bad_yaml')
  })
})

describe('Xray / v2ray JSON', () => {
  test('outbounds 全协议 + freedom/blackhole 跳过', () => {
    const r = parseSubscription(read('xray-outbounds.json'), 'auto', 'sub-xray')
    expect(r.format).toBe('xray')
    expect(r.errors).toEqual([])
    const protos = new Set(r.nodes.map((n) => n.protocol))
    for (const p of ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks', 'http'] as Protocol[]) {
      expect(protos.has(p)).toBe(true)
    }
    // freedom / blackhole 不出现在节点里
    expect(r.nodes.length).toBe(12)
  })

  test('hint=xray 与自动识别一致', () => {
    const auto = parseSubscription(read('xray-outbounds.json'), 'auto', 's')
    const hinted = parseSubscription(read('xray-outbounds.json'), 'xray', 's')
    expect(hinted.format).toBe('xray')
    expect(hinted.nodes.map((n) => normalizeNode(n).fingerprint))
      .toEqual(auto.nodes.map((n) => normalizeNode(n).fingerprint))
  })

  test('ss 的 method / 2022 密码 / plugin 保留', () => {
    const r = parseSubscription(read('xray-outbounds.json'), 'xray', 's')
    const legacy = r.nodes.find((n) => n.server === 'hk-ss.example.com')!
    expect(legacy.params.method).toBe('aes-256-gcm')
    const ss2022 = r.nodes.find((n) => n.server === 'hk-ss2.example.com')!
    expect(ss2022.params.method).toBe('2022-blake3-aes-128-gcm')
    expect(ss2022.credential).toBe('QUFBQUFBQUFBQUFBQUFBQQ==')
    const plugin = r.nodes.find((n) => n.server === 'hk-ss3.example.com')!
    expect(plugin.params.plugin).toBe('obfs-local')
    expect(plugin.params.pluginOptsRaw).toBe('obfs=http;obfs-host=www.bing.com')
  })

  test('含坏条目的 Xray JSON', () => {
    const r = parseSubscription(read('xray-outbounds-with-errors.json'), 'auto', 's')
    expect(r.format).toBe('xray')
    expect(r.nodes.length).toBe(1)
    expect(r.errors.length).toBe(2)
    expect(r.errors.map((e) => e.errorKind).sort()).toEqual(['bad_json', 'bad_port'])
  })

  test('hint=xray 对非 Xray JSON 报错', () => {
    const r = parseSubscription('{"foo":1}', 'xray', 's')
    expect(r.nodes).toEqual([])
    expect(r.errors[0]?.errorKind).toBe('bad_json')
  })
})

describe('sing-box JSON', () => {
  test('type 而非 protocol 的 outbounds', () => {
    const r = parseSubscription(read('singbox-outbounds.json'), 'auto', 'sub-sb')
    expect(r.format).toBe('singbox')
    expect(r.errors).toEqual([])
    // 10 个代理 outbound；direct / block 被跳过
    expect(r.nodes.length).toBe(10)
    const protos = new Set(r.nodes.map((n) => n.protocol))
    for (const p of ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks', 'http'] as Protocol[]) {
      expect(protos.has(p)).toBe(true)
    }
  })

  test('transport / tls / reality 平铺字段被摊到 params', () => {
    const r = parseSubscription(read('singbox-outbounds.json'), 'singbox', 's')
    const reality = r.nodes.find((n) => n.server === 'de-vl.example.com')!
    expect(reality.params.network).toBe('tcp')
    expect(reality.params.transportSecurity).toBe('reality')
    expect(reality.params.publicKey).toHaveLength(43)
    expect(reality.params.shortId).toBe('0123456789abcdef')
    expect(reality.params.flow).toBe('xtls-rprx-vision')
    const grpc = r.nodes.find((n) => n.server === 'jp-vl.example.com')!
    expect(grpc.params.network).toBe('grpc')
    expect(grpc.params.serviceName).toBe('grpcsvc')
    const ws = r.nodes.find((n) => n.server === 'us-vm.example.com')!
    expect(ws.params.network).toBe('ws')
    expect(ws.params.path).toBe('/vm')
    expect(ws.params.alterId).toBe(0)
  })
})

describe('JSON 节点数组', () => {
  test('扁平节点数组', () => {
    const r = parseSubscription(read('json-node-array.json'), 'auto', 'sub-arr')
    expect(r.format).toBe('json_array')
    expect(r.nodes.length).toBe(4)
    expect(r.errors.length).toBe(1) // 端口非法的坏条目
    expect(new Set(r.nodes.map((n) => n.protocol))).toEqual(new Set(['ss', 'vmess', 'vless', 'trojan']))
    const reality = r.nodes.find((n) => n.protocol === 'vless')!
    expect(reality.params.publicKey).toHaveLength(43)
    expect(reality.params.flow).toBe('xtls-rprx-vision')
  })
})

describe('混合格式', () => {
  test('明文链接与 JSON 行混排时，链接照常入库、其余只计数', () => {
    const r = parseSubscription(read('mixed-links-and-json.txt'), 'auto', 'sub-mix')
    expect(r.format).toBe('links')
    expect(r.nodes.length).toBe(2)
    expect(r.errors.length).toBe(2)
    expect(new Set(r.nodes.map((n) => n.protocol))).toEqual(new Set(['ss', 'trojan']))
  })
})

/* ================================================================ 归一化 */

describe('归一化', () => {
  test('fingerprint = sha1(protocol|server|port|credential)', () => {
    const n = node({ protocol: 'vless', server: 'a.example.com', port: 443, credential: 'uuid-1' })
    const expected = new Bun.CryptoHasher('sha1').update('vless|a.example.com|443|uuid-1').digest('hex')
    expect(fingerprintOf(n)).toBe(expected)
    expect(normalizeNode(n).fingerprint).toBe(expected)
  })

  test('fingerprint 对参数不敏感、对身份敏感', () => {
    const a = normalizeNode(node({ params: { sni: 'x' } }))
    const b = normalizeNode(node({ params: { sni: 'y' } }))
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.paramsHash).not.toBe(b.paramsHash)
    const c = normalizeNode(node({ port: 8389 }))
    expect(c.fingerprint).not.toBe(a.fingerprint)
  })

  test('paramsHash 与键顺序无关', () => {
    expect(paramsHashOf({ a: 1, b: ['x', 'y'], c: { d: 1, e: 2 } }))
      .toBe(paramsHashOf({ c: { e: 2, d: 1 }, b: ['x', 'y'], a: 1 }))
    expect(paramsHashOf({ a: 1 })).not.toBe(paramsHashOf({ a: '1' }))
  })

  test('server 归一化：大小写与 IPv6 方括号', () => {
    expect(normalizeNode(node({ server: 'A.Example.COM' })).server).toBe('a.example.com')
    expect(normalizeNode(node({ server: '[2001:DB8::1]' })).server).toBe('2001:db8::1')
  })

  test('normalizeNodes 按 fingerprint 去重', () => {
    const out = normalizeNodes([node(), node({ name: '别名' }), node({ port: 9999 })])
    expect(out.length).toBe(2)
    expect(out[0].name).toBe('n')
  })

  test('D9 协议支持矩阵', () => {
    expect(PROTOCOL_SUPPORT_MATRIX.ssr).toBe(false)
    expect(PROTOCOL_SUPPORT_MATRIX.hysteria2).toBe(true)
    expect(PROTOCOL_SUPPORT_MATRIX.tuic).toBe(true)
    for (const p of ['ss', 'vmess', 'vless', 'trojan', 'socks', 'http'] as Protocol[]) {
      expect(PROTOCOL_SUPPORT_MATRIX[p]).toBe(true)
    }
    expect(normalizeNode(node({ protocol: 'ssr' })).protocolSupported).toBe(false)
    expect(normalizeNode(node({ protocol: 'hysteria2' })).protocolSupported).toBe(true)
  })
})

/* ================================================================== 命名 */

describe('地区识别', () => {
  test('中文关键字', () => {
    expect(regionKey('香港 01')).toBe('hk')
    expect(regionKey('日本东京 IPLC')).toBe('jp')
    expect(regionKey('美国洛杉矶')).toBe('us')
    expect(regionKey('新加坡')).toBe('sg')
    expect(regionKey('台湾 CHT')).toBe('tw')
    expect(regionKey('韩国首尔')).toBe('kr')
    expect(regionKey('德国法兰克福')).toBe('de')
    expect(regionKey('澳大利亚 悉尼')).toBe('au')
  })

  test('英文与机场缩写', () => {
    expect(regionKey('HK-02 专线')).toBe('hk')
    expect(regionKey('US Los Angeles 03')).toBe('us')
    expect(regionKey('United Kingdom London')).toBe('gb')
    expect(regionKey('Singapore 01')).toBe('sg')
    expect(regionKey('Hysteria2 美国 01')).toBe('us')
  })

  test('旗帜 emoji', () => {
    expect(regionKey('🇭🇰HK-01')).toBe('hk')
    expect(regionKey('🇯🇵 JP 01')).toBe('jp')
    expect(regionKey('🇺🇸 US')).toBe('us')
    expect(regionKey('🇸🇬')).toBe('sg')
  })

  test('识别不到的返回 undefined', () => {
    for (const n of ['', '   ', 'moon', 'sx01', 'vip-assets-01', 'unknown-node-x', '1x']) {
      expect(regionKey(n)).toBeUndefined()
    }
  })
})

describe('节点 ID 分配', () => {
  test('{region}{seq} 且序号至少两位', () => {
    expect(formatSeq(1)).toBe('01')
    expect(formatSeq(9)).toBe('09')
    expect(formatSeq(100)).toBe('100')
    expect(allocateNodeId('hk', new Set())).toBe('hk01')
    expect(allocateNodeId('hk', new Set(['hk01']))).toBe('hk02')
    expect(allocateNodeId(undefined, new Set())).toBe('n01')
  })

  test('existing 大小写无关', () => {
    expect(allocateNodeId('hk', new Set(['HK01']))).toBe('hk02')
    expect(allocateNodeId('HK', new Set(['hk01']))).toBe('hk02')
  })

  test('region 规范化', () => {
    expect(normalizeRegion('HK')).toBe('hk')
    expect(normalizeRegion(' u.s. ')).toBe('us')
    expect(normalizeRegion('')).toBe('n')
    expect(normalizeRegion(undefined)).toBe('n')
    expect(normalizeRegion('!!!')).toBe('n')
  })

  test('批量分配不互相冲突且保持顺序', () => {
    const ids = allocateNodeIds(['hk', 'hk', 'jp', undefined, 'hk'], new Set(['hk01']))
    expect(ids).toEqual(['hk02', 'hk03', 'jp01', 'n01', 'hk04'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('冲突追加序号（同序号被占满时）', () => {
    const existing = new Set<string>()
    const seq: string[] = []
    for (let i = 0; i < 5; i++) seq.push(allocateNodeId('us', new Set([...existing, ...seq])))
    expect(new Set(seq).size).toBe(5)
    expect(seq[0]).toBe('us01')
  })

  test('seqStart 生效', () => {
    expect(allocateNodeId('hk', new Set(), 7)).toBe('hk07')
  })
})

/* ============================================================ 纯函数性 */

describe('解析器是纯函数', () => {
  test('同一输入多次调用结果一致，且不修改入参', () => {
    const body = read('links-all-protocols.txt')
    const first = parseSubscription(body, 'auto', 'sub-x')
    const second = parseSubscription(body, 'auto', 'sub-x')
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(body).toBe(read('links-all-protocols.txt'))
  })

  test('hint 覆盖全部取值', () => {
    const hints: SubFormatHint[] = ['auto', 'base64', 'clash', 'singbox', 'xray', 'links']
    for (const h of hints) {
      expect(() => parseSubscription('garbage', h, 's')).not.toThrow()
    }
  })
})

describe('parseLinkLines', () => {
  test('坏行进入 errors 且带行号', () => {
    const body = ['ss://YWVzLTI1Ni1nY206cGFzc3dvcmQxMjM@h.example.com:8388#ok', '', 'junk', '#comment'].join('\n')
    const r = parseLinkLines(body, { sourceSubscriptionId: 's' })
    expect(r.nodes.length).toBe(1)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0].lineNo).toBe(3)
  })
})