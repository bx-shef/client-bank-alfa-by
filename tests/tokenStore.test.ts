import { Buffer } from 'node:buffer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SCHEMA_SQL } from '../server/db/client'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'
import {
  deleteToken,
  getApplicationToken,
  getMemberIdByDomain,
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

/** A fake query fn where the tombstone-check SELECT returns `tomb` (default: none),
 *  every other statement returns []. Records all calls. */
function fakeQuery(tomb: Record<string, unknown>[] = []) {
  const calls: { sql: string, params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return /SELECT 1 FROM portal_tombstone/.test(sql) ? tomb : []
  })
  const insert = () => calls.find(c => /INSERT INTO portal_tokens/.test(c.sql))
  return { query, calls, insert }
}

describe('saveToken', () => {
  it('encrypts the refresh token before storage (never plaintext)', async () => {
    const { query, insert } = fakeQuery()
    expect(await saveToken(query, token)).toBe(true)
    const params = insert()!.params!
    expect(params[0]).toBe('m1')
    const enc = params[3] as string
    expect(enc).not.toBe('REFRESH')
    expect(decryptSecret(enc)).toBe('REFRESH')
  })

  it('uses a write-once COALESCE/NULLIF upsert for application_token', async () => {
    const { query, insert } = fakeQuery()
    await saveToken(query, token)
    expect(insert()!.sql).toMatch(/COALESCE\(NULLIF\(portal_tokens\.application_token, ''\), EXCLUDED\.application_token\)/)
  })

  // Ordering guard (#77): a stale register must not resurrect a portal removed by a
  // same-or-newer uninstall.
  it('is a no-op when a same-or-newer tombstone exists (blocked register)', async () => {
    const { query, insert } = fakeQuery([{ x: 1 }]) // tombstone with deleted_ts >= eventTs
    expect(await saveToken(query, token, 100)).toBe(false)
    expect(insert()).toBeUndefined() // never wrote the token
    // the tombstone check bound the incoming eventTs, and uses `>=` so an EQUAL ts blocks
    // (a same-or-newer uninstall wins — the documented «strictly newer reinstall» contract).
    expect(query.mock.calls[0]![0]).toMatch(/deleted_ts\s*>=\s*\$2/)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 100])
  })

  it('writes and clears an OLDER tombstone on a genuine (newer) reinstall', async () => {
    const { query, calls, insert } = fakeQuery([]) // no blocking tombstone (SELECT empty)
    expect(await saveToken(query, token, 200)).toBe(true)
    expect(insert()).toBeDefined()
    const del = calls.find(c => /DELETE FROM portal_tombstone/.test(c.sql))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/deleted_ts\s*<\s*\$2/) // clears STRICTLY-older only (never a same/newer one)
    expect(del!.params).toEqual(['m1', 200]) // clears tombstones older than this install
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

describe('getMemberIdByDomain', () => {
  it('normalizes the domain (strips scheme/path) and passes it as a bound param', async () => {
    const query = vi.fn(async () => [{ member_id: 'M-1' }])
    expect(await getMemberIdByDomain(query, 'https://p.bitrix24.by/some/path')).toBe('M-1')
    // Parameterized (no injection), normalized to the bare host.
    expect(query.mock.calls[0]![1]).toEqual(['p.bitrix24.by'])
  })

  it('returns null for an unknown domain (app not installed → 409 upstream)', async () => {
    expect(await getMemberIdByDomain(vi.fn(async () => []), 'ghost.bitrix24.by')).toBeNull()
  })

  it('returns null for an empty/blank domain without querying', async () => {
    const query = vi.fn(async () => [])
    expect(await getMemberIdByDomain(query, '')).toBeNull()
    expect(await getMemberIdByDomain(query, '   ')).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('takes the most-recent row (ORDER BY updated_at DESC) if duplicates ever exist', async () => {
    const query = vi.fn(async () => [{ member_id: 'NEWEST' }])
    expect(await getMemberIdByDomain(query, 'p.bitrix24.by')).toBe('NEWEST')
    expect(query.mock.calls[0]![0]).toMatch(/ORDER BY updated_at DESC/i)
  })
})

describe('deleteToken', () => {
  it('issues a DELETE by member_id', async () => {
    const query = vi.fn(async () => [])
    await deleteToken(query, 'm1')
    expect(query.mock.calls[0]![0]).toMatch(/DELETE FROM portal_tokens WHERE member_id = \$1/)
    expect(query.mock.calls[0]![1]).toEqual(['m1'])
  })

  // Ordering guard (#77): records a tombstone with the uninstall ts (GREATEST-merged).
  it('writes a tombstone keeping the newest deleted_ts (GREATEST)', async () => {
    const query = vi.fn(async () => [])
    await deleteToken(query, 'm1', 150)
    const tomb = query.mock.calls.find(c => /INSERT INTO portal_tombstone/.test(c[0] as string))
    expect(tomb).toBeDefined()
    expect(tomb![0]).toMatch(/GREATEST\(portal_tombstone\.deleted_ts, EXCLUDED\.deleted_ts\)/)
    expect(tomb![1]).toEqual(['m1', 150])
  })
})

// Sanity: the env key really decodes to 32 bytes for these tests.
it('test env key is 32 bytes', () => {
  expect(Buffer.from(process.env.B24_TOKEN_ENC_KEY!, 'hex').length).toBe(32)
})

// Guard the one drift the fake-query tests can't catch: the SCHEMA_SQL columns
// must cover every column the store's queries read/write. A live DB would error
// on a mismatch; this catches it offline.
describe('SCHEMA_SQL ↔ queries', () => {
  it('defines every column the store uses', () => {
    for (const col of ['member_id', 'domain', 'access_token', 'refresh_token_enc', 'expires_at', 'application_token']) {
      expect(SCHEMA_SQL).toContain(col)
    }
  })
  it('keys the table by member_id (PRIMARY KEY for the upsert ON CONFLICT)', () => {
    expect(SCHEMA_SQL).toMatch(/member_id\s+TEXT PRIMARY KEY/)
  })
  it('defines the portal_tombstone table for the ordering guard (#77)', () => {
    // The tombstone block, matched as a unit so the PRIMARY KEY assertion binds to THIS
    // table (not portal_tokens): member_id PK backs deleteToken's ON CONFLICT (member_id).
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS portal_tombstone \([^;]*member_id\s+TEXT PRIMARY KEY[^;]*deleted_ts\s+BIGINT NOT NULL/s)
  })
})
