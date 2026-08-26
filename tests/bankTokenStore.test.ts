import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decryptSecret } from '../server/utils/secretCrypto'
import {
  addBankAccountToGrant,
  markBankRefreshAttempt,
  deleteBankTokenById,
  deleteBankTokensForPortal,
  renameBankTokenAccount,
  getBankToken,
  listAllBankAccountInfo,
  listAllBankAccounts,
  listBankAccountInfoForPortal,
  listBankTokensForPortal,
  saveBankToken,
  updateBankTokenSecrets,
  setBankPollPaused,
  markAccountsConfirmed
} from '../server/utils/bankTokenStore'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { QueryFn } from '../server/utils/tokenStore'

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
  expiresAt: 1_700_000_000_000,
  // 0 = согласия нет (Альфа) — см. #503. Не «истекло»: по нулю никого не хоронят.
  consentExpiresAt: 0,
  // Грант не размечен — подключение, заведённое до #23. Пустое значение НЕ группирует.
  grantId: ''
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
    access_token: p[3], refresh_token_enc: p[4], expires_at: p[5], consent_expires_at: p[6]
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

  it('САМ SQL хранит правило «неизвестное не затирает известное» (#503)', () => {
    // ⚠ Проверяем ТЕКСТ запроса, а не поведение через `memStore`: тот — рукописный фейк со своей
    // merge-логикой, поэтому подмена CASE WHEN на прямое присваивание проходила его тестами
    // зелёной. Тот же приём уже применён рядом (`renameBankTokenAccount` и `updated_at`).
    const { query, calls } = fakeQuery()
    void saveBankToken(query, token)
    expect(calls[0]!.sql).toMatch(/CASE WHEN EXCLUDED\.consent_expires_at > 0/)
    expect(calls[0]!.sql).toMatch(/ELSE bank_tokens\.consent_expires_at END/)
  })
})

describe('listBankAccountInfoForPortal — проекция для экрана настроек', () => {
  // ⚠ Именно она стоит за живым `GET /api/bank/accounts`, и до этого теста не вызывалась НИ ОДНИМ
  // тестом: соседняя `listAllBankAccountInfo` (её зовёт keep-alive) — другая функция.
  it('КАЖДЫЙ SELECT, строящий BankAccountInfo, читает подтверждение счёта', async () => {
    // ⚠ СТРУКТУРНЫЙ гард, и он написан по живой находке ревью (#615): колонку добавили в маппер
    // трижды, а в SELECT — один раз из трёх. Маппер читал `r.account_confirmed_at` из строки, где
    // такой колонки нет, получал `undefined ?? 0` и ВСЕГДА отдавал ноль. Признак был мёртв
    // целиком: и выбор поллера, и раздача выписки видели «никто не подтверждён».
    //
    // ⚠ Ни типы, ни обычные тесты этого не ловят В ПРИНЦИПЕ. Строка из pg — `Record<string,
    // unknown>`, лишний ключ компилятору не виден; а фейковая строка в тесте содержит ровно то,
    // что положил автор теста, то есть повторяет его же ошибку. Ровно так же однажды потерялся
    // `consent_expires_at` (#503).
    const src = readFileSync(join(import.meta.dirname, '..', 'server/utils/bankTokenStore.ts'), 'utf8')
    // ⚠ Признак проекции `BankAccountInfo` — `last_attempt_at`, и он выбран не наугад. `poll_paused`
    // есть и у лёгкой `BankAccountRef`, `consent_expires_at` — и у `BankToken` с секретами; ни той,
    // ни другому подтверждение не положено ни типом, ни смыслом, и гард ругался бы на исправные
    // запросы. `last_attempt_at` есть ровно у проекции, которая несёт `accountConfirmedAt`.
    const selects = src.split('`SELECT').slice(1).filter(b => b.slice(0, 400).includes('last_attempt_at'))
    expect(selects.length).toBeGreaterThanOrEqual(3)
    for (const block of selects) {
      expect(block.slice(0, 400), `SELECT без account_confirmed_at:\n${block.slice(0, 200)}`)
        .toContain('account_confirmed_at')
    }
  })

  it('подтверждение ДОЕЗЖАЕТ из строки БД, а не подставляется нулём', async () => {
    // Позитивный двойник к тесту «колонки нет ⇒ 0»: тот совпадал с багом и потому его не ловил.
    const { query } = fakeQuery([{
      id: '7', member_id: 'M1', provider: 'alfa-by', account_key: 'BY01',
      expires_at: '1700000000000', updated_at: new Date(1_699_000_000_000),
      has_refresh: true, account_confirmed_at: '1800000000000'
    }])
    const [row] = await listAllBankAccountInfo(query)
    expect(row?.accountConfirmedAt).toBe(1_800_000_000_000)
  })

  it('подтверждение счёта скоуплено ПОРТАЛОМ — иначе это IDOR', async () => {
    // ⚠ Единственная проверка этого SQL: `memStore` его не исполняет, он переписывает семантику на
    // JS, поэтому правки WHERE для него невидимы. Замерено мутацией: снятие `member_id` проходило
    // зелёным — а означает оно, что подтверждение одного портала проставится ЧУЖОЙ строке с тем же
    // номером, то есть ровно тому вписанному вручную номеру, ради которого признак и заведён.
    const { calls, query } = fakeQuery([{ id: '1' }])
    await markAccountsConfirmed(query, 'M1', 'alfa-by', ['BY01'], 1_800_000_000_000)
    const sql = calls.map(c => c.sql).join('\n')
    expect(sql).toMatch(/WHERE[\s\S]*member_id\s*=\s*\$1/)
    expect(sql).toMatch(/provider\s*=\s*\$2/)
    expect(sql).toMatch(/account_key\s*=\s*ANY/)
    // ⚠ `updated_at` НЕ штампуем: по нему keep-alive выбирает, кого продлевать (#489).
    expect(sql).not.toMatch(/updated_at/)
    // ⚠ И ни одной колонки, кроме подтверждения: иначе классификация «без лока» перестаёт быть верной.
    expect(sql).toMatch(/SET\s+account_confirmed_at\s*=\s*\$4/)
  })

  it('пустой список счетов — в базу не ходим вовсе', async () => {
    const { calls, query } = fakeQuery([])
    expect(await markAccountsConfirmed(query, 'M1', 'alfa-by', [], 1)).toBe(0)
    expect(await markAccountsConfirmed(query, 'M1', 'alfa-by', [''], 1)).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('отдаёт свежесть и срок согласия, без единого секрета', async () => {
    const { query } = fakeQuery([{
      id: '9', member_id: 'M1', provider: 'prior-by', account_key: 'BY13',
      expires_at: '1700000000000', updated_at: new Date(1_699_000_000_000),
      has_refresh: true, consent_expires_at: '1800000000000',
      access_token: 'SECRET', refresh_token_enc: 'SECRET'
    }])
    const [row] = await listBankAccountInfoForPortal(query, 'M1')
    expect(row).toEqual({
      id: 9, memberId: 'M1', provider: 'prior-by', accountKey: 'BY13',
      connectedAt: 1_699_000_000_000, expiresAt: 1_700_000_000_000,
      hasRefresh: true, consentExpiresAt: 1_800_000_000_000,
      // ⚠ 0 = «не пробовали ни разу», а не «пробовали давно». Различие несущее: первое даёт шанс
      // немедленно — ровно тот случай, когда подключение пережило простой сервиса (#489).
      lastAttemptAt: 0,
      // ⚠ Колонки `account_confirmed_at` нет ⇒ 0 = «банк счёт не подтверждал» (#615). Подключение,
      // заведённое до этой правки, раздачу выписки соседнему порталу не получает — и не должно:
      // номер счёта вписан руками, а введённый номер доказательством не является.
      accountConfirmedAt: 0,
      // ⚠ Отсутствие колонки в ответе БД читается как «не на паузе», а не как `undefined`: строка,
      // записанная до #576, обязана опрашиваться, а не выпасть из плана молча.
      pollPaused: false,
      // Колонки `grant_id` нет ⇒ `''`: подключение, заведённое до #23, гранта не несёт, и пустое
      // значение НЕ склеивает его с другими такими же (иначе им разослали бы чужие токены).
      grantId: ''
    })
    expect(JSON.stringify(row)).not.toContain('SECRET')
  })

  it('колонки нет в строке ⇒ 0 = «неизвестно», а не «истекло»', async () => {
    const { query } = fakeQuery([{
      member_id: 'M1', provider: 'alfa-by', account_key: 'BY01',
      expires_at: '1', updated_at: new Date(1), has_refresh: true
    }])
    expect((await listBankAccountInfoForPortal(query, 'M1'))[0]!.consentExpiresAt).toBe(0)
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
      // ⚠ Колонки `poll_paused` в этих строках НЕТ, и результат обязан быть `false`, а не
      // `undefined`: строка, записанная до #576, должна опрашиваться как обычно, а не выпасть из
      // плана молча — тот же довод, что у нулей `consent_expires_at`/`last_attempt_at` ниже.
      // Колонки `grant_id` в этих строках тоже нет ⇒ `''`: подключение, заведённое до #23, гранта
      // не несёт, и пустое значение НЕ склеивает его с другими такими же.
      { memberId: 'm1', provider: 'alfa-by', accountKey: 'A1', pollPaused: false, grantId: '' },
      { memberId: 'm2', provider: 'prior-by', accountKey: 'P1', pollPaused: false, grantId: '' }
    ])
    // SELECTs only identity columns (no access_token/refresh_token_enc) — a corrupt refresh
    // can't hide a healthy account from polling.
    expect(calls[0]!.sql).toMatch(/SELECT member_id, provider, account_key, poll_paused FROM bank_tokens/)
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
describe('setBankPollPaused — пауза автоопроса (#576)', () => {
  // ⚠ Заведено потому, что БЕЗ прямого теста здесь три мутации проходили ЗЕЛЁНЫМИ (замерено на
  // ревью): снятие `member_id` из WHERE (это IDOR — чужой портал), снятие сверки `account_key` и
  // добавление `updated_at = now()` (это убивает продление токена). Обработчик выше инъектирует
  // фейковый `setPaused` и до SQL не доходит НИКОГДА, поэтому вся заявленная правильность модуля
  // держалась на одном комментарии.

  it('адресует строку member_id + id + СВЕРЯЕТ номер счёта', async () => {
    const { query, calls } = fakeQuery([{ member_id: 'm1' }])
    expect(await setBankPollPaused(query, 'm1', 42, 'BY01ALFA', true)).toBe('updated')
    const upd = calls[0]!
    expect(upd.sql).toMatch(/UPDATE bank_tokens/i)
    // ⚠ Все три условия в ОДНОМ регулярном выражении: проверка по отдельности прошла бы и тогда,
    // когда одно из них выкинули, — а выкинутый `member_id` это доступ к чужому порталу.
    expect(upd.sql).toMatch(/member_id = \$1 AND id = \$2 AND account_key = \$3/i)
    expect(upd.params).toEqual(['m1', 42, 'BY01ALFA', true])
  })

  it('НЕ штампует updated_at — иначе пауза убивала бы продление токена', async () => {
    // ⚠ Не стиль, а несущее (#489): по `updated_at` keep-alive выбирает, кого продлевать. Перевод
    // часов вперёд нажатием паузы выкинул бы подключение из очереди продления, и оно умерло бы за
    // ночь — ровно та беда, от которой пауза спасает. Смотрим на САМ SQL: возвращённый «для
    // единообразия» `now()` не заметил бы ни один поведенческий тест.
    const { query, calls } = fakeQuery([{ member_id: 'm1' }])
    await setBankPollPaused(query, 'm1', 42, 'BY01ALFA', true)
    expect(calls[0]!.sql).not.toMatch(/updated_at/i)
  })

  it('пишет ТОЛЬКО poll_paused — ни одной колонки токена', async () => {
    // Классификация писателя (`unlocked-single-column`) держится ровно на этом: лок не нужен,
    // потому что за эту колонку обновление токена не борется. Появится второе поле — довод рухнет.
    const { query, calls } = fakeQuery([{ member_id: 'm1' }])
    await setBankPollPaused(query, 'm1', 42, 'BY01ALFA', false)
    const setPart = /SET([\s\S]*?)WHERE/i.exec(calls[0]!.sql)![1]!
    expect(setPart).toMatch(/poll_paused/i)
    expect(setPart).not.toMatch(/access_token|refresh_token_enc|expires_at|account_key/i)
  })

  it('строки нет → gone, строка есть но с другим номером → stale', async () => {
    // Два РАЗНЫХ исхода: `gone` — подключение отключили (обновление списка покажет пустое место),
    // `stale` — оно живо, но уже не то, что было на экране. Слить их нельзя.
    const gone = fakeQuery([])
    expect(await setBankPollPaused(gone.query, 'm1', 42, 'BY01ALFA', true)).toBe('gone')

    let call = 0
    const stale: QueryFn = async (_sql, _params) => (call++ === 0 ? [] : [{ account_key: 'BY02ALFA' }])
    expect(await setBankPollPaused(stale, 'm1', 42, 'BY01ALFA', true)).toBe('stale')
  })

  it('диагностический SELECT тоже скоуплен по порталу', async () => {
    // Иначе по чужому `id` можно было бы выяснить, существует ли строка у другого портала.
    const { query, calls } = fakeQuery([])
    await setBankPollPaused(query, 'm1', 42, 'BY01ALFA', true)
    expect(calls[1]!.sql).toMatch(/WHERE member_id = \$1 AND id = \$2/i)
    expect(calls[1]!.params).toEqual(['m1', 42])
  })
})

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
  let nextId = 1
  const key = (m: string, p: string, a: string) => `${m}|${p}|${a}`
  const query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> = async (sql, params = []) => {
    const p = params as string[]
    // Добавление счёта к существующему гранту (#23): INSERT … SELECT, секреты копируются внутри
    // базы. Проверяется РАНЬШЕ обычного апсерта — оба начинаются с `INSERT INTO bank_tokens`.
    if (/^INSERT INTO bank_tokens/.test(sql) && /SELECT member_id, provider, \$3/.test(sql)) {
      const [member_id, sourceId, account_key] = p
      const src = [...rows.values()].find(r => r.member_id === member_id && String(r.id) === String(sourceId))
      if (!src) return []
      const k = key(member_id, String(src.provider), account_key)
      if (rows.has(k)) throw Object.assign(new Error('duplicate key'), { code: '23505' })
      rows.set(k, {
        ...src, account_key, id: nextId++, last_attempt_at: '0', poll_paused: false,
        updated_at: new Date(clock.now)
      })
      return [{ member_id }]
    }
    if (/^INSERT INTO bank_tokens/.test(sql)) {
      const [member_id, provider, account_key, access_token, refresh_token_enc, expires_at] = p
      const prev = rows.get(key(member_id, provider, account_key))
      const consent = p[6]
      rows.set(key(member_id, provider, account_key), {
        member_id, provider, account_key, access_token, refresh_token_enc,
        expires_at: String(expires_at), // pg int8 → string
        // Модель CASE WHEN EXCLUDED.consent_expires_at > 0 … — ноль значит «неизвестно» и не
        // должен стирать уже известную дату (#503).
        consent_expires_at: Number(consent) > 0 ? String(consent) : String(prev?.consent_expires_at ?? 0),
        // Тем же правилом: пустой грант не РАСКЛЕИВАЕТ уже размеченное подключение (#23).
        grant_id: String(p[7] ?? '') !== '' ? String(p[7]) : String(prev?.grant_id ?? ''),
        id: prev?.id ?? nextId++,
        updated_at: new Date(clock.now)
      })
      return []
    }
    // ⚠ ПРОВЕРЯЕТСЯ РАНЬШЕ ЧТЕНИЯ: UPDATE несёт тот же `WHERE member_id = $1 AND provider = $2 AND
    // account_key = $3`, и если отдать его ветке чтения, модель вернёт строку — то есть подмена
    // UPDATE-only на upsert выглядела бы «успехом», а тест прошёл бы на сломанном коде.
    if (/^UPDATE bank_tokens/.test(sql) && /SET\s+access_token/.test(sql)) {
      const [member_id, provider, account_key, access_token, refresh_token_enc, expires_at] = p
      // ⚠ ЯКОРЬ — ГРАНТ, А НЕ СТРОКА СЧЁТА (#23, находка ревью по гонкам). Грант приходит ПАРАМЕТРОМ
      // ($7), поэтому исчезновение адресуемой строки больше ничего не значит: раньше «Отключить»
      // этот счёт во время обновления уносило ротированную пару у ВСЕХ счетов подключения.
      // Пустой грант не группирует — тогда адресуемся номером счёта, как раньше.
      const grant = String(p[6] ?? '')
      const targets = [...rows.entries()].filter(([, r]) =>
        r.member_id === member_id && r.provider === provider
        && (grant !== '' ? String(r.grant_id ?? '') === grant : r.account_key === account_key))
      if (targets.length === 0) return [] // UPDATE-only: строк нет ⇒ ничего не создаём
      for (const [tk, r] of targets) {
        rows.set(tk, {
          ...r,
          access_token,
          refresh_token_enc,
          expires_at: String(expires_at),
          // Штамп только если его правда просит SQL — иначе мутация «убрать updated_at = now()» была
          // бы невидимой, а именно она тихо ломает выбор кандидатов keep-alive (#489).
          updated_at: /updated_at\s*=\s*now\(\)/.test(sql) ? new Date(clock.now) : r.updated_at
        })
      }
      return targets.map(() => ({ member_id }))
    }
    // Скан по ВСЕМ порталам (listAllBankAccountInfo): без параметров, сортировка по updated_at.
    if (/FROM bank_tokens ORDER BY updated_at/.test(sql)) {
      // ⚠ Сортировка ДО map: спред `Record<string, unknown>` в литерал теряет индексную сигнатуру,
      // и `a.updated_at` после него перестаёт существовать для типов. Порядок тот же по смыслу.
      return [...rows.values()]
        .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
        .map(r => ({ ...r, has_refresh: r.refresh_token_enc !== '' && !String(r.refresh_token_enc).endsWith(':') }))
    }
    // Чтение исходной строки по неизменяемому `id` (#23/#517). ЯВНАЯ ветка, а не падение в общий
    // фильтр по порталу: тот вернул бы ПЕРВУЮ попавшуюся строку, и подстановка чужого id прошла бы
    // незамеченной — то есть модель зеленела бы ровно на том дефекте, ради которого `id` и введён.
    if (/WHERE member_id = \$1 AND id = \$2$/.test(sql.trim())) {
      const r = [...rows.values()].find(x => x.member_id === p[0] && String(x.id) === String(p[1]))
      return r ? [r] : []
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
      id: '7', member_id: 'M1', provider: 'alfa-by', account_key: 'BY00BANK00000000000000000001',
      expires_at: '1700000000000', updated_at: new Date(1_699_000_000_000), has_refresh: true,
      // Если кто-то расширит SELECT, поля приедут сюда — и не должны появиться в результате.
      access_token: 'SECRET', refresh_token_enc: 'SECRET'
    }]
    const [row] = await listAllBankAccountInfo(query)
    expect(row).toEqual({
      id: 7, memberId: 'M1', provider: 'alfa-by', accountKey: 'BY00BANK00000000000000000001',
      connectedAt: 1_699_000_000_000, expiresAt: 1_700_000_000_000, hasRefresh: true,
      // Колонки в строке нет (Альфа согласий не выдаёт) ⇒ 0 = «неизвестно». Именно 0, а не
      // `undefined`: ноль читается правилами как «даты нет», и подключение не хоронится (#503).
      consentExpiresAt: 0,
      // Колонки `last_attempt_at` в строке тоже нет ⇒ 0 = «не пробовали», и подключение получит
      // шанс на первом же тике (#489).
      lastAttemptAt: 0,
      // Колонки `account_confirmed_at` нет ⇒ 0 = «банк счёт не подтверждал». Именно так и должно
      // быть у подключения, заведённого до #615: раздавать по нему выписку соседнему порталу
      // нельзя, пока банк сам не назовёт этот номер среди счетов гранта.
      accountConfirmedAt: 0,
      // Колонки `poll_paused` нет ⇒ `false`: подключение, заведённое до #576, опрашивается.
      pollPaused: false,
      // Колонки `grant_id` нет ⇒ `''`: подключение, заведённое до #23, гранта не несёт.
      grantId: ''
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

describe('срок согласия в сторе (#503)', () => {
  it('дата сохраняется и читается обратно', async () => {
    const q = memStore()
    await saveBankToken(q, { ...token, consentExpiresAt: 1_800_000_000_000 })
    expect((await getBankToken(q, 'm1', 'alfa-by', 'MC_7'))!.consentExpiresAt).toBe(1_800_000_000_000)
  })

  it('ПЕРЕПОДКЛЮЧЕНИЕ без даты НЕ затирает уже известную', async () => {
    // ⚠ Ответ банка без expirationDate — транзиентная аномалия. Прямое присваивание стёрло бы
    // реальный срок: подключение осталось бы живым, но предупреждение «истекает через неделю»
    // пропало бы до следующего удачного цикла. Неизвестное не может отменять знание.
    const q = memStore()
    await saveBankToken(q, { ...token, consentExpiresAt: 1_800_000_000_000 })
    await saveBankToken(q, { ...token, accessToken: 'A2', consentExpiresAt: 0 })
    const got = await getBankToken(q, 'm1', 'alfa-by', 'MC_7')
    expect(got!.accessToken).toBe('A2')
    expect(got!.consentExpiresAt).toBe(1_800_000_000_000)
  })

  it('НОВАЯ дата известную заменяет — продление согласия должно доезжать', async () => {
    const q = memStore()
    await saveBankToken(q, { ...token, consentExpiresAt: 1_800_000_000_000 })
    await saveBankToken(q, { ...token, consentExpiresAt: 1_900_000_000_000 })
    expect((await getBankToken(q, 'm1', 'alfa-by', 'MC_7'))!.consentExpiresAt).toBe(1_900_000_000_000)
  })

  it('обновление токена (#505) даты НЕ трогает', async () => {
    const q = memStore()
    await saveBankToken(q, { ...token, consentExpiresAt: 1_800_000_000_000 })
    await updateBankTokenSecrets(q, { ...token, accessToken: 'A3', consentExpiresAt: 0 })
    expect((await getBankToken(q, 'm1', 'alfa-by', 'MC_7'))!.consentExpiresAt).toBe(1_800_000_000_000)
  })
})

// Удаление по неизменяемому адресу со сверкой ключа (#517).
//
// До этого удаление адресовалось номером счёта — а он МЕНЯЕТСЯ, когда подключению назначают счёт.
// Клик по строке из отрисованного минуту назад списка не находил её и отвечал `200 {removed:false}`,
// неотличимо от честного «уже отключено». Снаружи это выглядело успехом, а приложение продолжало
// ходить в банк клиента вопреки явному запрету.
describe('deleteBankTokenById', () => {
  /** Модель: DELETE удаляет, только если ключ совпал; SELECT показывает, что строка ещё есть. */
  function fake(current: string | null) {
    const sqls: { sql: string, params: unknown[] }[] = []
    const query = async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params })
      if (/^DELETE/.test(sql.trim())) {
        return current !== null && params[2] === current ? [{ member_id: 'm1' }] : []
      }
      return current !== null ? [{ account_key: current }] : []
    }
    return { query, sqls }
  }

  it('удаляет, когда ключ совпадает с тем, что видел нажавший', async () => {
    const { query, sqls } = fake('BY01')
    expect(await deleteBankTokenById(query, 'm1', 7, 'BY01')).toBe('removed')
    // ⚠ Удаление ПЕРВЫМ и единственным: на happy-path диагностика не нужна вовсе.
    expect(sqls).toHaveLength(1)
    expect(sqls[0]!.sql.trim().startsWith('DELETE')).toBe(true)
  })

  it('строки нет — `gone`, то есть честная идемпотентность двойного клика', async () => {
    const { query } = fake(null)
    expect(await deleteBankTokenById(query, 'm1', 7, 'BY01')).toBe('gone')
  })

  it('ключ изменился под пользователем — `stale`, и НИЧЕГО не удалено', async () => {
    // ⚠ Отказ, а не «удалим всё равно»: пока список висел на экране, `~pending:`-подключению могли
    // назначить счёт, и оно стало рабочим. Удалить по такому клику значит снести настроенный
    // доступ вместо мусора.
    const { query, sqls } = fake('BY01')
    expect(await deleteBankTokenById(query, 'm1', 7, '~pending:n1')).toBe('stale')
    expect(sqls.map(c => c.sql.trim().split(/\s+/)[0])).toEqual(['DELETE', 'SELECT'])
  })

  it('УДАЛЕНИЕ идёт первым — иначе между чтением и удалением влезает переименование', async () => {
    // ⚠ Ровно та гонка, что воспроизведена на живом Postgres при ревью: обратный порядок оставляет
    // окно, в которое попадает `renameBankTokenAccount`, и DELETE со старым ключом промахивается —
    // ноль строк читается как «уже отключено», хотя подключение только что стало рабочим.
    const { query, sqls } = fake(null)
    await deleteBankTokenById(query, 'm1', 7, 'BY01')
    expect(sqls[0]!.sql.trim().startsWith('DELETE')).toBe(true)
  })

  it('сравнение ТОЧНОЕ: регистр и пробелы не прощаются', async () => {
    // Функция существует ради «тот ли это ключ, что видел человек». Послабление сравнения тихо
    // расширило бы «тот же» до «похожий» — и удаление снова стало бы попадать не туда.
    for (const stored of [' BY01', 'BY01 ', 'by01']) {
      const { query } = fake(stored)
      expect(await deleteBankTokenById(query, 'm1', 7, 'BY01'), stored).toBe('stale')
    }
  })

  it('оба запроса member-scoped, и удаление сверяет ключ прямо в WHERE', async () => {
    // ⚠ `account_key = $3` в самом DELETE — это и есть атомарность проверки: без него удаление шло
    // бы по одному `id`, не глядя, что строка успела стать другой сущностью.
    const { query, sqls } = fake('OTHER')
    await deleteBankTokenById(query, 'm1', 7, 'BY01')
    expect(sqls).toHaveLength(2)
    for (const c of sqls) expect(c.sql).toContain('member_id = $1')
    expect(sqls[0]!.sql).toContain('account_key = $3')
  })
})

describe('SCHEMA_SQL — неизменяемый адрес строки (#517)', () => {
  it('колонка и её уникальный индекс заводятся идемпотентно', async () => {
    // Миграция гоняется на КАЖДОМ старте: не-идемпотентная форма роняла бы backend на втором.
    const { SCHEMA_SQL } = await import('../server/db/client')
    expect(SCHEMA_SQL).toContain('ADD COLUMN IF NOT EXISTS id BIGSERIAL')
    expect(SCHEMA_SQL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS bank_tokens_id_key')
    // ⚠ Тройка остаётся идентичностью — `id` её не подменяет, а лишь даёт удалению адрес.
    expect(SCHEMA_SQL).toContain('PRIMARY KEY (member_id, provider, account_key)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ОДИН ГРАНТ — НЕСКОЛЬКО СЧЕТОВ (#23-#25)
//
// Здесь закреплено то, ради чего грант заведён: банк РОТИРУЕТ refresh при каждом обновлении,
// поэтому две строки с независимыми копиями одной пары убили бы токен друг друга. Все проверки
// ниже — про это одно свойство, увиденное с разных сторон.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('addBankAccountToGrant — второй счёт без повторного входа в банк (#23)', () => {
  const base = { ...token, grantId: 'G1', accountKey: 'BY01' }

  it('счёт добавляется под ТЕМ ЖЕ грантом и с теми же секретами', async () => {
    const q = memStore()
    await saveBankToken(q, base)
    const [row] = await listBankAccountInfoForPortal(q, 'm1')
    expect(await addBankAccountToGrant(q, 'm1', row!.id, 'BY01', 'BY02')).toBe('added')

    const all = await listBankTokensForPortal(q, 'm1')
    expect(all.map(t => t.accountKey).sort()).toEqual(['BY01', 'BY02'])
    // ⚠ Секреты обязаны СОВПАДАТЬ: это один грант банка, а не два. Разные пары означали бы, что
    // один из счетов держит токен, которого банк не выдавал.
    expect(all[0]!.refreshToken).toBe(all[1]!.refreshToken)
    expect(all.every(t => t.grantId === 'G1')).toBe(true)
  })

  it('ОБНОВЛЕНИЕ ТОКЕНА ДОХОДИТ ДО ВСЕХ СЧЕТОВ ГРАНТА — иначе второй умрёт со сгоревшим refresh', async () => {
    // ⚠ Главная проверка набора. Обнови мы одну строку, у остальных счетов того же согласия на
    // руках остался бы refresh, который банк уже отозвал при ротации: они работали бы до своего
    // тика и отваливались по одному — ночью, молча, тем вернее, чем больше счетов у клиента.
    const q = memStore()
    await saveBankToken(q, base)
    const [row] = await listBankAccountInfoForPortal(q, 'm1')
    await addBankAccountToGrant(q, 'm1', row!.id, 'BY01', 'BY02')

    const ok = await updateBankTokenSecrets(q, {
      ...base, accessToken: 'A2', refreshToken: 'R2', expiresAt: 1_800_000_000_000
    })
    expect(ok).toBe(true)
    const all = await listBankTokensForPortal(q, 'm1')
    expect(all.map(t => t.refreshToken)).toEqual(['R2', 'R2'])
    expect(all.map(t => t.accessToken)).toEqual(['A2', 'A2'])
  })

  it('ЧУЖОЙ ГРАНТ НЕ ЗАТРАГИВАЕТСЯ — обновление не разносит токены по всему порталу', async () => {
    // Обратная сторона той же монеты: широкий UPDATE выдал бы счетам ДРУГОГО согласия пару, к
    // которой банк их не привязывал, и убил бы уже их.
    const q = memStore()
    await saveBankToken(q, base)
    await saveBankToken(q, { ...base, accountKey: 'BY09', grantId: 'G2' })
    await updateBankTokenSecrets(q, { ...base, accessToken: 'A2', refreshToken: 'R2' })

    const other = await getBankToken(q, 'm1', 'alfa-by', 'BY09')
    expect(other!.refreshToken).toBe('REFRESH')
  })

  it('ПУСТОЙ ГРАНТ НЕ ГРУППИРУЕТ — старые подключения не склеиваются между собой', async () => {
    // ⚠ Пустая строка означает «не размечено», а не «общий грант». Сравнивай мы по ней — все
    // подключения портала, заведённые до #23, получили бы токены друг друга.
    const q = memStore()
    await saveBankToken(q, { ...token, accountKey: 'BY01', grantId: '' })
    await saveBankToken(q, { ...token, accountKey: 'BY02', grantId: '' })
    await updateBankTokenSecrets(q, { ...token, accountKey: 'BY01', refreshToken: 'R2' })

    expect((await getBankToken(q, 'm1', 'alfa-by', 'BY02'))!.refreshToken).toBe('REFRESH')
  })

  it('подключение без гранта — честный отказ, а не копия токенов', async () => {
    const q = memStore()
    await saveBankToken(q, { ...token, accountKey: 'BY01', grantId: '' })
    const [row] = await listBankAccountInfoForPortal(q, 'm1')
    expect(await addBankAccountToGrant(q, 'm1', row!.id, 'BY01', 'BY02')).toBe('unmarked')
  })

  it('уже подключённый счёт — конфликт, а не молчаливое затирание живой строки', async () => {
    const q = memStore()
    await saveBankToken(q, base)
    await saveBankToken(q, { ...base, accountKey: 'BY02' })
    const rows = await listBankAccountInfoForPortal(q, 'm1')
    const src = rows.find(r => r.accountKey === 'BY01')!
    expect(await addBankAccountToGrant(q, 'm1', src.id, 'BY01', 'BY02')).toBe('conflict')
  })

  it('список устарел (счёт строки уже другой) — stale, а не добавление не к тому подключению', async () => {
    const q = memStore()
    await saveBankToken(q, base)
    const [row] = await listBankAccountInfoForPortal(q, 'm1')
    expect(await addBankAccountToGrant(q, 'm1', row!.id, 'BY99', 'BY02')).toBe('stale')
  })

  it('строки нет — gone', async () => {
    const q = memStore()
    expect(await addBankAccountToGrant(q, 'm1', 12_345, 'BY01', 'BY02')).toBe('gone')
  })

  it('ЧУЖОЙ ПОРТАЛ НЕ ДОСТАЁТСЯ даже по верному id — member-scoped в самом WHERE', async () => {
    const q = memStore()
    await saveBankToken(q, base)
    const [row] = await listBankAccountInfoForPortal(q, 'm1')
    expect(await addBankAccountToGrant(q, 'ЧУЖОЙ', row!.id, 'BY01', 'BY02')).toBe('gone')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SQL-КОНТРАКТ ДВУХ НОВЫХ ОПЕРАТОРОВ (#23, находка ревью по тестам)
//
// ⚠ Почему отдельный набор, хотя поведенческие тесты выше зелёные. `memStore` не ИСПОЛНЯЕТ SQL — он
// переписывает его семантику на JS: адресация идёт по ключу `Map`, а группировку по гранту модель
// вычисляет сама. Значит любая правка самого WHERE для неё невидима, и замерено это буквально:
// снятие `member_id` из обоих запросов, снятие `<> ''` и полное удаление веера по гранту оставляли
// весь набор зелёным. У соседних функций (`renameBankTokenAccount`, `setBankPollPaused`,
// `deleteBankTokenById`) такие контрактные тесты есть давно — новые операторы получают свои.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SQL-контракт: обновление секретов адресуется ГРАНТОМ и не выходит за портал (#23)', () => {
  async function sqlOf(t: BankToken): Promise<string> {
    const { query, calls } = fakeQuery([{ member_id: 'm1' }])
    await updateBankTokenSecrets(query, t)
    return calls[0]!.sql
  }

  it('портал и банк — в самом WHERE: чужие строки не затрагиваются никогда', async () => {
    const sql = await sqlOf({ ...token, grantId: 'G1' })
    expect(sql).toMatch(/WHERE\s+member_id = \$1 AND provider = \$2/)
  })

  it('ГРАНТ приходит ПАРАМЕТРОМ, а не ищется через строку счёта', async () => {
    // ⚠ Первая версия шла `UPDATE … FROM bank_tokens src WHERE src.account_key = $3`, то есть
    // якорем служила строка того счёта, ради которого пошли в банк. «Отключить» её во время
    // обновления убивало ПОДКЛЮЧЕНИЕ ЦЕЛИКОМ: DELETE коммитился за время POST (до 15 с), якорь
    // исчезал, UPDATE не находил ничего, и остальные счета оставались с refresh, который банк уже
    // заменил. Кнопка, задуманная как безопасный способ убрать один счёт, хоронила все шесть.
    const sql = await sqlOf({ ...token, grantId: 'G1' })
    expect(sql).not.toMatch(/FROM\s+bank_tokens\s+src/)
    expect(sql).toMatch(/grant_id = \$7/)
  })

  it('пустой грант НЕ группирует — адресация падает обратно на номер счёта', async () => {
    const sql = await sqlOf({ ...token, grantId: '' })
    expect(sql).toMatch(/\$7 <> ''/)
    expect(sql).toMatch(/ELSE account_key = \$3/)
  })

  it('грант реально уезжает в параметры, а не остаётся в коде', async () => {
    const { query, calls } = fakeQuery([{ member_id: 'm1' }])
    await updateBankTokenSecrets(query, { ...token, grantId: 'G7' })
    expect(calls[0]!.params).toContain('G7')
  })

  it('`updated_at` штампуется — по нему keep-alive выбирает кандидатов (#489)', async () => {
    expect(await sqlOf({ ...token, grantId: 'G1' })).toMatch(/updated_at\s*=\s*now\(\)/)
  })
})

describe('SQL-контракт: метка попытки адресуется тем же грантом (#23)', () => {
  it('портал, банк и грант — в WHERE; `updated_at` НЕ трогается', async () => {
    // ⚠ Асимметрия с обновлением возвращала бы долбёжку отозванного гранта: планировщик штампует
    // одну строку гранта, а на следующем тике первой могла оказаться другая, с нулевой меткой.
    // ⚠ `updated_at` здесь трогать нельзя: он означает «когда мы держали свежую пару», и штамп при
    // НЕУДАЧЕ сбросил бы возраст — подключение выглядело бы свежим ровно когда ломается.
    const { query, calls } = fakeQuery()
    await markBankRefreshAttempt(query, {
      memberId: 'm1', provider: 'alfa-by', accountKey: 'BY01', grantId: 'G1'
    }, 1_700_000_000_000)
    const sql = calls[0]!.sql
    expect(sql).toMatch(/WHERE\s+member_id = \$1 AND provider = \$2/)
    expect(sql).toMatch(/grant_id = \$5/)
    expect(sql).toMatch(/\$5 <> ''/)
    expect(sql).not.toMatch(/updated_at/)
    expect(calls[0]!.params).toContain('G1')
  })
})

describe('SQL-контракт: добавление счёта не выходит за портал и несёт грант (#23)', () => {
  it('ОБА запроса member-scoped — чужую строку не скопировать даже по верному id', async () => {
    const { query, calls } = fakeQuery([{ account_key: 'BY01', grant_id: 'G1', provider: 'alfa-by', member_id: 'm1' }])
    await addBankAccountToGrant(query, 'm1', 5, 'BY01', 'BY02')
    expect(calls).toHaveLength(2)
    // Чтение исходной строки.
    expect(calls[0]!.sql).toMatch(/WHERE member_id = \$1 AND id = \$2/)
    // Вставка: источник тоже ограничен порталом, а `member_id`/`provider` берутся ИЗ СТРОКИ.
    expect(calls[1]!.sql).toMatch(/FROM bank_tokens WHERE member_id = \$1 AND id = \$2/)
    expect(calls[1]!.sql).toMatch(/SELECT member_id, provider, \$3/)
  })

  it('грант КОПИРУЕТСЯ в новую строку — иначе счёт выпал бы из подключения', async () => {
    // ⚠ Скопируй мы вместо гранта пустую строку — новый счёт обновлялся бы отдельно, со своей
    // копией refresh, то есть ровно тем способом, от которого грант и защищает.
    const { query, calls } = fakeQuery([{ account_key: 'BY01', grant_id: 'G1', provider: 'alfa-by', member_id: 'm1' }])
    await addBankAccountToGrant(query, 'm1', 5, 'BY01', 'BY02')
    const insert = calls[1]!.sql
    expect(insert).toMatch(/consent_expires_at, grant_id, last_attempt_at, poll_paused, updated_at/)
    expect(insert).toMatch(/consent_expires_at, grant_id, 0, false, now\(\)/)
  })

  it('новая строка начинает БЕЗ метки попытки и БЕЗ паузы', async () => {
    // Копия чужой метки означала бы, что новый счёт уже «пробовали», а копия паузы — что он молча
    // не опрашивается, хотя человек только что его добавил.
    const { query, calls } = fakeQuery([{ account_key: 'BY01', grant_id: 'G1', provider: 'alfa-by', member_id: 'm1' }])
    await addBankAccountToGrant(query, 'm1', 5, 'BY01', 'BY02')
    expect(calls[1]!.sql).toMatch(/, 0, false, now\(\)/)
  })
})
