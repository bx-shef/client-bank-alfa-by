import { describe, expect, it } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { PRIOR_ASSERTION_TYP, PRIOR_REQUEST_OBJECT_TYP, base64UrlEncode, buildPriorJwtHeader, isPriorRequestTypInvalid, priorRequestTypFromEnv, signPriorJwt } from '../server/utils/priorJwt'

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

// ─────────────────────────────────────────────────────────────────────────────
// #449: two JWTs signed by ONE key must be tellable apart.
//
// The authorize `request` leaves IN A URL — and we hand that URL to the admin so they can forward
// it to the account owner («Ссылка для владельца счёта» + a copy button in `BankConnectCard.vue`),
// so every connect routinely walks the link through a messenger or an inbox. The
// `client_assertion` leaves in a POST body and proves WHO WE ARE at `/oauth2/token`.
//
// Their claim-sets differ only by the authorize side having MORE: `iss`/`sub`/`aud`/`iat`/`exp`/
// `jti` are the same, and so are the key and the `kid`. A forwarded link is therefore a
// syntactically valid `client_assertion` until something tells the two apart.
// ─────────────────────────────────────────────────────────────────────────────
describe('#449: the authorize JWT and the client assertion are distinguishable by typ', () => {
  const decodeHeader = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>

  it('defaults to the previous typ — a working production connect is unchanged', () => {
    expect(priorRequestTypFromEnv({} as NodeJS.ProcessEnv)).toBe(PRIOR_ASSERTION_TYP)
    expect(decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1')).typ).toBe('JWT')
  })

  it('the env splits the headers — the very effect this exists for', () => {
    const typ = priorRequestTypFromEnv({ PRIOR_OAUTH_REQUEST_TYP: PRIOR_REQUEST_OBJECT_TYP } as NodeJS.ProcessEnv)
    const authorize = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1', typ))
    const assertion = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1'))
    expect(authorize.typ).toBe('oauth-authz-req+jwt')
    expect(assertion.typ).toBe('JWT')
    expect(authorize.typ).not.toBe(assertion.typ)
    // ⚠ The key and the kid stay THE SAME — only `typ` separates them, and the signature stays valid.
    expect(authorize.kid).toBe(assertion.kid)
    expect(authorize.alg).toBe('RS256')
  })

  it('with no env set BOTH sides carry the same typ — proving the split is opt-in', () => {
    const typ = priorRequestTypFromEnv({} as NodeJS.ProcessEnv)
    expect(decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1', typ)).typ)
      .toBe(decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1')).typ)
  })

  it('the signature still covers the header when typ is non-default', () => {
    // ⚠ The gap this closes: a mutation where the signed BYTES used the default header while the
    // emitted JWS carried the configured one left the whole suite green — i.e. we would have shipped
    // a cryptographically invalid JWS to the bank the moment the env was switched on. Decoding the
    // header cannot see that; only re-verifying the signature can.
    const jwt = signPriorJwt({ a: 1 }, privatePem, 'k1', PRIOR_REQUEST_OBJECT_TYP)
    const [h, p, sig] = jwt.split('.')
    expect(decodeHeader(jwt).typ).toBe(PRIOR_REQUEST_OBJECT_TYP)
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(ok).toBe(true)
  })

  it('a malformed value does NOT break the connect — it falls back to the default', () => {
    // ⚠ Deliberately not fail-closed: this is optional hardening, and refusing to connect at all
    // over a typo in it is the worse trade. The typo is surfaced by `envCheck` at boot instead.
    for (const bad of ['', '   ', 'has space', 'кириллица', '"quoted"', 'a\nb', '+leading', '/jwt', 'a//b']) {
      expect(priorRequestTypFromEnv({ PRIOR_OAUTH_REQUEST_TYP: bad } as NodeJS.ProcessEnv)).toBe(PRIOR_ASSERTION_TYP)
    }
  })

  it('accepts the full media-type form too — it is legitimate, not a typo', () => {
    // RFC 7519 §5.1 only RECOMMENDS dropping `application/`; rejecting it would make `envCheck`
    // announce «не похож на media-type» about a value that is one.
    for (const good of ['application/jwt', 'application/oauth-authz-req+jwt', 'at+jwt']) {
      expect(priorRequestTypFromEnv({ PRIOR_OAUTH_REQUEST_TYP: good } as NodeJS.ProcessEnv)).toBe(good)
    }
  })

  it('a malformed value is detectable on its own — otherwise nobody learns of it', () => {
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: 'has space' } as NodeJS.ProcessEnv)).toBe(true)
    // Empty/absent is NOT a typo — it is the ordinary «never configured».
    expect(isPriorRequestTypInvalid({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: '  ' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: PRIOR_REQUEST_OBJECT_TYP } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('typ cannot corrupt the header JSON', () => {
    // The mask already rejects quotes, but the signature covers the header BYTES — a value that
    // broke the JSON would reach the bank as garbage under a valid signature.
    const h = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1', 'application/x-y+jwt'))
    expect(h.typ).toBe('application/x-y+jwt')
    expect(h.alg).toBe('RS256')
  })
})
