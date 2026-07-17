import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptSecret } from '../server/utils/secretCrypto'
import {
  deleteBankTokensForPortal,
  getBankToken,
  listBankTokensForPortal,
  saveBankToken
} from '../server/utils/bankTokenStore'
import type { BankToken } from '../server/utils/bankTokenStore'

// The store encrypts/decrypts via the default env key — set a deterministic one.
beforeAll(() => {
  process.env.B24_TOKEN_ENC_KEY = 'cc'.repeat(32)
})

const token: BankToken = {
  memberId: 'm1',
  provider: 'alfa-by',
  accountKey: 'MC_7',
  accessToken: 'ACCESS',
  refreshToken: 'REFRESH',
  expiresAt: 1_700_000_000_000
}

/** Fake query fn that records every call and returns `rows` for SELECT/RETURNING. */
function fakeQuery(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string, params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return /^SELECT|RETURNING/im.test(sql) ? rows : []
  })
  return { query, calls }
}

/** A stored DB row (refresh encrypted, as the DB holds it). Built by round-tripping
 *  saveBankToken so the encryption matches what getBankToken will decrypt. */
async function storedRow(t: BankToken = token): Promise<Record<string, unknown>> {
  const { query, calls } = fakeQuery()
  await saveBankToken(query, t)
  const insert = calls[0]!
  const p = insert.params as unknown[]
  return {
    member_id: p[0], provider: p[1], account_key: p[2],
    access_token: p[3], refresh_token_enc: p[4], expires_at: p[5]
  }
}

describe('saveBankToken', () => {
  it('upserts by (member_id, provider, account_key) and encrypts the refresh token', async () => {
    const { query, calls } = fakeQuery()
    await saveBankToken(query, token)
    const c = calls[0]!
    expect(c.sql).toMatch(/INSERT INTO bank_tokens/)
    expect(c.sql).toMatch(/ON CONFLICT \(member_id, provider, account_key\) DO UPDATE/)
    const p = c.params as unknown[]
    expect([p[0], p[1], p[2], p[3], p[5]]).toEqual(['m1', 'alfa-by', 'MC_7', 'ACCESS', 1_700_000_000_000])
    // refresh stored ENCRYPTED (not the plaintext), and decrypts back to the original
    expect(p[4]).not.toBe('REFRESH')
    expect(decryptSecret(String(p[4]))).toBe('REFRESH')
  })
})

describe('getBankToken', () => {
  it('loads and decrypts a stored token', async () => {
    const row = await storedRow()
    const { query, calls } = fakeQuery([row])
    const got = await getBankToken(query, 'm1', 'alfa-by', 'MC_7')
    expect(got).toEqual(token) // refresh decrypted back to plaintext
    // scoped by all three key parts
    expect(calls[0]!.params).toEqual(['m1', 'alfa-by', 'MC_7'])
    expect(calls[0]!.sql).toMatch(/WHERE member_id = \$1 AND provider = \$2 AND account_key = \$3/)
  })

  it('returns null when the account is not connected', async () => {
    const { query } = fakeQuery([]) // no rows
    expect(await getBankToken(query, 'm1', 'alfa-by', 'nope')).toBeNull()
  })

  it('throws when the stored refresh blob cannot be decrypted (wrong key / tampering)', async () => {
    const bad = { member_id: 'm1', provider: 'alfa-by', account_key: 'MC_7', access_token: 'A', refresh_token_enc: 'not-a-valid-blob', expires_at: 1 }
    const { query } = fakeQuery([bad])
    await expect(getBankToken(query, 'm1', 'alfa-by', 'MC_7')).rejects.toThrow(/failed to decrypt/)
  })
})

describe('listBankTokensForPortal', () => {
  it('returns every connected account of the portal, decrypted, scoped by member_id', async () => {
    const a = await storedRow({ ...token, accountKey: 'MC_7' })
    const b = await storedRow({ ...token, provider: 'prior-by', accountKey: 'MC_9', refreshToken: 'R2' })
    const { query, calls } = fakeQuery([a, b])
    const list = await listBankTokensForPortal(query, 'm1')
    expect(list.map(t => [t.provider, t.accountKey, t.refreshToken])).toEqual([
      ['alfa-by', 'MC_7', 'REFRESH'],
      ['prior-by', 'MC_9', 'R2']
    ])
    expect(calls[0]!.params).toEqual(['m1'])
    expect(calls[0]!.sql).toMatch(/WHERE member_id = \$1 ORDER BY provider, account_key/)
  })

  it('returns [] for a portal with no connected accounts', async () => {
    const { query } = fakeQuery([])
    expect(await listBankTokensForPortal(query, 'm1')).toEqual([])
  })
})

describe('deleteBankTokensForPortal', () => {
  it('deletes all of a portal\'s rows and returns the count', async () => {
    const { query, calls } = fakeQuery([{ member_id: 'm1' }, { member_id: 'm1' }])
    const n = await deleteBankTokensForPortal(query, 'm1')
    expect(n).toBe(2)
    expect(calls[0]!.sql).toMatch(/DELETE FROM bank_tokens WHERE member_id = \$1 RETURNING/)
    expect(calls[0]!.params).toEqual(['m1'])
  })

  it('is idempotent — 0 rows when nothing to delete', async () => {
    const { query } = fakeQuery([])
    expect(await deleteBankTokensForPortal(query, 'm1')).toBe(0)
  })
})

describe('SCHEMA_SQL', () => {
  it('declares the bank_tokens table with the composite PK', async () => {
    const { SCHEMA_SQL } = await import('../server/db/client')
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_tokens/)
    expect(SCHEMA_SQL).toMatch(/PRIMARY KEY \(member_id, provider, account_key\)/)
  })
})
