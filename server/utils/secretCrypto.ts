// AES-256-GCM encryption for secrets at rest (the portal refresh_token). The
// key comes from env `B24_TOKEN_ENC_KEY` (32 bytes, hex or base64) — never
// committed. Format of the stored blob: `iv:authTag:ciphertext`, all base64.
// Used by the token store so refresh tokens are not persisted in plaintext
// (legacy stored them as plain files — see docs/B24_EVENTS.md).
//
// KEY ROTATION. Decryption accepts a SECOND, previous key — `B24_TOKEN_ENC_KEY_OLD`. Without it
// rotation was physically impossible: swapping `B24_TOKEN_ENC_KEY` instantly makes EVERY stored
// refresh token unreadable, i.e. every portal must reinstall the app and the owner must reconnect
// the banks. The failure is silent, too — `envCheck` only validates the length, so the swap looks
// like a successful deploy and surfaces on the first refresh. Encryption always uses the CURRENT
// key, so rows re-encrypt themselves as tokens refresh. Procedure and timing (the window is ~180
// days, not a month) — docs/OPERATIONS.md «Ротация секретов».

import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('enc-key')

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

/** Once per process, so a broken previous key doesn't warn on every single row. */
let warnedBadOldKey = false

/**
 * Keys to try when DECRYPTING, in order: the current one, then the previous
 * (`B24_TOKEN_ENC_KEY_OLD`) when set. An empty or identical previous key is dropped — retrying
 * with the same key is pointless.
 *
 * ⚠ A malformed previous key does NOT break decryption: it is skipped with a warning. Fail-closed
 * here would be strictly worse — a typo in an OPTIONAL variable would make even the rows encrypted
 * with the CURRENT key unreadable, taking down portal and bank authorization entirely. The loud
 * part is `envCheck` (an error in the boot log).
 */
export function loadDecryptKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const primary = loadEncKey(env)
  const old = env.B24_TOKEN_ENC_KEY_OLD?.trim()
  if (!old) return [primary]
  let previous: Buffer
  try {
    previous = decodeKey(old, 'B24_TOKEN_ENC_KEY_OLD')
  } catch (e) {
    if (!warnedBadOldKey) {
      warnedBadOldKey = true
      log.warning(`B24_TOKEN_ENC_KEY_OLD ignored — ${(e as Error)?.message}. Rows encrypted with the previous key will not decrypt; the current key still works.`)
    }
    return [primary]
  }
  return previous.equals(primary) ? [primary] : [primary, previous]
}

/** Parsed-key cache: `decryptSecret` runs per token row, and re-reading env + hex-decoding on every
 *  call is pointless. Keyed by the raw env values, so changing a variable (process restart or a
 *  test stub) invalidates it. */
let keyCache: { envKey: string, envOld: string, keys: Buffer[] } | null = null

function cachedDecryptKeys(env: NodeJS.ProcessEnv): Buffer[] {
  const envKey = env.B24_TOKEN_ENC_KEY ?? ''
  const envOld = env.B24_TOKEN_ENC_KEY_OLD ?? ''
  if (keyCache && keyCache.envKey === envKey && keyCache.envOld === envOld) return keyCache.keys
  const keys = loadDecryptKeys(env)
  keyCache = { envKey, envOld, keys }
  return keys
}

/** Logged once per process: a row still sitting on the previous key means the rotation window must
 *  stay open. Silence over a full day is the owner's signal that `B24_TOKEN_ENC_KEY_OLD` can go.
 *  No blob, no member id — this is a state signal, not an audit record. */
let warnedPreviousKeyHit = false
function notePreviousKeyHit(): void {
  if (warnedPreviousKeyHit) return
  warnedPreviousKeyHit = true
  log.warning('decrypted with the PREVIOUS key — rotation still in progress, keep B24_TOKEN_ENC_KEY_OLD')
}

/** Encrypt a UTF-8 secret. Returns `iv:tag:ciphertext` (base64 parts). A fresh
 * random IV per call means the same plaintext never yields the same blob.
 * Always encrypts with the CURRENT key — that is what moves rows off the previous one. */
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
 * Without an explicit `key` it tries the current and previous keys in turn (see `loadDecryptKeys`).
 * Trying keys is safe: GCM verifies the auth tag, so a wrong key raises instead of returning
 * plausible garbage.
 *
 * A hit on the PREVIOUS key is logged once per process: that log line is how the owner knows the
 * rotation is not finished yet (docs/OPERATIONS.md tells them to wait for it to stop appearing).
 */
export function decryptSecret(blob: string, key?: Buffer): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('decryptSecret: malformed blob')
  const [ivB64, tagB64, dataB64] = parts as [string, string, string]
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')

  const keys = key ? [key] : cachedDecryptKeys(process.env)
  for (const [i, candidate] of keys.entries()) {
    try {
      const decipher = createDecipheriv(ALGO, candidate, iv)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      if (i > 0) notePreviousKeyHit()
      return plain
    } catch {
      continue
    }
  }
  // NOT the last attempt's error: that would be the PREVIOUS key's «unable to authenticate data»,
  // which hides the fact that several keys were tried at all.
  throw new Error(
    keys.length > 1
      ? `decryptSecret: none of the ${keys.length} keys matched (B24_TOKEN_ENC_KEY / _OLD)`
      : 'decryptSecret: wrong key or corrupted data'
  )
}
