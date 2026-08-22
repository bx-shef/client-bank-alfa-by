// Гейт и разбор запроса для «стереть дела» (#576 п.4). Чистая логика над инъектируемым вводом-выводом;
// тонкие маршруты (`server/api/activities/erasable.get.ts`, `erase.post.ts`) связывают транспорты.
//
// Авторизация — ТА ЖЕ, что у `/api/bank/*`: портал установлен → фрейм-токен доказан для ЭТОГО
// домена (блок спуфинга `X-B24-Domain`) → администратор портала. Довод тот же и даже сильнее:
// стирание необратимо и затрагивает CRM всего портала, а не того, кто нажал.
//
// ⚠ ДВА РАЗНЫХ ОБРАБОТЧИКА, а не один с флагом «сухой прогон». Флаг означал бы, что один неверный
// булев в клиенте превращает показ количества в удаление; подсчёт здесь СТРУКТУРНО не умеет
// удалять — ему не передают ни батч, ни метод удаления.

import { parsePeriod, type EraseSelection } from '../../app/utils/eraseActivities'
import type { EraseOutcome } from './eraseActivitiesWrite'

export interface EraseResult {
  status: number
  body: Record<string, unknown>
}

export interface EraseAuthDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
}

export interface CountDeps extends EraseAuthDeps {
  count: (memberId: string, selection: EraseSelection) => Promise<{ count: number, capped: boolean }>
}

export interface EraseDeps extends EraseAuthDeps {
  erase: (memberId: string, selection: EraseSelection) => Promise<EraseOutcome>
  /** След в журнале: кто и что стёр. Необратимое действие обязано оставлять запись. */
  audit?: (entry: { memberId: string, userId: string, selection: EraseSelection, outcome: EraseOutcome }) => void
}

export interface EraseInput {
  accessToken: string
  domain: string
  from?: unknown
  to?: unknown
  accounts?: unknown
}

/** Тот же формат номера счёта, что и на подключении: буквы и цифры. */
const ACCOUNT_RE = /^[A-Za-z0-9]{1,64}$/
/**
 * Потолок числа счетов в одном запросе. Список приходит из браузера и разворачивается из выбора
 * банка, поэтому он короткий по природе; кап существует не против человека, а против запроса,
 * который заставил бы нас держать в памяти произвольный набор строк.
 */
export const MAX_ERASE_ACCOUNTS = 64

async function authorize(deps: EraseAuthDeps, input: EraseInput): Promise<{ memberId: string, userId: string } | { error: EraseResult }> {
  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { error: { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } } }
  }
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { error: { status: 409, body: { error: 'portal not installed (no key)' } } }
  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { error: { status: 403, body: { error: 'invalid frame token for this portal' } } }
  }
  if (!frame.isAdmin) {
    return { error: { status: 403, body: { error: 'erasing activities is administrator-only' } } }
  }
  return { memberId, userId: frame.userId }
}

/**
 * Разобрать отбор из недоверенного тела. `null` — отказ.
 *
 * ⚠ Кривой ввод НИКОГДА не превращается в «стереть всё». Пустой период и пустой список счетов —
 * это законное «за всё время по всем счетам», поэтому дата, которую не удалось разобрать, обязана
 * быть ОТКАЗОМ: молча отброшенная граница расширила бы необратимое действие вместо того, чтобы
 * его сузить.
 */
export function parseEraseSelection(input: EraseInput): EraseSelection | null {
  const period = parsePeriod({ from: input.from, to: input.to })
  if (!period) return null
  const raw = input.accounts
  if (raw === undefined || raw === null) return { period, accounts: [] }
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_ERASE_ACCOUNTS) return null
  const accounts: string[] = []
  for (const a of raw) {
    if (typeof a !== 'string') return null
    const v = a.trim()
    if (v === '') continue
    // ⚠ Кривой номер — отказ, а не пропуск: пропущенный номер превратил бы «стереть по этому
    // счёту» в «стереть по всем», если он был единственным.
    if (!ACCOUNT_RE.test(v)) return null
    accounts.push(v)
  }
  return { period, accounts }
}

/** Сколько дел попадёт под удаление. Ничего не меняет. */
export async function handleCountErasable(deps: CountDeps, input: EraseInput): Promise<EraseResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error
  const selection = parseEraseSelection(input)
  if (!selection) return { status: 400, body: { error: 'invalid period or account list' } }
  const { count, capped } = await deps.count(auth.memberId, selection)
  return { status: 200, body: { count, capped } }
}

/** Стереть. Необратимо. */
export async function handleEraseActivities(deps: EraseDeps, input: EraseInput): Promise<EraseResult> {
  const auth = await authorize(deps, input)
  if ('error' in auth) return auth.error
  const selection = parseEraseSelection(input)
  if (!selection) return { status: 400, body: { error: 'invalid period or account list' } }
  const outcome = await deps.erase(auth.memberId, selection)
  deps.audit?.({ memberId: auth.memberId, userId: auth.userId, selection, outcome })
  return { status: 200, body: { deleted: outcome.deleted, remaining: outcome.remaining } }
}
