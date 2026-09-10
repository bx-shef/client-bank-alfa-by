import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bankRefreshLockKey } from '../server/utils/bankRefreshLock'
import { selectBankAccountsNearExpiry } from '../server/utils/bankTokenKeepAlive'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'
import { updateBankTokenSecrets } from '../server/utils/bankTokenStore'
import { accountsForPolling } from '../server/queue/cron'
import { handleFetchJob, type HandlerDeps } from '../server/queue/handlers'

// ОДИН СЧЁТ БАНКА, ПОДКЛЮЧЁННЫЙ ИЗ ДВУХ РАЗНЫХ ПОРТАЛОВ Б24 (#659).
//
// Задача владельца сформулирована двумя целями:
//   1. у каждого подключения СВОЯ пара access+refresh, и со вторым подключением она не пересекается;
//   2. что делать, если цель 1 не выполняется.
//
// ⚠ ГРАНИЦА ЭТОГО ФАЙЛА НАЗВАНА ПРЯМО: здесь проверяется ТОЛЬКО наша сторона — что хранит база,
// какие ключи берут блокировки, кого планирует крон. Цель 1 состоит из двух половин, и вторая нам
// не принадлежит:
//   • НАША половина — две строки, два гранта, две пары токенов, никакой перекрёстной записи.
//     Она проверяема, и она проверена ниже.
//   • БАНКОВСКАЯ половина — держит ли Альфа ОДНУ «сессию пользователя» на счёт. Если держит, то
//     второй грант убивает первый, и никакая наша аккуратность этого не отменит.
// Ответ на вторую половину даёт только живой стенд с двумя порталами. Основание подозревать её —
// текст самой Альфы: на просроченном обмене она отвечает не «токен истёк», а `invalid_grant:
// User session not alive` (замерено дважды, 6 и 7 сентября). Это чтение чужого сообщения об
// ошибке, а НЕ эксперимент, и выдавать одно за другое нельзя.
//
// Порядок живой проверки — в `docs/OPERATIONS.md`, раздел «Один счёт из двух порталов».

const HOUR = 3_600_000
const NOW = 1_700_000_000_000
const ACCOUNT = 'BY00BANK00000000000000000001'

function acc(over: Partial<BankAccountInfo> = {}): BankAccountInfo {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: ACCOUNT,
    grantId: '',
    connectedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    hasRefresh: true,
    pollPaused: false,
    id: 1,
    lastAttemptAt: 0,
    consentExpiresAt: 0,
    ...over
  }
}

/** Один и тот же счёт, подключённый порталом `m` своим отдельным OAuth (свой грант). */
const fromPortal = (m: string, over: Partial<BankAccountInfo> = {}): BankAccountInfo =>
  acc({ memberId: m, grantId: `grant-${m}`, id: m === 'A' ? 1 : 2, ...over })

describe('цель 1, наша половина: два подключения не пересекаются', () => {
  it('грант выдаётся СЛУЧАЙНЫЙ на каждое подключение — общего у двух порталов быть не может', () => {
    // ⚠ Структурная проверка, и она здесь уместна: `grant_id` строки — это `state.nonce` из
    // подписанного состояния OAuth (`bankConnectCallback`), а сам nonce чеканит роут старта. Если
    // он однажды станет производным от портала, банка или счёта, два подключения ОДНОГО счёта
    // получат один грант — и всё, что доказано ниже про разделение, рухнет молча: обновление
    // одного портала начнёт писать в строки другого (ветка `grant_id = $7` в WHERE).
    const start = readFileSync(resolve(import.meta.dirname, '../server/api/bank/connect.post.ts'), 'utf8')
    expect(start, 'nonce перестал быть случайным — гранты двух подключений могут совпасть')
      .toMatch(/nonce:\s*randomBytes\(\d+\)/)
    const cb = readFileSync(resolve(import.meta.dirname, '../server/utils/bankConnectCallback.ts'), 'utf8')
    expect(cb, 'грант строки больше не берётся из nonce').toMatch(/grantId:\s*state\.nonce/)
  })

  it('обновление портала А адресуется ЕГО member_id — строку портала Б задеть нечем', async () => {
    // Подробный SQL-контракт живёт в `bankTokenStore.test.ts`; здесь он повторён как ПРИЁМОЧНОЕ
    // условие цели 1 — то, на что владелец смотрит, а не деталь реализации.
    const calls: { sql: string, params?: unknown[] }[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return /RETURNING/i.test(sql) ? [{ member_id: 'A' }] : []
    })
    process.env.B24_TOKEN_ENC_KEY = 'cc'.repeat(32)
    await updateBankTokenSecrets(query, {
      memberId: 'A', provider: 'alfa-by', accountKey: ACCOUNT,
      accessToken: 'ACCESS-A', refreshToken: 'REFRESH-A',
      expiresAt: NOW + HOUR, consentExpiresAt: 0, grantId: 'grant-A'
    })
    const { sql, params } = calls[0]!
    expect(sql).toMatch(/WHERE\s+member_id = \$1 AND provider = \$2/)
    expect(params?.[0]).toBe('A')
    // ⚠ И грант тоже свой: даже сними кто-нибудь `member_id` из WHERE, вторая половина условия
    // всё ещё не пустила бы запись в чужую строку. Две независимые преграды, а не одна.
    expect(params).toContain('grant-A')
  })

  it('блокировки двух порталов РАЗНЫЕ — друг друга они не ждут', () => {
    const a = bankRefreshLockKey('A', 'alfa-by', ACCOUNT, 'grant-A')
    const b = bankRefreshLockKey('B', 'alfa-by', ACCOUNT, 'grant-B')
    expect(a).not.toBe(b)
    // ⚠ Это НЕ только хорошая новость. Разные локи означают, что к банку два обновления одного
    // счёта могут прийти ОДНОВРЕМЕННО. Пока банк считает гранты независимыми — так и надо
    // (сериализовать чужие порталы значило бы, что портал Б ждёт портал А). Окажется, что сессия
    // у банка одна на счёт, — именно это место и придётся менять, и тест обязан упасть, а не
    // молча описать новое поведение как старое.
  })
})

describe('что делает крон продления: замер, а не мнение', () => {
  it('два портала на одном счёте — В БАНК ИДЁМ ДВАЖДЫ за тик', () => {
    // Дедуп в отборе стоит по ГРАНТУ, а грант у каждого портала свой. Значит за тик уходит два
    // обмена одним и тем же счётом, с двумя разными refresh-токенами.
    const r = selectBankAccountsNearExpiry(
      [fromPortal('A', { connectedAt: NOW - 6 * HOUR }), fromPortal('B', { connectedAt: NOW - 6 * HOUR })],
      NOW
    )
    expect(r.due.map(d => d.memberId).sort()).toEqual(['A', 'B'])
  })

  it('но это НЕ поломка дедупа: шесть счетов ОДНОГО гранта дают один поход', () => {
    // Контраст обязателен. Без него первый тест читался бы как «дедуп сломан», и «починка»
    // схлопнула бы два портала в один — то есть перестала продлевать грант портала Б, и он
    // потерял бы подключение. Дедуп по гранту работает ровно как задуман (#23).
    const sameGrant = ['BY01', 'BY02', 'BY03', 'BY04', 'BY05', 'BY06'].map((k, i) =>
      acc({ memberId: 'A', accountKey: k, grantId: 'grant-A', id: i + 1, connectedAt: NOW - 6 * HOUR }))
    expect(selectBankAccountsNearExpiry(sameGrant, NOW).due).toHaveLength(1)
  })

  it('схлопывать два портала в один НЕЛЬЗЯ — это выбор жертвы, а не починка', () => {
    // Закрепляем словами теста то, что легко «улучшить»: если оставить один грант на счёт, второй
    // перестанет продлеваться и умрёт сам. Проверяем следствие: оба портала обязаны попасть в
    // план, даже когда счёт у них буквально один.
    const r = selectBankAccountsNearExpiry(
      [fromPortal('A', { connectedAt: NOW - 6 * HOUR }), fromPortal('B', { connectedAt: NOW - 6 * HOUR })],
      NOW
    )
    expect(r.due, 'один из порталов выпал из продления — он потеряет подключение за ночь').toHaveLength(2)
  })
})

describe('опрос устроен ТАК ЖЕ, как продление: каждый портал забирает СВОЮ выписку', () => {
  // ⚠ Здесь стояла свёртка «один счёт — один опрос» (#615), и она снята 2026-09-10 решением
  // владельца. Довод не в том, что она была не нужна: она берегла лимит банка и снимала гонку за
  // токеном, — а в том, что раздавать выписку соседу можно было ТОЛЬКО по счёту, который назвал
  // сам банк (введённый руками номер доказательством не является: вписав чужой IBAN, админ
  // получал бы чужие деньги в свою CRM — это граница приватности, а не оптимизация). Боевая Альфа
  // полученный счёт среди своих не называла, поэтому свёртка не включилась НИ РАЗУ, и весь её
  // механизм существовал вхолостую.
  //
  // Цена принята явно: два портала переиздают пару по очереди. Альфа это переживает сама —
  // переспрашивание токена на 401 плюс СЛУЧАЙНАЯ пауза перед повтором, которая их разводит.

  it('оба портала попадают в план опроса — счёт у них общий, а подключения разные', () => {
    const plan = accountsForPolling([fromPortal('A'), fromPortal('B')])
    expect(plan.map(p => p.memberId).sort()).toEqual(['A', 'B'])
    for (const p of plan) expect(p.accounts).toEqual([ACCOUNT])
  })

  it('выписка достаётся ТОЛЬКО тому порталу, который за ней сходил', async () => {
    // ⚠ Не косметика, а та самая граница приватности: раздача по совпадению НОМЕРА — способ
    // увести чужую выписку в свою CRM, а номер мы нигде не проверяем.
    const enqueued: string[] = []
    const deps = {
      fetchStatement: async () => [{ account: ACCOUNT, docId: 'd1' }],
      enqueueCrmSync: async (j: { memberId: string }) => {
        enqueued.push(j.memberId)
        return true
      }
    } as unknown as HandlerDeps
    await handleFetchJob(
      { memberId: 'A', providerId: 'alfa-by', account: ACCOUNT, dateFrom: '2026-09-01', dateTo: '2026-09-02' } as never,
      deps
    )
    expect(enqueued, 'выписку отдали не только опросившему порталу').toEqual(['A'])
  })
})
