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
    return { status: 200, body: { ok: true, ...summarizeBankHealth(rows, io.now(), io.hashPortal) } }
  } catch (e) {
    io.warn?.(`[ops] bank-health read failed: ${(e as Error)?.message ?? ''}`)
    return { status: 503, body: { ok: false, error: READ_FAILED } }
  }
}
