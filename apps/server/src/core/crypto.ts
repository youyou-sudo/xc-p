import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from '../config'

/**
 * keyfile：DATA_DIR/keyfile，32 字节主密钥（base64）。
 * 用于 node_credentials.password_enc 的 AES-256-GCM 加解密（PANEL.md D4 / R6）。
 */
let keyCache: Buffer | null = null

export function masterKey(): Buffer {
  if (keyCache) return keyCache
  if (existsSync(paths.keyfile)) {
    const raw = readFileSync(paths.keyfile, 'utf8').trim()
    const buf = Buffer.from(raw, 'base64')
    if (buf.length === 32) {
      keyCache = buf
      return buf
    }
    // 旧格式兜底：sha256 派生
    keyCache = createHash('sha256').update(raw).digest()
    return keyCache
  }
  mkdirSync(dirname(paths.keyfile), { recursive: true })
  const buf = randomBytes(32)
  writeFileSync(paths.keyfile, buf.toString('base64') + '\n', { mode: 0o600 })
  try {
    chmodSync(paths.keyfile, 0o600)
  } catch {
    /* Windows 上可能不支持，忽略 */
  }
  keyCache = buf
  return buf
}

export function deriveKey(purpose: string): Buffer {
  return createHash('sha256').update(masterKey()).update('|').update(purpose).digest()
}

/** AES-256-GCM：返回 base64(iv|tag|ciphertext) */
export function encryptSecret(plain: string, purpose = 'node-credential'): string {
  const key = deriveKey(purpose)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptSecret(blob: string, purpose = 'node-credential'): string {
  const key = deriveKey(purpose)
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

/** 恒定时间比较（长度不同也返回 false，不泄露长度信息） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function dynamicPepper(): string {
  return deriveKey('pepper').toString('hex')
}

/** 节点密码：sp_<32 位 base62>（PANEL.md D4） */
export function generateNodePassword(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const bytes = randomBytes(32)
  let out = ''
  for (let i = 0; i < 32; i++) out += alphabet[bytes[i]! % alphabet.length]
  return 'sp_' + out
}

/** 密码索引哈希：sha256(pepper|password) */
export function passwordLookupHash(password: string): string {
  return sha256Hex(dynamicPepper() + '|' + password)
}

export async function hashAdminPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
}

export async function verifyAdminPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash)
  } catch {
    return false
  }
}

/** API Key：xcp_<prefix>_<secret> */
export function generateApiKey(): { plaintext: string; prefix: string; keyHash: string } {
  const prefix = randomBytes(4).toString('hex')
  // 注意：secret 使用 hex 字母表，避免 base64url 里的 '_' 破坏 xcp_<prefix>_<secret> 的分段
  const secret = randomBytes(24).toString('hex')
  const plaintext = `xcp_${prefix}_${secret}`
  return { plaintext, prefix, keyHash: sha256Hex(secret + dynamicPepper()) }
}

/** 用「第一个/第二个下划线」切分，即使 secret 里含下划线也不会解析错 */
export function hashApiKeySecret(plaintext: string): { prefix: string; keyHash: string } | null {
  const first = plaintext.indexOf('_')
  if (first !== 3 || !plaintext.startsWith('xcp_')) return null
  const second = plaintext.indexOf('_', first + 1)
  if (second < 0) return null
  const prefix = plaintext.slice(first + 1, second)
  const secret = plaintext.slice(second + 1)
  if (!prefix || !secret) return null
  return { prefix, keyHash: sha256Hex(secret + dynamicPepper()) }
}
