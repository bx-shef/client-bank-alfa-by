import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptSecret } from '../server/utils/secretCrypto'
import {
  deleteBankTokensForPortal,
  renameBankTokenAccount,
  getBankToken,
  listAllBankAccountInfo,
  listAllBankAccounts,
  listBankTokensForPortal,
  saveBankToken,
  updateBankTokenSecrets
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

// Привязка счёта к подключению, сделанному без него (#407). Проверяем ровно то, что защищает
// данные: member/provider-скоуп в SQL, отказ вместо затирания занятого номера, и что гонка двух
// одновременных привязок даёт честный conflict, а не необработанное падение.
describe('renameBankTokenAccount', () => {
  /** Фейк с двумя ответами: первый — на проверку занятости, второй — на UPDATE…RETURNING. */
  function twoStep(taken: Record<string, unknown>[], updated: Record<string, unknown>[]) {
    const calls: { sql: string, params?: unknown[] }[] = []
    let n = 0
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return n++ === 0 ? taken : updated
    })
    return { query, calls }
  }

  it('переименовывает и скоупит запрос по порталу И провайдеру', async () => {
    const { query, calls } = twoStep([], [{ member_id: 'm1' }])
    expect(await renameBankTokenAccount(query, 'm1', 'alfa-by', '~pending:n1', 'BY01')).toBe('renamed')
    const update = calls[1]!
    expect(update.sql).toMatch(/UPDATE bank_tokens/i)
    expect(update.sql).toMatch(/member_id = \$1 AND provider = \$2 AND account_key = \$3/i)
    expect(update.params).toEqual(['m1', 'alfa-by', '~pending:n1', 'BY01'])
    // ⚠ SET-часть тоже под охраной: `updated_at = now()` здесь — регрессия #488. Эта колонка
    // означает «когда мы последний раз держали свежую пару токенов», и по ней keep-alive решает,
    // кого обновлять. Переименование счёта токенов не трогает, но перевело бы часы вперёд — и
    // подключение, которому пора обновляться, тихо выпало бы из выборки до самой смерти гранта.
    // Проверяем САМ запрос: «для единообразия» возвращённый `now()` прошёл бы прежний тест зелёным.
    expect(update.sql).not.toMatch(/updated_at/i)
  })

  it('занятый номер → conflict, и UPDATE вообще не выполняется', async () => {
    const { query, calls } = twoStep([{ '?column?': 1 }], [])
    expect(await renameBankTokenAccount(query, 'm1', 'alfa-by', '~pending:n1', 'BY01')).toBe('conflict')
    // Живой токен другого счёта не должен быть затёрт даже случайно.
    expect(calls).toHaveLength(1)
  })

  it('нет такой строки → not-found', async () => {
    const { query } = twoStep([], [])
    expect(await renameBankTokenAccount(query, 'm1', 'alfa-by', '~pending:n1', 'BY01')).toBe('not-found')
  })

  it('гонка двух привязок (unique_violation) → conflict, а не падение', async () => {
    // Между проверкой и UPDATE номер занял параллельный запрос: без перехвата 23505 проигравший
    // получил бы 500 вместо честного 409 — реальный сценарий двойного клика.
    let n = 0
    const query = vi.fn(async () => {
      if (n++ === 0) return []
      const e = new Error('duplicate key value violates unique constraint') as Error & { code?: string }
      e.code = '23505'
      throw e
    })
    expect(await renameBankTokenAccount(query, 'm1', 'alfa-by', '~pending:n1', 'BY01')).toBe('conflict')
  })

  it('прочие ошибки БД пробрасываются — молчать о них нельзя', async () => {
    let n = 0
    const query = vi.fn(async () => {
      if (n++ === 0) return []
      throw new Error('connection lost')
    })
    await expect(renameBankTokenAccount(query, 'm1', 'alfa-by', '~pending:n1', 'BY01')).rejects.toThrow('connection lost')
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
/**
 * `clock` — подвижные «часы БД» вместо `now()`. Нужны, чтобы модель отличала «строку
 * перештамповали» от «не тронули»: по `updated_at` keep-alive решает, кого пора обновлять, и без
 * наблюдаемой метки удаление `updated_at = now()` из живого SQL не ловится ничем (#505 ревью).
 */
function memStore(clock = { now: 1_700_000_000_000 }) {
  const rows = new Map<string, Record<string, unknown>>()
  const key = (m: string, p: string, a: string) => `${m}|${p}|${a}`
  const query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> = async (sql, params = []) => {
    const p = params as string[]
    if (/^INSERT INTO bank_tokens/.test(sql)) {
      const [member_id, provider, account_key, access_token, refresh_token_enc, expires_at] = p
      rows.set(key(member_id, provider, account_key), {
        member_id, provider, account_key, access_token, refresh_token_enc,
        expires_at: String(expires_at), // pg int8 → string
        updated_at: new Date(clock.now)
      })
      return []
    }
    // ⚠ ПРОВЕРЯЕТСЯ РАНЬШЕ ЧТЕНИЯ: UPDATE несёт тот же `WHERE member_id = $1 AND provider = $2 AND
    // account_key = $3`, и если отдать его ветке чтения, модель вернёт строку — то есть подмена
    // UPDATE-only на upsert выглядела бы «успехом», а тест прошёл бы на сломанном коде.
    if (/^UPDATE bank_tokens/.test(sql) && /SET\s+access_token/.test(sql)) {
      const [member_id, provider, account_key, access_token, refresh_token_enc, expires_at] = p
      const k = key(member_id, provider, account_key)
      const r = rows.get(k)
      if (!r) return [] // UPDATE-only: строки нет ⇒ ничего не создаём
      rows.set(k, {
        ...r,
        access_token,
        refresh_token_enc,
        expires_at: String(expires_at),
        // Штамп только если его правда просит SQL — иначе мутация «убрать updated_at = now()» была
        // бы невидимой, а именно она тихо ломает выбор кандидатов keep-alive (#489).
        updated_at: /updated_at\s*=\s*now\(\)/.test(sql) ? new Date(clock.now) : r.updated_at
      })
      return [{ member_id }]
    }
    // Скан по ВСЕМ порталам (listAllBankAccountInfo): без параметров, сортировка по updated_at.
    if (/FROM bank_tokens ORDER BY updated_at/.test(sql)) {
      return [...rows.values()]
        .map(r => ({ ...r, has_refresh: r.refresh_token_enc !== '' && !String(r.refresh_token_enc).endsWith(':') }))
        .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
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

  // Приор МОЖЕТ не вернуть refresh_token, и колбэк осознанно кладёт пустой. Раньше `saveBankToken`
  // шифровал пустую строку в непустой блоб (`iv:tag:` с пустым шифротекстом), и признак «есть
  // refresh» отвечал TRUE для счёта, который обновить нельзя в принципе: UI показывал «подключено»,
  // а правда всплывала через час вставшим импортом.
  it('пустой refresh_token сохраняется как пустая строка, а не как шифр пустой строки', async () => {
    const { query, calls } = fakeQuery()
    await saveBankToken(query, { ...token, refreshToken: '' })
    expect(calls[0]!.params![4]).toBe('')
  })

  // ⚠ И НЕ КАК NULL: колонка объявлена `TEXT NOT NULL DEFAULT ''`, поэтому NULL упал бы на
  // constraint уже в колбэке — после того, как одноразовый код банка потрачен. Проверка параметра
  // этого не видит (фейковый QueryFn примет что угодно), поэтому нужен именно round-trip.
  it('ROUND-TRIP: счёт без refresh_token сохраняется и читается, а не падает на расшифровке', async () => {
    const q = memStore()
    await saveBankToken(q, { ...token, provider: 'prior-by', refreshToken: '' })
    const got = await getBankToken(q, 'm1', 'prior-by', 'MC_7')
    expect(got).not.toBeNull()
    expect(got!.refreshToken).toBe('')
    expect(got!.accessToken).toBe('ACCESS')
  })

  it('ROUND-TRIP: счёт без refresh_token не выбивает из списка соседние здоровые строки', async () => {
    // Раньше такая строка читалась как «битая» (decryptSecret('null')) и молча выпадала из
    // list-резилиентности — то есть счёт исчезал из UI вместо того, чтобы просить переподключения.
    const q = memStore()
    await saveBankToken(q, token) // alfa-by, refresh есть
    await saveBankToken(q, { ...token, provider: 'prior-by', refreshToken: '' })
    const list = await listBankTokensForPortal(q, 'm1')
    expect(list).toHaveLength(2)
    expect(list.find(t => t.provider === 'prior-by')!.refreshToken).toBe('')
  })

  it('непустой refresh_token по-прежнему шифруется', async () => {
    const { query, calls } = fakeQuery()
    await saveBankToken(query, token)
    const blob = calls[0]!.params![4] as string
    expect(typeof blob).toBe('string')
    expect(decryptSecret(blob)).toBe('REFRESH')
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

describe('listAllBankAccountInfo — проекция скана keep-alive', () => {
  // ⚠ Это единственная выборка, читающая `bank_tokens` по ВСЕМ порталам вместе со свежестью.
  // Расширение её до `SELECT *` не поймал бы ни один тест, а цена — токены в памяти крона
  // (и однажды в чьём-нибудь логе). Форма закреплена явно.
  it('отдаёт идентификацию + свежесть и НИ ОДНОГО секрета', async () => {
    const query = async () => [{
      member_id: 'M1', provider: 'alfa-by', account_key: 'BY00BANK00000000000000000001',
      expires_at: '1700000000000', updated_at: new Date(1_699_000_000_000), has_refresh: true,
      // Если кто-то расширит SELECT, поля приедут сюда — и не должны появиться в результате.
      access_token: 'SECRET', refresh_token_enc: 'SECRET'
    }]
    const [row] = await listAllBankAccountInfo(query)
    expect(row).toEqual({
      memberId: 'M1', provider: 'alfa-by', accountKey: 'BY00BANK00000000000000000001',
      connectedAt: 1_699_000_000_000, expiresAt: 1_700_000_000_000, hasRefresh: true,
      // Колонки в строке нет (Альфа согласий не выдаёт) ⇒ 0 = «неизвестно». Именно 0, а не
      // `undefined`: ноль читается правилами как «даты нет», и подключение не хоронится (#503).
      consentExpiresAt: 0
    })
    expect(JSON.stringify(row)).not.toContain('SECRET')
  })

  it('срок согласия доезжает из строки (#503)', async () => {
    // Без этого дата тихо терялась бы по дороге, а экран и keep-alive продолжали бы жить догадкой.
    const query = async () => [{
      member_id: 'M1', provider: 'prior-by', account_key: 'A',
      expires_at: '1', updated_at: new Date(1), has_refresh: true, consent_expires_at: '1800000000000'
    }]
    expect((await listAllBankAccountInfo(query))[0]!.consentExpiresAt).toBe(1_800_000_000_000)
  })

  it('`has_refresh` не true → false, а не «похоже на правду»', async () => {
    const query = async () => [{
      member_id: 'M1', provider: 'prior-by', account_key: 'A',
      expires_at: '1', updated_at: new Date(1), has_refresh: 'yes'
    }]
    const [row] = await listAllBankAccountInfo(query)
    expect(row!.hasRefresh).toBe(false)
  })
})

describe('updateBankTokenSecrets — UPDATE-only (#505)', () => {
  // ⚠ Эти проверки существуют потому, что вся защита #505 держится на ОДНОМ свойстве SQL: он не
  // создаёт строку. Пока метод проверялся только через фейк в `ensureBankToken.test.ts`, подмена
  // его обратно на upsert не роняла ни одного теста — то есть фикс был не защищён вообще.

  it('существующее подключение обновляется, отвечает true, значения реально меняются', async () => {
    const q = memStore()
    await saveBankToken(q, token)
    const ok = await updateBankTokenSecrets(q, {
      ...token, accessToken: 'ACCESS2', refreshToken: 'REFRESH2', expiresAt: 1_800_000_000_000
    })
    expect(ok).toBe(true)
    expect(await getBankToken(q, 'm1', 'alfa-by', 'MC_7')).toEqual({
      ...token, accessToken: 'ACCESS2', refreshToken: 'REFRESH2', expiresAt: 1_800_000_000_000
    })
  })

  it('СТРОКИ НЕТ ⇒ false, и подключение НЕ создаётся — это и есть весь смысл #505', async () => {
    const q = memStore()
    const ok = await updateBankTokenSecrets(q, token)
    expect(ok).toBe(false)
    expect(await getBankToken(q, 'm1', 'alfa-by', 'MC_7')).toBeNull()
    expect(await listBankTokensForPortal(q, 'm1')).toEqual([])
  })

  it('отключили счёт, пока шёл рефреш — воскрешения не происходит', async () => {
    // Ровно последовательность из issue: подключение есть → админ жмёт «Отключить» → вернувшийся
    // рефреш пытается сохранить токен.
    const q = memStore()
    await saveBankToken(q, token)
    await deleteBankTokensForPortal(q, 'm1')
    expect(await updateBankTokenSecrets(q, { ...token, accessToken: 'ACCESS2' })).toBe(false)
    expect(await listBankTokensForPortal(q, 'm1')).toEqual([])
  })

  it('ONAPPUNINSTALL: портал удалил приложение — его банковские креды не возвращаются', async () => {
    // Второй случай, который лок на маршруте «Отключить» не закрыл бы: удаление приложения сносит
    // ВСЕ счета портала тем же нелокируемым DELETE.
    const q = memStore()
    await saveBankToken(q, token)
    await saveBankToken(q, { ...token, accountKey: 'MC_8' })
    await deleteBankTokensForPortal(q, 'm1')
    expect(await updateBankTokenSecrets(q, token)).toBe(false)
    expect(await updateBankTokenSecrets(q, { ...token, accountKey: 'MC_8' })).toBe(false)
    expect(await listBankTokensForPortal(q, 'm1')).toEqual([])
  })

  it('ПЕРЕШТАМПОВЫВАЕТ updated_at — по нему keep-alive выбирает, кого пора обновлять (#489)', async () => {
    // Без штампа свежий токен либо вечно «due» (лишний запрос в банк на каждом тике), либо по
    // старой метке уходит в «expired» и не обновляется вовсе — та самая ночная смерть.
    const clock = { now: 1_700_000_000_000 }
    const q = memStore(clock)
    await saveBankToken(q, token)
    const before = (await listAllBankAccountInfo(q))[0]!.connectedAt
    clock.now += 3_600_000
    await updateBankTokenSecrets(q, { ...token, accessToken: 'ACCESS2' })
    const after = (await listAllBankAccountInfo(q))[0]!.connectedAt
    expect(after).toBe(before + 3_600_000)
  })

  it('пустой refresh кладётся ЛИТЕРАЛЬНОЙ пустой строкой, а не шифром пустой строки', async () => {
    // Тот же инвариант, что у `saveBankToken`: шифрование '' даёт непустой блоб, и признак
    // `has_refresh` начинает врать «подключено» про счёт, который нечем продлить.
    const q = memStore()
    await saveBankToken(q, token)
    await updateBankTokenSecrets(q, { ...token, refreshToken: '' })
    expect((await listAllBankAccountInfo(q))[0]!.hasRefresh).toBe(false)
    expect((await getBankToken(q, 'm1', 'alfa-by', 'MC_7'))!.refreshToken).toBe('')
  })

  it('ИЗОЛЯЦИЯ: обновляет ровно свою строку по всем трём ключам', async () => {
    // Перепутанные местами $2/$3 иначе прошли бы незамеченными.
    const q = memStore()
    for (const t of [
      token,
      { ...token, accountKey: 'MC_8' },
      { ...token, provider: 'prior-by' as const },
      { ...token, memberId: 'm2' }
    ]) await saveBankToken(q, t)

    await updateBankTokenSecrets(q, { ...token, accessToken: 'ONLY-ME' })

    expect((await getBankToken(q, 'm1', 'alfa-by', 'MC_7'))!.accessToken).toBe('ONLY-ME')
    for (const [m, p, a] of [['m1', 'alfa-by', 'MC_8'], ['m1', 'prior-by', 'MC_7'], ['m2', 'alfa-by', 'MC_7']] as const) {
      expect((await getBankToken(q, m, p, a))!.accessToken, `${m}/${p}/${a}`).toBe('ACCESS')
    }
  })
})
