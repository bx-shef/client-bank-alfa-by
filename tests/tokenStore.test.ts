import { Buffer } from 'node:buffer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SCHEMA_SQL } from '../server/db/client'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'
import {
  countRevokedPortals,
  deleteToken,
  getApplicationToken,
  getMemberIdByDomain,
  getToken,
  countPortals,
  markGrantRevoked,
  saveToken,
  selectReapablePortals,
  updatePortalTokenSecrets,
  markSubscriptionEnded,
  clearSubscriptionEnded,
  selectSubscriptionEnded,
  selectSubscriptionCutoff,
  countSubscriptionCutoff
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
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{
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
    expect(await getToken(vi.fn(async (_sql: string, _params?: unknown[]) => []), 'nope')).toBeNull()
  })

  it('throws when the refresh blob cannot be decrypted', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{
      member_id: 'm1', domain: 'd', access_token: 'a', refresh_token_enc: 'garbage', expires_at: '1', application_token: 't'
    }])
    await expect(getToken(query, 'm1')).rejects.toThrow(/failed to decrypt/)
  })
})

describe('getApplicationToken', () => {
  it('returns the stored token', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ application_token: 'APPTOK' }])
    expect(await getApplicationToken(query, 'm1')).toBe('APPTOK')
  })
  it('returns empty string for an unknown portal', async () => {
    expect(await getApplicationToken(vi.fn(async (_sql: string, _params?: unknown[]) => []), 'm1')).toBe('')
  })
})

describe('getMemberIdByDomain', () => {
  it('normalizes the domain (strips scheme/path) and passes it as a bound param', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ member_id: 'M-1' }])
    expect(await getMemberIdByDomain(query, 'https://p.bitrix24.by/some/path')).toBe('M-1')
    // Parameterized (no injection), normalized to the bare host.
    expect(query.mock.calls[0]![1]).toEqual(['p.bitrix24.by'])
  })

  it('returns null for an unknown domain (app not installed → 409 upstream)', async () => {
    expect(await getMemberIdByDomain(vi.fn(async (_sql: string, _params?: unknown[]) => []), 'ghost.bitrix24.by')).toBeNull()
  })

  it('returns null for an empty/blank domain without querying', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [])
    expect(await getMemberIdByDomain(query, '')).toBeNull()
    expect(await getMemberIdByDomain(query, '   ')).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('takes the most-recent row (ORDER BY updated_at DESC) if duplicates ever exist', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ member_id: 'NEWEST' }])
    expect(await getMemberIdByDomain(query, 'p.bitrix24.by')).toBe('NEWEST')
    expect(query.mock.calls[0]![0]).toMatch(/ORDER BY updated_at DESC/i)
  })
})

describe('deleteToken', () => {
  it('удаление и тумбстоун — ОДИН оператор, а не два (#510)', async () => {
    // ⚠ Раньше это были два отдельных `query()`, и тогда единственным вопросом было, какой
    // порядок менее плох: либо строка переживает запрет (живые OAuth-креды на диске у портала,
    // только что отозвавшего согласие), либо запрет переживает строку (конкурент не видит ни
    // того, ни другого и считает портал живым). Postgres выполняет ОДИН оператор — включая
    // data-modifying CTE — в одной неявной транзакции, поэтому ложатся оба или ни одного, и
    // вопрос порядка перестаёт существовать.
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [])
    await deleteToken(query, 'm1', 42)
    expect(query).toHaveBeenCalledTimes(1)
    const sql = query.mock.calls[0]![0]
    expect(sql).toMatch(/WITH deleted AS \(/i)
    expect(sql).toMatch(/DELETE FROM portal_tokens WHERE member_id = \$1/)
    expect(sql).toMatch(/INSERT INTO portal_tombstone/)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 42])
  })

  // Ordering guard (#77): records a tombstone with the uninstall ts (GREATEST-merged).
  it('writes a tombstone keeping the newest deleted_ts (GREATEST)', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [])
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
describe('updatePortalTokenSecrets — рефреш НЕ создаёт регистрацию портала (#510)', () => {
  /** Фейк «строки нет»: UPDATE ничего не вернул. */
  const gone = () => vi.fn(async (_sql: string, _params?: unknown[]) => [] as Record<string, unknown>[])
  /** Фейк «строка есть»: UPDATE вернул member_id. */
  const present = () => vi.fn(async (_sql: string, _params?: unknown[]) => [{ member_id: 'm1' }] as Record<string, unknown>[])

  it('удалённый портал НЕ воскресает — false, и ни одного INSERT', async () => {
    // Суть issue. Раньше рефреш ходил тем же upsert'ом, что и установка, и мог пересоздать строку
    // портала, который нас удалил, — то есть мы оставляли себе его OAuth-токен до истечения гранта.
    const query = gone()
    expect(await updatePortalTokenSecrets(query, token)).toBe(false)
    expect(query.mock.calls.every(c => !/INSERT INTO portal_tokens/.test(c[0] as string))).toBe(true)
  })

  it('живой портал обновляется — true', async () => {
    const query = present()
    expect(await updatePortalTokenSecrets(query, token)).toBe(true)
    expect(query.mock.calls[0]![0]).toMatch(/UPDATE portal_tokens/)
  })

  it('это UPDATE, а не upsert: ни INSERT, ни ON CONFLICT в самом SQL', async () => {
    // ⚠ Проверяется ТЕКСТ запроса, а не только возврат: `INSERT … ON CONFLICT DO UPDATE` на живой
    // строке вернул бы ровно тот же `true`, и разницу — единственную, ради которой всё сделано —
    // по возвращаемому значению увидеть нельзя.
    const query = present()
    await updatePortalTokenSecrets(query, token)
    const sql = query.mock.calls[0]![0] as string
    expect(sql).not.toMatch(/INSERT/i)
    expect(sql).not.toMatch(/ON CONFLICT/i)
    expect(sql).toMatch(/RETURNING member_id/i)
  })

  it('штампует `updated_at` — по нему выбирает порталы проактивное продление (#175)', async () => {
    // ⚠ Противоположно `renameBankTokenAccount`, где `now()` трогать НЕЛЬЗЯ. Здесь колонка значит
    // «когда мы последний раз держали свежую пару», и не обновив её, продление гоняло бы рефреш по
    // одному и тому же порталу на каждом тике.
    const query = present()
    await updatePortalTokenSecrets(query, token)
    expect(query.mock.calls[0]![0]).toMatch(/updated_at\s*=\s*now\(\)/i)
  })

  it('не трогает `application_token` — он write-once и приходит только с установкой', async () => {
    const query = present()
    await updatePortalTokenSecrets(query, token)
    expect(query.mock.calls[0]![0]).not.toMatch(/application_token/i)
  })

  it('каждое значение стоит на СВОЁМ месте — позиции сверяются целиком', async () => {
    // ⚠ Находка мутационного ревью: проверялся только `params[3]` (шифрование refresh), поэтому
    // перестановка `domain` и `accessToken` местами в массиве параметров не ловилась НИЧЕМ —
    // при живом `SET domain = $2, access_token = $3` access-токен уехал бы в колонку домена, а
    // домен в колонку токена. Это классическая ошибка рефакторинга «переставили поля в SET и
    // забыли массив», и последствия у неё катастрофические: портал теряет и адрес, и доступ.
    const query = present()
    await updatePortalTokenSecrets(query, token)
    const params = query.mock.calls[0]![1] as unknown[]
    expect(params).toHaveLength(5)
    expect(params[0]).toBe(token.memberId)
    expect(params[1]).toBe(token.domain)
    expect(params[2]).toBe(token.accessToken)
    expect(params[4]).toBe(token.expiresAt)
    // ⚠ И порядок в SQL сверяется с этим порядком: сам по себе правильный массив ничего не
    // значит, если плейсхолдеры в тексте переставлены.
    const sql = query.mock.calls[0]![0] as string
    expect(sql).toMatch(/domain\s*=\s*\$2/)
    expect(sql).toMatch(/access_token\s*=\s*\$3/)
    expect(sql).toMatch(/refresh_token_enc\s*=\s*\$4/)
    expect(sql).toMatch(/expires_at\s*=\s*\$5/)
    expect(sql).toMatch(/WHERE member_id = \$1/)
  })

  it('refresh уезжает ЗАШИФРОВАННЫМ, а не открытым текстом', async () => {
    const query = present()
    await updatePortalTokenSecrets(query, token)
    const params = query.mock.calls[0]![1] as unknown[]
    expect(params).not.toContain('REFRESH')
    expect(decryptSecret(String(params[3]))).toBe('REFRESH')
  })

  it('настоящий сбой БД пробрасывается, а не выдаётся за «строки нет»', async () => {
    // Иначе недоступная база молча выглядела бы как удалённый портал, и рефреш тихо терял бы
    // ротированную пару — самый неприятный вид отказа, потому что снаружи он неотличим от нормы.
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
      throw new Error('connection refused')
    })
    await expect(updatePortalTokenSecrets(query, token)).rejects.toThrow('connection refused')
  })
})

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

// Отметка «грант мёртв» и выборка кандидатов на удаление (#574).
//
// ⚠ Проверяется САМ SQL, а не только возвращаемое значение. Здесь два инварианта, промах в каждом
// из которых не падает и не виден: отметка не должна перезаписываться (иначе срок отодвигается
// вечно и портал не стирается никогда), и она не должна трогать `updated_at` (иначе мёртвый портал
// выпадает из выборки продления, перестаёт получать отказы — и уборщик сам себя выключает).
describe('markGrantRevoked (#574)', () => {
  it('ставит отметку ТОЛЬКО когда её ещё нет', async () => {
    const { query, calls } = fakeQuery()
    await markGrantRevoked(query, 'M1', 1_700_000_000_000)
    const sql = calls[0]!.sql
    expect(sql).toMatch(/UPDATE portal_tokens/)
    expect(sql, 'без этого условия срок отодвигался бы каждым тиком').toMatch(/grant_revoked_at\s*=\s*0/)
    expect(calls[0]!.params).toEqual(['M1', 1_700_000_000_000])
  })

  it('отметка НЕ штампует updated_at — иначе уборщик сам себя выключит', async () => {
    // По `updated_at` выбираются порталы для продления (#175). Сдвинув его, мы выкинули бы мёртвый
    // портал из выборки — то есть перестали бы получать отказы, по которым и считается срок.
    const { query, calls } = fakeQuery()
    await markGrantRevoked(query, 'M1', 1)
    expect(calls[0]!.sql).not.toMatch(/updated_at/)
  })
})

describe('selectReapablePortals / countRevokedPortals (#574)', () => {
  it('берёт только помеченных и только старше границы, самых давних первыми', async () => {
    const calls: { sql: string, params?: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return [{ member_id: 'M1', grant_revoked_at: 111 }]
    })
    const rows = await selectReapablePortals(query, 999, 3)
    expect(rows).toEqual([{ memberId: 'M1', revokedAtMs: 111 }])
    const sql = calls[0]!.sql
    expect(sql, 'неотмеченные не должны попадать в выборку').toMatch(/grant_revoked_at > 0/)
    expect(sql).toMatch(/grant_revoked_at <= \$1/)
    expect(sql, 'при упоре в потолок очередь должна двигаться, а не топтаться').toMatch(/ORDER BY grant_revoked_at ASC/)
    expect(sql, 'без LIMIT ошибка классификации вернула бы всех клиентов разом').toMatch(/LIMIT \$2/)
  })

  it('LIMIT не может стать нулевым или отрицательным', async () => {
    const calls: { sql: string, params?: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    await selectReapablePortals(query, 999, 0)
    expect((calls[0]!.params as unknown[])[1]).toBe(1)
    await selectReapablePortals(query, 999, -5)
    expect((calls[1]!.params as unknown[])[1]).toBe(1)
  })

  it('строки без member_id отбрасываются, а не превращаются в удаление пустого id', async () => {
    const query = vi.fn(async () => [{ member_id: '', grant_revoked_at: 1 }, { member_id: 'M2', grant_revoked_at: 2 }])
    expect(await selectReapablePortals(query, 999, 3)).toEqual([{ memberId: 'M2', revokedAtMs: 2 }])
  })

  it('счётчик кандидатов считает по тому же условию', async () => {
    const calls: { sql: string }[] = []
    const query = vi.fn(async (sql: string) => {
      calls.push({ sql })
      return [{ n: 7 }]
    })
    expect(await countRevokedPortals(query, 999)).toBe(7)
    expect(calls[0]!.sql).toMatch(/grant_revoked_at > 0 AND grant_revoked_at <= \$1/)
  })
})

describe('#574: скоуп по порталу в SQL — не «параметр есть», а «он в WHERE»', () => {
  // ⚠ Ревью замерило дыру: из `markGrantRevoked` можно было убрать `member_id = $1` из WHERE,
  // оставив `memberId` в массиве параметров, и НИ ОДИН тест не падал — проверялись только
  // `params`. В проде это значит: один портал поймал `invalid_grant`, а помечены мёртвыми ВСЕ
  // живые разом, и всем запущен таймер до необратимого стирания.
  function sqlOf(calls: { sql: string }[]): string {
    return calls.map(c => c.sql).join('\n')
  }

  it('пометка адресована ОДНОМУ порталу', async () => {
    const calls: { sql: string, params: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    await markGrantRevoked(query as unknown as QueryFn, 'M1', 1)
    expect(sqlOf(calls), 'без скоупа пометка накрыла бы весь флот').toMatch(/WHERE[\s\S]*member_id\s*=\s*\$1/)
  })

  it('снятие пометки ВШИТО в обновление токена, а не живёт отдельным запросом', async () => {
    // ⚠ Отдельный запрос на залоченном соединении мог упасть, перевести транзакцию в aborted, и
    // COMMIT молча стал бы ROLLBACK: токен у Б24 ротирован, а у нас не сохранён — портал сломан
    // навсегда. Вшитое в тот же UPDATE условие рассинхронизировать нечем.
    const calls: { sql: string, params: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return [{ member_id: 'M1' }]
    })
    await updatePortalTokenSecrets(query as unknown as QueryFn, {
      memberId: 'M1', domain: 'p.bitrix24.by', accessToken: 'A', refreshToken: 'R',
      expiresAt: 1, applicationToken: 'T'
    })
    expect(sqlOf(calls), 'успешное обновление обязано снимать отметку тем же запросом').toMatch(/grant_revoked_at\s*=\s*0/)
  })

  it('переустановка портала СНИМАЕТ отметку — сильнейшее доказательство жизни', async () => {
    // Портал исчез без события, метка осталась; клиент переустановил приложение и настраивает его.
    // Пока банк не подключён, серверных REST-вызовов нет, рефреша нет — и без сброса в апсерте
    // свежепоставленный портал дожил бы до порога с чужой меткой и был бы стёрт.
    const calls: { sql: string, params: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    await saveToken(query as unknown as QueryFn, {
      memberId: 'M1', domain: 'p.bitrix24.by', accessToken: 'A', refreshToken: 'R',
      expiresAt: 1, applicationToken: 'T'
    })
    const upsert = calls.map(c => c.sql).find(x => /ON CONFLICT/.test(x)) ?? ''
    expect(upsert).toMatch(/grant_revoked_at\s*=\s*0/)
  })

  it('countPortals считает ВЕСЬ флот, а не только живых', async () => {
    // Знаменатель предохранителя: вычти из него уже помеченных — и он полз бы вверх по доле с
    // каждой пометкой, то есть предохранитель слабел бы ровно по мере развития аварии.
    const calls: { sql: string }[] = []
    const query = vi.fn(async (sql: string) => {
      calls.push({ sql })
      return [{ n: 7 }]
    })
    const n = await countPortals(query as unknown as QueryFn)
    expect(n).toBe(7)
    expect(sqlOf(calls)).not.toMatch(/grant_revoked_at/)
  })
})

describe('метка истёкшей подписки (#614)', () => {
  function sqlOf(calls: { sql: string }[]): string {
    return calls.map(c => c.sql).join('\n')
  }
  function spy() {
    const calls: { sql: string, params: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return []
    })
    return { calls, query: query as unknown as QueryFn }
  }

  it('ставится ТОЛЬКО когда её ещё нет — отсчёт от первого отказа', () => {
    // Перезаписывая метку каждым отказом, мы отодвигали бы срок вечно, и отключение не наступило
    // бы никогда: механизм выглядел бы рабочим и не работал.
    const { calls, query } = spy()
    return markSubscriptionEnded(query, 'M1', 123).then(() => {
      expect(sqlOf(calls)).toMatch(/subscription_ended_at\s*=\s*0/)
    })
  })

  it('адресована ОДНОМУ порталу', async () => {
    // Без скоупа один отказавший портал пометил бы весь флот и запустил всем таймер отключения.
    const { calls, query } = spy()
    await markSubscriptionEnded(query, 'M1', 123)
    expect(sqlOf(calls)).toMatch(/WHERE[\s\S]*member_id\s*=\s*\$1/)
  })

  it('НЕ штампует updated_at — иначе выбьет портал из выборки продления', async () => {
    const { calls, query } = spy()
    await markSubscriptionEnded(query, 'M1', 123)
    expect(sqlOf(calls)).not.toMatch(/updated_at/)
  })

  it('снятие тоже адресовано одному порталу и не трогает лишних строк', async () => {
    const { calls, query } = spy()
    await clearSubscriptionEnded(query, 'M1')
    expect(sqlOf(calls)).toMatch(/WHERE[\s\S]*member_id\s*=\s*\$1/)
    // `<> 0` защищает от UPDATE на каждый прогон каждого живого портала.
    expect(sqlOf(calls)).toMatch(/subscription_ended_at\s*<>\s*0/)
  })

  it('снятие сообщает, БЫЛА ли метка — иначе в лог шла бы строка на каждый прогон', async () => {
    const query = vi.fn(async () => []) as unknown as QueryFn
    expect(await clearSubscriptionEnded(query, 'M1')).toBe(false)
    const hit = vi.fn(async () => [{ member_id: 'M1' }]) as unknown as QueryFn
    expect(await clearSubscriptionEnded(hit, 'M1')).toBe(true)
  })

  it('выборка берёт только помеченных, самых давних первыми, с потолком', async () => {
    const { calls, query } = spy()
    await selectSubscriptionEnded(query, 5)
    const sql = sqlOf(calls)
    expect(sql).toMatch(/subscription_ended_at > 0/)
    expect(sql, 'при упоре в потолок очередь должна двигаться').toMatch(/ORDER BY subscription_ended_at ASC/)
    expect(sql).toMatch(/LIMIT \$1/)
  })

  // ⚠ Выборка автоотключения (#614) — отдельная от консольной НАМЕРЕННО: консоли нужны ВСЕ
  // помеченные (она рисует обратный отсчёт), автомату — только перешагнувшие границу. Одна
  // функция на два вопроса означала бы условие «граница или ноль» прямо в SQL, а его цена
  // очевидна: ошибись в нём — и автомат отключит банк у портала, помеченного минуту назад.
  // ⚠ Проверяется САМ SQL: `memStore` в тестах его не исполняет, он переписывает семантику на JS,
  // поэтому правки `WHERE` для него невидимы (замерено на #23-#25).
  it('автоотключение смотрит только за границу — иначе отключит помеченных минуту назад', async () => {
    const { calls, query } = spy()
    await selectSubscriptionCutoff(query, 123, 5)
    const sql = sqlOf(calls)
    expect(sql).toMatch(/subscription_ended_at > 0/)
    expect(sql, 'без границы кандидатом станет КАЖДЫЙ помеченный').toMatch(/subscription_ended_at <= \$1/)
    expect(sql, 'при упоре в потолок очередь должна двигаться').toMatch(/ORDER BY subscription_ended_at ASC/)
    expect(sql).toMatch(/LIMIT \$2/)
    expect(calls[0]?.params).toEqual([123, 5])
  })

  it('счётчик кандидатов считает по ТОЙ ЖЕ границе, что и выборка', async () => {
    // Он знаменатель предохранителя по доле флота. Разойдись условия — предохранитель считал бы
    // одно множество, а отключалось бы другое.
    const { calls, query } = spy()
    await countSubscriptionCutoff(query, 456)
    const sql = sqlOf(calls)
    expect(sql).toMatch(/subscription_ended_at > 0/)
    expect(sql).toMatch(/subscription_ended_at <= \$1/)
    expect(calls[0]?.params).toEqual([456])
  })
})
