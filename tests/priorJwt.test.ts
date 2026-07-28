import { describe, expect, it } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { base64UrlEncode, buildPriorJwtHeader, signPriorJwt } from '../server/utils/priorJwt'

// A throwaway RSA keypair for the test — proves the emitted JWS verifies against the public half,
// exactly what the bank does with the `jwks`-registered public key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

describe('base64UrlEncode', () => {
  it('is URL-safe: no +, /, or = padding', () => {
    // 0xFB 0xFF encodes to "+/" in standard base64 → must become "-_" and lose padding.
    const enc = base64UrlEncode(Buffer.from([0xfb, 0xff]))
    expect(enc).not.toMatch(/[+/=]/)
    expect(enc).toBe('-_8')
  })
  it('encodes a string as UTF-8', () => {
    expect(base64UrlEncode('{}')).toBe('e30')
  })
})

describe('buildPriorJwtHeader', () => {
  it('is a fixed RS256/JWT header carrying the kid', () => {
    expect(buildPriorJwtHeader('k1')).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
  })
})

describe('signPriorJwt', () => {
  it('emits a 3-part JWS whose header/payload decode back and whose signature verifies', () => {
    const payload = { client_id: 'app-1', openbanking_intent_id: 'INT-9', iat: 1000, exp: 1600, jti: 'j1' }
    const jwt = signPriorJwt(payload, privatePem, 'prior-key-1')
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    expect(decodeSegment(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'prior-key-1' })
    expect(decodeSegment(parts[1]!)).toEqual(payload)

    // The signature covers exactly `header.payload` and verifies against the public key.
    const ok = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(publicKey, Buffer.from(parts[2]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    expect(ok).toBe(true)
  })

  it('a tampered payload fails verification (signature binds the exact bytes)', () => {
    const jwt = signPriorJwt({ a: 1 }, privatePem, 'k')
    const [h, , s] = jwt.split('.')
    const forged = base64UrlEncode(JSON.stringify({ a: 2 }))
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${forged}`)
      .verify(publicKey, Buffer.from(s!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    expect(ok).toBe(false)
  })

  it('throws without a private key or kid (never emits an unsigned/invalid token)', () => {
    expect(() => signPriorJwt({}, '', 'k')).toThrow(/private key/)
    expect(() => signPriorJwt({}, privatePem, '')).toThrow(/kid/)
  })
})
