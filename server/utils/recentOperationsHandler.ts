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

export interface RecentOperationsResult {
  /** Последние операции, свежие сверху. */
  operations: StatementItem[]
  /** Настроен ли смарт-процесс «Платежи»: `false` ⇒ читать неоткуда, UI покажет пустое состояние. */
  configured: boolean
}

export interface RecentOperationsDeps {
  /** Resolve the portal member_id by its domain (null ⇒ app not installed). */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame access token for `domain` (returns the user id, '' / throws on a bad or
   *  foreign token). Proves the caller belongs to THIS portal (blocks X-B24-Domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** Read the last operations from the payments SP. `null` ⇒ SP not provisioned (not configured). */
  loadOperations: (memberId: string) => Promise<StatementItem[] | null>
}

export async function handleRecentOperations(
  deps: RecentOperationsDeps,
  input: { accessToken: string, domain: string }
): Promise<{ status: number, body: RecentOperationsResult | { error: string } }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!userId) return { status: 403, body: { error: 'invalid frame token' } }

  const operations = await deps.loadOperations(memberId)
  // СП не настроен — честное пустое состояние, а не ошибка: импорт мог ещё не провижиниться.
  if (operations === null) return { status: 200, body: { operations: [], configured: false } }
  return { status: 200, body: { operations, configured: true } }
}
