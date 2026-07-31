import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, loadEncKey, loadDecryptKeys } from '../server/utils/secretCrypto'

const KEY = Buffer.alloc(32, 7) // deterministic 32-byte test key

describe('secretCrypto', () => {
  it('round-trips a secret', () => {
    const blob = encryptSecret('refresh-token-value', KEY)
    expect(decryptSecret(blob, KEY)).toBe('refresh-token-value')
  })

  it('produces a different blob each time (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY))
  })

  it('round-trips an empty string', () => {
    expect(decryptSecret(encryptSecret('', KEY), KEY)).toBe('')
  })

  it('throws on a tampered blob (bad auth tag)', () => {
    const [iv, tag, data] = encryptSecret('secret', KEY).split(':')
    const tampered = `${iv}:${tag}:${Buffer.from('evil').toString('base64')}`
    expect(() => decryptSecret(tampered, KEY)).toThrow()
    void data
  })

  it('throws on a malformed blob', () => {
    expect(() => decryptSecret('not-a-blob', KEY)).toThrow(/malformed/)
  })

  it('throws on a wrong key', () => {
    const blob = encryptSecret('secret', KEY)
    expect(() => decryptSecret(blob, Buffer.alloc(32, 9))).toThrow()
  })
})

describe('loadEncKey', () => {
  it('accepts a 64-char hex key', () => {
    expect(loadEncKey({ B24_TOKEN_ENC_KEY: 'aa'.repeat(32) } as NodeJS.ProcessEnv).length).toBe(32)
  })
  it('accepts a base64 32-byte key', () => {
    expect(loadEncKey({ B24_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64') } as NodeJS.ProcessEnv).length).toBe(32)
  })
  it('throws when unset', () => {
    expect(() => loadEncKey({} as NodeJS.ProcessEnv)).toThrow(/not set/)
  })
  it('throws on a wrong-length key', () => {
    expect(() => loadEncKey({ B24_TOKEN_ENC_KEY: 'abcd' } as NodeJS.ProcessEnv)).toThrow(/32 bytes/)
  })
})

describe('ротация ключа (B24_TOKEN_ENC_KEY_OLD)', () => {
  const NEW = Buffer.alloc(32, 7)
  const OLD = Buffer.alloc(32, 3)
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

  it('расшифровывает строку, зашифрованную ПРЕЖНИМ ключом', () => {
    // Без этого смена ключа делала бы нечитаемыми все сохранённые refresh-токены разом —
    // то есть каждый портал переустанавливает приложение, а банки подключаются заново.
    const blob = encryptSecret('refresh-token', OLD)
    const keys = loadDecryptKeys(env({
      B24_TOKEN_ENC_KEY: NEW.toString('hex'),
      B24_TOKEN_ENC_KEY_OLD: OLD.toString('hex')
    }))
    expect(keys).toHaveLength(2)
    // Порядок важен: сначала текущий (им зашифровано большинство строк), потом прежний.
    expect(keys[0]!.equals(NEW)).toBe(true)
    let decoded: string | undefined
    for (const k of keys) {
      try {
        decoded = decryptSecret(blob, k)
        break
      } catch {
        continue
      }
    }
    expect(decoded).toBe('refresh-token')
  })

  it('без прежнего ключа — только текущий', () => {
    expect(loadDecryptKeys(env({ B24_TOKEN_ENC_KEY: NEW.toString('hex') }))).toHaveLength(1)
  })

  it('совпадающий прежний ключ не дублируется — вторая попытка тем же ключом бессмысленна', () => {
    expect(loadDecryptKeys(env({
      B24_TOKEN_ENC_KEY: NEW.toString('hex'),
      B24_TOKEN_ENC_KEY_OLD: NEW.toString('hex')
    }))).toHaveLength(1)
  })

  it('битый прежний ключ падает громко, а не глотается', () => {
    expect(() => loadDecryptKeys(env({
      B24_TOKEN_ENC_KEY: NEW.toString('hex'),
      B24_TOKEN_ENC_KEY_OLD: 'короткий'
    }))).toThrow(/B24_TOKEN_ENC_KEY_OLD/)
  })

  it('неверный ключ НЕ даёт мусорного текста — GCM проверяет тег', () => {
    const blob = encryptSecret('secret', OLD)
    expect(() => decryptSecret(blob, NEW)).toThrow()
  })
})
