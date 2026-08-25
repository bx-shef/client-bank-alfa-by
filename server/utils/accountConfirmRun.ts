// Подтверждение счёта банком (#615) — сшивка чистого правила с банком и базой.
//
// ⚠ Зачем вообще спрашивать. Номер счёта админ вписывает РУКАМИ, и мы его нигде не проверяем.
// Пока каждый портал опрашивает банк сам, вписанный чужой номер безвреден: задача просто падает.
// Но раздавать по нему выписку нельзя — админ чужого портала впишет ваш IBAN (он есть на любом
// счёте-фактуре) и получит вашу выписку себе в CRM. Первая редакция #615 сопоставляла порталы
// именно по введённому номеру и была утечкой между клиентами; отсюда этот проход.
//
// ⚠ Спрашиваем ТОЛЬКО про спорные счета — заявленные более чем одним порталом и ещё не
// подтверждённые (`portalsNeedingConfirm`). У портала с уникальным счётом раздавать некому, и
// тратить на него запрос незачем. На обычном флоте (у каждого свой счёт) проход не делает НИ
// ОДНОГО обращения к банку — он бесплатен ровно до тех пор, пока спора нет.
//
// ⚠ Отсюда же следует, что подтверждение — НЕ гейт опроса. Неподтверждённая строка опрашивает свой
// счёт как раньше; признак решает единственный вопрос: можно ли объединить её с чужой.

import type { BankProviderId } from '../../app/types/statement'
import type { BankAccountInfo } from './bankTokenStore'
import { portalsNeedingConfirm } from '../../app/utils/accountSharing'
import type { BankSideProviderResult } from './bankAccountList'
import { portalHash } from './telemetryAttributes'

/**
 * Сколько порталов переспрашиваем за прогон.
 *
 * ⚠ Потолок про ЛИМИТ БАНКА, а не про нагрузку на нас: каждый портал — это запрос к каждому его
 * банку. Спор — редкость, поэтому потолок низкий: не разобрали сегодня — разберём завтра, а до
 * тех пор счёт просто опрашивается по-старому, каждым порталом отдельно.
 */
export const MAX_CONFIRM_PORTALS_PER_RUN = 5

export interface AccountConfirmFacts {
  /** Сколько порталов имело смысл переспросить. */
  candidates: number
  /** Скольких переспросили на самом деле. */
  asked: number
  /** Сколько строк отмечено подтверждёнными. */
  confirmed: number
  /** У скольких порталов банк не ответил. */
  failed: number
  /** Упёрлись в потолок за прогон. */
  capped: boolean
}

export interface AccountConfirmDeps {
  now: () => number
  /** Все банк-строки со свежестью, БЕЗ расшифровки токенов (`listAllBankAccountInfo`). */
  listRows: () => Promise<BankAccountInfo[]>
  /** Спросить у банка, какие счета покрывает согласие портала (`listBankSideAccounts`). */
  bankSide: (memberId: string) => Promise<BankSideProviderResult[]>
  /** Отметить подтверждённые счета портала (`markAccountsConfirmed`). */
  confirm: (memberId: string, provider: BankProviderId, keys: string[], atMs: number) => Promise<number>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

/** Строка итога. Печатается ТОЛЬКО когда было что делать — проход бесплатен и молчалив по замыслу. */
export function accountConfirmLogLine(f: AccountConfirmFacts): string | null {
  if (f.candidates === 0) return null
  const bad = f.failed ? `, банк не ответил у ${f.failed}` : ''
  const cap = f.capped ? `, за прогон не больше ${MAX_CONFIRM_PORTALS_PER_RUN} — остальные в следующий` : ''
  return `спорных счетов: переспрошено порталов ${f.asked} из ${f.candidates}, `
    + `подтверждено строк ${f.confirmed}${bad}${cap}`
}

/** Один прогон подтверждения. */
export async function runAccountConfirm(deps: AccountConfirmDeps): Promise<AccountConfirmFacts> {
  const nowMs = deps.now()
  const rows = await deps.listRows()
  const need = portalsNeedingConfirm(rows)
  const s: AccountConfirmFacts = { candidates: need.length, asked: 0, confirmed: 0, failed: 0, capped: false }
  if (need.length === 0) return s

  for (const memberId of need) {
    if (s.asked >= MAX_CONFIRM_PORTALS_PER_RUN) {
      s.capped = true
      break
    }
    s.asked++
    try {
      const sides = await deps.bankSide(memberId)
      for (const side of sides) {
        // ⚠ Банк ответил ошибкой по этому провайдеру — НЕ подтверждаем ничего и не считаем это
        // отказом всего портала: второй его банк мог ответить нормально. Fail-soft по провайдеру
        // здесь тот же, что у экрана сверки.
        if (side.error) continue
        // ⚠ Номера сравниваются как есть, БЕЗ нормализации. Весь смысл признака в том, что счёт
        // подтверждён банком буквально; «причёсывание» здесь означало бы, что `BY00 BANK …` и
        // `BY00BANK…` считаются одним счётом — а дальше по этому признаку раздаётся выписка.
        const keys = side.accounts.map(a => a.number).filter(n => typeof n === 'string' && n !== '')
        if (keys.length === 0) continue
        s.confirmed += await deps.confirm(memberId, side.provider, keys, nowMs)
      }
    } catch (e) {
      // ⚠ Отказ ОДНОГО портала изолирован: спорных счетов и так мало, и потерять из-за одного
      // недоступного банка разбор остальных было бы обиднее всего.
      s.failed++
      deps.warn?.(`портал ${portalHash(memberId)}: не удалось спросить банк о счетах — `
        + `${(e as Error)?.message ?? String(e)}`)
    }
  }
  const line = accountConfirmLogLine(s)
  if (line) deps.log?.(line)
  return s
}
