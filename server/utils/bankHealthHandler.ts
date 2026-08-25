// Чистое ядро `GET /api/ops/bank-health` (#497 §3) — по образцу `setupStatus.ts`/`pollNow.ts`.
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Вся ценность этого роута в ОДНОЙ ветке: когда база недоступна, он обязан
// ответить 503, а не пустой сводкой — «ноль подключений» читалось бы как «всё спокойно» ровно
// тогда, когда спокойно точно не всё. Пока эта ветка была зашита в `defineEventHandler` поверх
// живого `dbQuery`, её нельзя было проверить ничем: провалить такую мутацию физически некому.

import { summarizeBankHealth, type BankHealthOverview, type BankHealthRow } from '../../app/utils/bankHealthOverview'

export interface BankHealthIO {
  /** Строки `bank_tokens` по ВСЕМ порталам (без токенов). Бросает — значит база недоступна. */
  listRows: () => Promise<BankHealthRow[]>
  now: () => number
  /** Необратимая метка портала. Инъектируется, чтобы чистое ядро не тянуло `node:crypto`. */
  hashPortal: (memberId: string) => string
  /**
   * Порталы с истёкшей подпиской на REST (#614) — `member_id` → когда отказ случился ВПЕРВЫЕ.
   *
   * ⚠ Необязательна, и отсутствие означает «раздел пуст», а не «сломано». Но живая проводка её
   * ВСЕГДА даёт: без этого раздела состояние не видно НИГДЕ — клиент до приложения не доберётся
   * (оно открывается внутри Битрикса, а подписка мертва), а сам он отключиться не сможет.
   */
  listSubscriptionEnded?: () => Promise<{ memberId: string, endedAtMs: number }[]>
  /** Диагностика для оператора; наружу текст ошибки не отдаём. */
  warn?: (message: string) => void
}

export interface BankHealthResult {
  status: number
  body: ({ ok: true } & BankHealthOverview) | { ok: false, error: string }
}

/** Текст отказа. Фиксированный: сообщение pg несёт хост/порт базы, имена таблиц и колонок при
 *  рассинхроне схемы, иногда имя пользователя БД — ничего этого в теле ответа быть не должно. */
export const READ_FAILED = 'не удалось прочитать состояние подключений'

/**
 * Собрать сводку. Авторизацию проверяет роут — здесь её нет намеренно: гейт операторской сессии
 * общий для всех `/api/ops/*` и живёт рядом с чтением куки, а не в доменной логике.
 */
export async function handleBankHealth(io: BankHealthIO): Promise<BankHealthResult> {
  try {
    const rows = await io.listRows()
    // ⚠ Отдельным try: истёкшая подписка — ДОПОЛНЕНИЕ к сводке, и её недоступность не должна
    // уносить всю карточку. Тот же принцип, что у изоляции банковских строк от проверки очередей.
    let subs: ReadonlyMap<string, number> | undefined
    try {
      const list = await io.listSubscriptionEnded?.()
      if (list) subs = new Map(list.map(r => [r.memberId, r.endedAtMs]))
    } catch (e) {
      io.warn?.(`[ops] subscription-ended read failed: ${(e as Error)?.message ?? ''}`)
    }
    return { status: 200, body: { ok: true, ...summarizeBankHealth(rows, io.now(), io.hashPortal, subs) } }
  } catch (e) {
    io.warn?.(`[ops] bank-health read failed: ${(e as Error)?.message ?? ''}`)
    return { status: 503, body: { ok: false, error: READ_FAILED } }
  }
}
