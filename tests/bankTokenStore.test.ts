import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptSecret } from '../server/utils/secretCrypto'
import {
  deleteBankTokensForPortal,
  getBankToken,
  listAllBankAccounts,
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

describe('listAllBankAccounts (A6 registry)', () => {
  it('returns the identity triple for every row across all portals — no decryption', async () => {
    const { query, calls } = fakeQuery([
      { member_id: 'm1', provider: 'alfa-by', account_key: 'A1' },
      { member_id: 'm2', provider: 'prior-by', account_key: 'P1' }
    ])
    const refs = await listAllBankAccounts(query)
    expect(refs).toEqual([
      { memberId: 'm1', provider: 'alfa-by', accountKey: 'A1' },
      { memberId: 'm2', provider: 'prior-by', accountKey: 'P1' }
    ])
    // SELECTs only identity columns (no access_token/refresh_token_enc) — a corrupt refresh
    // can't hide a healthy account from polling.
    expect(calls[0]!.sql).toMatch(/SELECT member_id, provider, account_key FROM bank_tokens/)
    expect(calls[0]!.sql).not.toMatch(/refresh_token_enc|access_token/)
  })
  it('empty store → []', async () => {
    const { query } = fakeQuery([])
    expect(await listAllBankAccounts(query)).toEqual([])
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

// Behavioral in-memory model of the bank_tokens table — honours the composite-PK upsert,
// the WHERE scoping, and ORDER BY, so tests verify SEMANTICS (isolation/overwrite/order),
// not just SQL substrings. pg returns BIGINT as a STRING, so expires_at is stored stringly.
function memStore() {
  const rows = new Map<string, Record<string, unknown>>()
  const key = (m: string, p: string, a: string) => `${m}|${p}|${a}`
  const query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> = async (sql, params = []) => {
    const p = params as string[]
    if (/^INSERT INTO bank_tokens/.test(sql)) {
      const [member_id, provider, account_key, access_token, refresh_token_enc, expires_at] = p
      rows.set(key(member_id, provider, account_key), {
        member_id, provider, account_key, access_token, refresh_token_enc,
        expires_at: String(expires_at) // pg int8 → string
      })
      return []
    }
    if (/WHERE member_id = \$1 AND provider = \$2 AND account_key = \$3/.test(sql)) {
      const r = rows.get(key(p[0], p[1], p[2]))
      return r ? [r] : []
    }
    if (/DELETE FROM bank_tokens WHERE member_id = \$1/.test(sql)) {
      const del = [...rows.entries()].filter(([, r]) => r.member_id === p[0])
      del.forEach(([k]) => rows.delete(k))
      return del.map(([, r]) => ({ member_id: r.member_id }))
    }
    // list: WHERE member_id=$1 ORDER BY provider, account_key
    return [...rows.values()]
      .filter(r => r.member_id === p[0])
      .sort((a, b) => `${a.provider}${a.account_key}`.localeCompare(`${b.provider}${b.account_key}`))
  }
  return query
}

describe('bankTokenStore — behavioral (in-memory table model)', () => {
  it('upsert OVERWRITES on the same (member,provider,account) key — rotated refresh/expiry win', async () => {
    const q = memStore()
    await saveBankToken(q, token)
    await saveBankToken(q, { ...token, accessToken: 'ACCESS2', refreshToken: 'REFRESH2', expiresAt: 1_800_000_000_000 })
    const got = await getBankToken(q, 'm1', 'alfa-by', 'MC_7')
    expect(got).toEqual({ ...token, accessToken: 'ACCESS2', refreshToken: 'REFRESH2', expiresAt: 1_800_000_000_000 })
    // still exactly one row for the portal (upsert, not insert)
    expect(await listBankTokensForPortal(q, 'm1')).toHaveLength(1)
  })

  it('ISOLATION: getBankToken/list never return another portal\'s or another account\'s row', async () => {
    const q = memStore()
    await saveBankToken(q, token) // m1/alfa-by/MC_7
    await saveBankToken(q, { ...token, memberId: 'm2', accountKey: 'MC_7' }) // another portal, same account_key
    await saveBankToken(q, { ...token, provider: 'prior-by', accountKey: 'MC_9', refreshToken: 'R2' }) // m1, other account
    // wrong account_key → null even though the portal has other accounts
    expect(await getBankToken(q, 'm1', 'alfa-by', 'NOPE')).toBeNull()
    // m1's list has only m1 rows (not m2), scoped
    const list = await listBankTokensForPortal(q, 'm1')
    expect(list.every(t => t.memberId === 'm1')).toBe(true)
    expect(list).toHaveLength(2)
  })

  it('list is ORDERED by provider then account_key (behaviorally, not just SQL text)', async () => {
    const q = memStore()
    // insert out of order
    await saveBankToken(q, { ...token, provider: 'prior-by', accountKey: 'MC_9' })
    await saveBankToken(q, { ...token, provider: 'alfa-by', accountKey: 'MC_7' })
    await saveBankToken(q, { ...token, provider: 'alfa-by', accountKey: 'MC_3' })
    const list = await listBankTokensForPortal(q, 'm1')
    expect(list.map(t => `${t.provider}/${t.accountKey}`)).toEqual(['alfa-by/MC_3', 'alfa-by/MC_7', 'prior-by/MC_9'])
  })

  it('handles pg BIGINT-as-STRING for expires_at (Number coercion path)', async () => {
    const q = memStore() // stores expires_at as a string, like real pg
    await saveBankToken(q, token)
    const got = await getBankToken(q, 'm1', 'alfa-by', 'MC_7')
    expect(got!.expiresAt).toBe(1_700_000_000_000) // coerced back to number
    expect(typeof got!.expiresAt).toBe('number')
  })

  it('list is RESILIENT — a single corrupt row is skipped, healthy rows still returned', async () => {
    const q = memStore()
    await saveBankToken(q, token) // healthy
    await saveBankToken(q, { ...token, provider: 'prior-by', accountKey: 'MC_BAD', refreshToken: 'R2' })
    // corrupt the second row's encrypted blob directly in the model
    const bad = (await q('SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at FROM bank_tokens WHERE member_id = $1 ORDER BY provider, account_key', ['m1']))
      .find(r => r.account_key === 'MC_BAD')!
    bad.refresh_token_enc = 'not-a-valid-blob'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const list = await listBankTokensForPortal(q, 'm1')
    warn.mockRestore()
    expect(list.map(t => t.accountKey)).toEqual(['MC_7']) // healthy kept, corrupt skipped (not thrown)
  })
})
