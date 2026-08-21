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
// #449: два JWT, подписанные ОДНИМ ключом, должны быть различимы.
//
// Authorize-`request` уезжает В URL — и мы сами вручаем этот URL админу, чтобы он переслал его
// владельцу счёта («Ссылка для владельца счёта» + кнопка «Скопировать» в `BankConnectCard.vue`),
// то есть при каждом подключении ссылка штатно проходит через мессенджер или почту.
// `client_assertion` уезжает в теле POST и доказывает, КТО МЫ, на `/oauth2/token`.
//
// Их claim-наборы различаются только тем, что у authorize их БОЛЬШЕ: `iss`/`sub`/`aud`/`iat`/`exp`/
// `jti` совпадают, ключ и `kid` те же. Значит пересланная ссылка — синтаксически валидный
// `client_assertion`, пока их что-нибудь не разводит.
// ─────────────────────────────────────────────────────────────────────────────
describe('#449: authorize-JWT и client_assertion различимы по typ', () => {
  const decodeHeader = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>

  it('по умолчанию typ прежний — работающий прод не меняется', () => {
    expect(priorRequestTypFromEnv({} as NodeJS.ProcessEnv)).toBe(PRIOR_ASSERTION_TYP)
    expect(decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1')).typ).toBe('JWT')
  })

  it('env разводит заголовки — тот самый эффект, ради которого всё это', () => {
    const typ = priorRequestTypFromEnv({ PRIOR_OAUTH_REQUEST_TYP: PRIOR_REQUEST_OBJECT_TYP } as NodeJS.ProcessEnv)
    const authorize = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1', typ))
    const assertion = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1'))
    expect(authorize.typ).toBe('oauth-authz-req+jwt')
    expect(assertion.typ).toBe('JWT')
    expect(authorize.typ).not.toBe(assertion.typ)
    // ⚠ Ключ и kid при этом ОДНИ И ТЕ ЖЕ — развод идёт только по typ, и подпись остаётся валидной.
    expect(authorize.kid).toBe(assertion.kid)
    expect(authorize.alg).toBe('RS256')
  })

  it('битое значение НЕ ломает подключение, а откатывается к умолчанию', () => {
    // ⚠ Именно так, а не fail-closed: это опциональное усиление, и отказать в подключении из-за
    // опечатки в нём — худший размен, чем подключиться без него. Опечатку показывает envCheck.
    for (const bad of ['', '   ', 'has space', 'кириллица', '"quoted"', 'a\nb', '+leading']) {
      expect(priorRequestTypFromEnv({ PRIOR_OAUTH_REQUEST_TYP: bad } as NodeJS.ProcessEnv)).toBe(PRIOR_ASSERTION_TYP)
    }
  })

  it('битое значение опознаётся отдельно — иначе о нём никто не узнает', () => {
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: 'has space' } as NodeJS.ProcessEnv)).toBe(true)
    // Пустое/отсутствующее — это НЕ опечатка, а штатное «не настраивали».
    expect(isPriorRequestTypInvalid({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: '  ' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isPriorRequestTypInvalid({ PRIOR_OAUTH_REQUEST_TYP: PRIOR_REQUEST_OBJECT_TYP } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('typ не может испортить JSON заголовка', () => {
    // Маска и так не пропускает кавычки, но подпись покрывает БАЙТЫ заголовка — если бы значение
    // ломало JSON, банк получил бы мусор с валидной подписью.
    const h = decodeHeader(signPriorJwt({ a: 1 }, privatePem, 'k1', 'application/x-y+jwt'))
    expect(h.typ).toBe('application/x-y+jwt')
    expect(h.alg).toBe('RS256')
  })
})
