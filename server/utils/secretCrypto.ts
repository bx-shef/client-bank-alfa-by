// AES-256-GCM encryption for secrets at rest (the portal refresh_token). The
// key comes from env `B24_TOKEN_ENC_KEY` (32 bytes, hex or base64) — never
// committed. Format of the stored blob: `iv:authTag:ciphertext`, all base64.
// Used by the token store so refresh tokens are not persisted in plaintext
// (legacy stored them as plain files — see docs/B24_EVENTS.md).
//
// РОТАЦИЯ КЛЮЧА. Расшифровка принимает ВТОРОЙ, предыдущий ключ — `B24_TOKEN_ENC_KEY_OLD`.
// Без него ротация была невозможна физически: смена `B24_TOKEN_ENC_KEY` мгновенно делает
// нечитаемыми ВСЕ сохранённые refresh-токены, то есть каждый портал должен переустановить
// приложение, а владелец — заново подключить банки. При этом сбой тихий: `envCheck` проверяет
// только длину ключа, поэтому подмена выглядит успешным деплоем, а обнаруживается на первом
// рефреше. Шифруем всегда ОСНОВНЫМ ключом, поэтому строки перешифровываются сами по мере
// обновления токенов. Процедура и сроки — docs/OPERATIONS.md «Ротация секретов».

import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard nonce length
const KEY_BYTES = 32 // AES-256

/** Decode a 32-byte key from hex (64 chars) or base64. Throws on the wrong length. */
function decodeKey(raw: string, varName: string): Buffer {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== KEY_BYTES) {
    throw new Error(`${varName} must decode to ${KEY_BYTES} bytes, got ${buf.length}`)
  }
  return buf
}

/** Decode the env key (hex 64 chars or base64) into exactly 32 bytes. Throws if
 * unset or the wrong length — fail fast at first use rather than store plaintext. */
export function loadEncKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.B24_TOKEN_ENC_KEY?.trim()
  if (!raw) throw new Error('B24_TOKEN_ENC_KEY is not set (need a 32-byte hex/base64 key)')
  return decodeKey(raw, 'B24_TOKEN_ENC_KEY')
}

/**
 * Ключи для РАСШИФРОВКИ, в порядке попыток: сначала текущий, затем предыдущий
 * (`B24_TOKEN_ENC_KEY_OLD`), если он задан. Пустой/совпадающий со свежим старый ключ
 * игнорируется — вторая попытка тем же ключом бессмысленна.
 */
export function loadDecryptKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const primary = loadEncKey(env)
  const old = env.B24_TOKEN_ENC_KEY_OLD?.trim()
  if (!old) return [primary]
  const previous = decodeKey(old, 'B24_TOKEN_ENC_KEY_OLD')
  return previous.equals(primary) ? [primary] : [primary, previous]
}

/** Encrypt a UTF-8 secret. Returns `iv:tag:ciphertext` (base64 parts). A fresh
 * random IV per call means the same plaintext never yields the same blob.
 * Шифруем ВСЕГДА текущим ключом — так строки постепенно уезжают со старого. */
export function encryptSecret(plaintext: string, key: Buffer = loadEncKey()): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

/**
 * Decrypt a blob produced by `encryptSecret`. Throws on a malformed blob or a
 * failed auth tag (tampering / wrong key) — never returns garbage plaintext.
 *
 * Без явного `key` пробует по очереди текущий и предыдущий ключи (см. `loadDecryptKeys`).
 * Подбор безопасен: GCM проверяет тег аутентификации, поэтому неверный ключ даёт ошибку,
 * а не «расшифрованный» мусор.
 */
export function decryptSecret(blob: string, key?: Buffer): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('decryptSecret: malformed blob')
  const [ivB64, tagB64, dataB64] = parts as [string, string, string]
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')

  const keys = key ? [key] : loadDecryptKeys()
  let lastError: unknown
  for (const candidate of keys) {
    try {
      const decipher = createDecipheriv(ALGO, candidate, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('decryptSecret: unable to decrypt')
}
