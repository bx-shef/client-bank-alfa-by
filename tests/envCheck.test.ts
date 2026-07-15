import { describe, expect, it } from 'vitest'
import { checkBackendEnv } from '../server/utils/envCheck'

// A base env where everything is valid — each test perturbs one field.
const GOOD: NodeJS.ProcessEnv = {
  B24_TOKEN_ENC_KEY: 'a'.repeat(64), // 64 hex chars → 32 bytes
  DATABASE_URL: 'postgres://app:pw@db:5432/app',
  REDIS_URL: 'redis://redis:6379',
  B24_CLIENT_ID: 'local.abc',
  B24_CLIENT_SECRET: 'shh',
  B24_APPLICATION_TOKEN: ''
}

describe('checkBackendEnv', () => {
  it('reports no errors/warnings on a valid env', () => {
    const r = checkBackendEnv(GOOD)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('errors when B24_TOKEN_ENC_KEY is missing', () => {
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: '' })
    expect(r.errors.some(e => e.includes('B24_TOKEN_ENC_KEY'))).toBe(true)
  })

  it('errors when B24_TOKEN_ENC_KEY decodes to the wrong length (the 31-byte trap)', () => {
    // 62 hex chars → not the /^[0-9a-fA-F]{64}$/ form → parsed as base64 → 46 bytes ≠ 32.
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: 'a'.repeat(62) })
    expect(r.errors.some(e => e.includes('32 байта'))).toBe(true)
  })

  it('accepts a base64 key that decodes to 32 bytes', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64')
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: b64 })
    expect(r.errors).toEqual([])
  })

  it('errors on a placeholder B24_APPLICATION_TOKEN (case-insensitive)', () => {
    for (const v of ['CHANGE_ME', 'changeme', 'xxx', 'placeholder']) {
      const r = checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: v })
      expect(r.errors.some(e => e.includes('B24_APPLICATION_TOKEN'))).toBe(true)
    }
  })

  it('accepts an empty B24_APPLICATION_TOKEN (multi-tenant bootstrap) and a real-looking value', () => {
    expect(checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: '' }).errors).toEqual([])
    expect(checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: '51856fefc120afa4b628cc82d3935cce' }).errors).toEqual([])
  })

  it('errors when DATABASE_URL is missing', () => {
    const r = checkBackendEnv({ ...GOOD, DATABASE_URL: '' })
    expect(r.errors.some(e => e.includes('DATABASE_URL'))).toBe(true)
  })

  it('warns (not errors) when OAuth client creds are missing', () => {
    const r = checkBackendEnv({ ...GOOD, B24_CLIENT_ID: '', B24_CLIENT_SECRET: '' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => w.includes('B24_CLIENT_ID'))).toBe(true)
  })

  it('warns (not errors) when REDIS_URL is missing — queue off, sync fallback', () => {
    const r = checkBackendEnv({ ...GOOD, REDIS_URL: '' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => w.includes('REDIS_URL'))).toBe(true)
  })

  it('#242 P1: errors when prod has an operator password but no SESSION_SECRET (fail-closed lockout)', () => {
    const r = checkBackendEnv({ ...GOOD, NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
    expect(r.errors.some(e => e.includes('SESSION_SECRET'))).toBe(true)
  })

  it('#242 P1: no SESSION_SECRET error when the key is set, or outside production, or no operator password', () => {
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw', SESSION_SECRET: 'K' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'development', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'production' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
  })
})
