// Уборщик мёртвых банк-подключений (#599) — сшивка чистого правила с базой.
//
// ⚠ Стирает ОДНУ строку `bank_tokens`, а не портал: портал жив, мёртв конкретный счёт. Обоснование
// каждого решения — в `app/utils/bankReaper.ts`.
//
// ⚠ БЕЗ флага: удаление включено всегда (клиентов на боевом ещё нет). Предохранители те же, что у
// #574 — порог, потолок за прогон, отказ при слишком большой доле мёртвых («это мы, а не клиенты»).
//
// ⚠ Смерть ВЫВОДИТСЯ из уже хранимых полей (согласие банка / измеренный TTL Альфы), поэтому SQL-
// выборки «кандидатов» нет: читаем все строки (как keep-alive) и классифицируем чистой функцией.
// Один источник правила — значит расхождения «SQL против кода» тут не бывает по построению.

import type { BankAccountInfo } from './bankTokenStore'
import { isPendingAccountKey } from '../../app/utils/bankAccountKey'
import {
  bankDeathSinceMs,
  bankFleetBreach,
  bankReaperLogLine,
  MAX_BANK_REAP_PER_RUN,
  reapVerdict,
  type BankReapFacts
} from '../../app/utils/bankReaper'
import { portalHash } from './telemetryAttributes'

/** Инъектируемые side-effects — правило тестируется без базы. */
export interface BankReaperDeps {
  now: () => number
  /** Все банк-строки со свежестью, БЕЗ расшифровки токенов (`listAllBankAccountInfo`). */
  listAccounts: () => Promise<BankAccountInfo[]>
  /**
   * Удалить ОДНУ строку по неизменяемому `id` со сверкой ключа (`deleteBankTokenById`):
   *   `removed` — стёрли; `gone`/`stale` — строка изменилась под нами (не ошибка).
   */
  remove: (memberId: string, id: number, expectedAccountKey: string) => Promise<'removed' | 'gone' | 'stale'>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

/**
 * Один прогон уборщика.
 *
 * @param days порог в днях (уже прошедший `resolveBankReapDays` — с полом и умолчанием).
 */
export async function runBankReaper(deps: BankReaperDeps, days: number): Promise<BankReapFacts> {
  const nowMs = deps.now()
  const rows = await deps.listAccounts()

  // Ожидающие подключения (`~pending:`) НЕ трогаем: их сносит свой свип (#485) по своим правилам,
  // а у банка нет такого «номера», чтобы говорить о смерти пары.
  const live = rows.filter(r => !isPendingAccountKey(r.accountKey))

  // Кандидат — измеренно-мёртв дольше порога. Метку «когда умер» считаем один раз и переиспользуем.
  const candidates = live
    .map(r => ({ row: r, deathAt: bankDeathSinceMs(r, nowMs) }))
    .filter((x): x is { row: BankAccountInfo, deathAt: number } =>
      x.deathAt !== null && reapVerdict(x.deathAt, nowMs, days) === 'reap')
    // Самые давно-мёртвые первыми — если упрёмся в потолок, стираем сначала их.
    .sort((a, b) => a.deathAt - b.deathAt)

  const s: BankReapFacts = {
    candidates: candidates.length, reaped: 0, failed: 0, skipped: 0, capped: false, breach: false, days
  }

  // ⚠ Предохранитель ДО любого удаления: если измеренно-мёртвыми выглядит заметная доля ВСЕХ
  // подключений, дело почти наверняка в нас (сломали разбор согласия, разъехались часы), а не в
  // клиентах. Правильное действие — не стирать вовсе и закричать.
  if (s.candidates > 0 && bankFleetBreach(s.candidates, live.length)) {
    s.breach = true
    deps.warn?.(`уборщик подключений ОСТАНОВЛЕН: измеренно-мёртвыми выглядят ${s.candidates} из ${live.length} — `
      + `слишком большая доля. Похоже на нашу поломку, а не на уход клиентов. Ничего не стёрто`)
    deps.log?.(bankReaperLogLine(s))
    return s
  }

  for (const { row } of candidates) {
    if (s.reaped >= MAX_BANK_REAP_PER_RUN) {
      s.capped = true
      break
    }
    try {
      const res = await deps.remove(row.memberId, row.id, row.accountKey)
      if (res === 'removed') {
        s.reaped++
        // ⚠ Каждое удаление — отдельной строкой c НЕОБРАТИМОЙ меткой портала (не сырым member_id):
        // строка исчезает, и лог остаётся единственным пережившим упоминанием, что мы держали
        // банковский доступ этого портала. Номер счёта в лог не пишем (ПДн).
        deps.warn?.(`подключение стёрто: портал ${portalHash(row.memberId)}, банк ${row.provider}, мёртво дольше ${days} дн.`)
      } else {
        // `gone`/`stale`: между классификацией и удалением строку отключили или переразметили.
        s.skipped++
      }
    } catch (e) {
      s.failed++
      deps.warn?.(`не удалось стереть подключение (портал ${portalHash(row.memberId)}, банк ${row.provider}): ${(e as Error)?.message ?? String(e)}`)
    }
  }

  deps.log?.(bankReaperLogLine(s))
  return s
}
