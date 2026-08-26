// Pure handler for GET /api/import/operations (#5/#36) — the portal's «Последние операции» for the
// in-portal home screen. Auth = the B24 frame token (same model as /api/import/status): resolve the
// portal by domain, validate the token via `profile` (blocks X-B24-Domain spoofing), then read the
// last operations from the payments SP. DI over the side-effects → unit-testable.
//
// ⚠ НЕ admin-only: это витрина последних операций, её смотрит любой сотрудник портала (бухгалтер),
// в отличие от реестра распределения (`/api/distribution/ledger`, admin-only — там управление).
// ⚠ Чтение идёт на СТОРЕДНОМ токене портала (см. роут), а не на правах пользователя: витрина
// показывает операции портала целиком, как и сводка `/api/import/status`.

import type { StatementItem } from '../../app/types/statement'
import { type DayRange, isValidDayRange } from '../../app/utils/operationPeriod'

export interface RecentOperationsResult {
  /** Последние операции, свежие сверху. */
  operations: StatementItem[]
  /** Настроен ли смарт-процесс «Платежи»: `false` ⇒ читать неоткуда, UI покажет пустое состояние. */
  configured: boolean
  /** Сколько операций в реестре ПОПАЛО В ПЕРИОД (#42) — портал отдаёт фиксированную страницу, и без
   *  этого числа витрина показывала бы часть за целое: «Сводка по операциям» над списком считалась бы
   *  по обрезку, а подпись периода уверяла бы, что это всё. `null` — портал не сообщил (или реестра
   *  нет вовсе). */
  total: number | null
  /** Портал отдал НЕ ВСЕ операции периода.
   *
   *  ⚠ Считается по СЫРОЙ странице, а не сравнением `total` с длиной `operations`: маппер
   *  отбрасывает элементы без валидной суммы (испорченные руками в CRM), и один такой элемент
   *  объявлял бы обрезку там, где её нет, — с советом «выберите срок короче», который не поможет
   *  никогда, потому что строка отброшена маппером, а не страницей. */
  truncated: boolean
}

export interface RecentOperationsDeps {
  /** Resolve the portal member_id by its domain (null ⇒ app not installed). */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame access token for `domain` (returns the user id, '' / throws on a bad or
   *  foreign token). Proves the caller belongs to THIS portal (blocks X-B24-Domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** Read the operations of the requested period from the payments SP. `null` ⇒ SP not provisioned. */
  loadOperations: (memberId: string, range: DayRange) => Promise<{ operations: StatementItem[], total: number | null, truncated: boolean } | null>
}

export async function handleRecentOperations(
  deps: RecentOperationsDeps,
  input: { accessToken: string, domain: string, range: DayRange }
): Promise<{ status: number, body: RecentOperationsResult | { error: string } }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }
  // ⚠ Кривая граница — ОТКАЗ, а не «спросим без фильтра»: молча отброшенное условие РАСШИРЯЕТ
  // период, и человек увидел бы чужой срок под подписью своего.
  if (!isValidDayRange(input.range)) return { status: 400, body: { error: 'bad period' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!userId) return { status: 403, body: { error: 'invalid frame token' } }

  const page = await deps.loadOperations(memberId, input.range)
  // СП не настроен — честное пустое состояние, а не ошибка: импорт мог ещё не провижиниться.
  // ⚠ `total: null`, а не `0`: СП не создан — значит период НИКТО не спрашивал, и «в периоде пусто»
  // было бы уверенным ответом о непроверенном (та же граница, что `unchecked` в сверке счетов).
  if (page === null) return { status: 200, body: { operations: [], configured: false, total: null, truncated: false } }
  return {
    status: 200,
    body: { operations: page.operations, configured: true, total: page.total, truncated: page.truncated }
  }
}
