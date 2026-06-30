import { Buffer } from 'node:buffer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'
import {
  deleteToken,
  getApplicationToken,
  getToken,
  saveToken
} from '../server/utils/tokenStore'
import type { PortalToken } from '../server/utils/tokenStore'

// tokenStore encrypts/decrypts via the default env key — set a deterministic one.
beforeAll(() => {
  process.env.B24_TOKEN_ENC_KEY = 'bb'.repeat(32)
})

const token: PortalToken = {
  memberId: 'm1',
  domain: 'p.bitrix24.ru',
  accessToken: 'ACCESS',
  refreshToken: 'REFRESH',
  expiresAt: 1_700_000_000_000,
  applicationToken: 'APPTOK'
}

describe('saveToken', () => {
  it('encrypts the refresh token before storage (never plaintext)', async () => {
    const calls: { sql: string, params?: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    await saveToken(query, token)
    const params = calls[0]!.params!
    expect(params[0]).toBe('m1')
    const enc = params[3] as string
    expect(enc).not.toBe('REFRESH')
    expect(decryptSecret(enc)).toBe('REFRESH')
  })

  it('uses a write-once COALESCE/NULLIF upsert for application_token', async () => {
    const query = vi.fn(async () => [])
    await saveToken(query, token)
    expect(query.mock.calls[0]![0]).toMatch(/COALESCE\(NULLIF\(portal_tokens\.application_token, ''\), EXCLUDED\.application_token\)/)
  })
})

describe('getToken', () => {
  it('decrypts the refresh token from the stored row', async () => {
    const query = vi.fn(async () => [{
      member_id: 'm1',
      domain: 'p.bitrix24.ru',
      access_token: 'ACCESS',
      refresh_token_enc: encryptSecret('REFRESH'),
      expires_at: '1700000000000',
      application_token: 'APPTOK'
    }])
    const got = await getToken(query, 'm1')
    expect(got).toEqual(token)
  })

  it('returns null for an unknown portal', async () => {
    expect(await getToken(vi.fn(async () => []), 'nope')).toBeNull()
  })

  it('throws when the refresh blob cannot be decrypted', async () => {
    const query = vi.fn(async () => [{
      member_id: 'm1', domain: 'd', access_token: 'a', refresh_token_enc: 'garbage', expires_at: '1', application_token: 't'
    }])
    await expect(getToken(query, 'm1')).rejects.toThrow(/failed to decrypt/)
  })
})

describe('getApplicationToken', () => {
  it('returns the stored token', async () => {
    const query = vi.fn(async () => [{ application_token: 'APPTOK' }])
    expect(await getApplicationToken(query, 'm1')).toBe('APPTOK')
  })
  it('returns empty string for an unknown portal', async () => {
    expect(await getApplicationToken(vi.fn(async () => []), 'm1')).toBe('')
  })
})

describe('deleteToken', () => {
  it('issues a DELETE by member_id', async () => {
    const query = vi.fn(async () => [])
    await deleteToken(query, 'm1')
    expect(query.mock.calls[0]![0]).toMatch(/DELETE FROM portal_tokens WHERE member_id = \$1/)
    expect(query.mock.calls[0]![1]).toEqual(['m1'])
  })
})

// Sanity: the env key really decodes to 32 bytes for these tests.
it('test env key is 32 bytes', () => {
  expect(Buffer.from(process.env.B24_TOKEN_ENC_KEY!, 'hex').length).toBe(32)
})
