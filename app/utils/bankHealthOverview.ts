// Обзор состояния банковских подключений ДЛЯ НАС, а не для клиента (#497 §3).
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ БЕЙДЖА В НАСТРОЙКАХ. Админ портала видит свои подключения и понимает, что с
// ними; мы не видим ничего. Умирающее подключение сегодня узнаётся по факту неработающего импорта —
// то есть позже клиента, а критерий приёмки тестовой эксплуатации сформулирован ровно наоборот:
// «бухгалтер видит свои платежи, а МЫ видим его проблемы».
//
// ⚠ ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: номеров счетов, названий порталов, доменов. Оператор смотрит на этот
// экран, чтобы понять «что-то ломается и у скольких», а не чтобы читать реквизиты чужих компаний.
// Порталы различаются короткой солёной меткой (`portalHash`), которой достаточно, чтобы отличить
// два портала друг от друга и сопоставить строку с логом, и недостаточно, чтобы кого-то опознать.
// Это та же граница, что и в телеметрии (`docs/PRIVACY.md`, `SAFE_MANUAL_ATTR_KEYS`).
//
// Чистое ядро: вход — уже загруженные строки, выход — счётчики. Ни I/O, ни расшифровки.

import type { BankProviderId } from '~/types/statement'
import { connectionHealth, type BankConnectionHealth } from '~/utils/bankTokenLifetime'
import { isPendingAccountKey } from '~/utils/bankAccountKey'

/** Одна строка `bank_tokens` в том виде, в каком её отдаёт стор (без токенов). */
export interface BankHealthRow {
  memberId: string
  provider: BankProviderId
  accountKey: string
  connectedAt: number
  expiresAt: number
  hasRefresh: boolean
}

/** Сводка по одному состоянию: сколько подключений и на скольких порталах. */
export interface HealthBucket {
  connections: number
  portals: number
}

export interface BankHealthOverview {
  /** По состоянию (`ok`/`due`/`expired`/`no-refresh`/`unknown`). */
  byHealth: Record<BankConnectionHealth, HealthBucket>
  /** Подключения, у которых админ ещё не выбрал счёт (#407) — они не опрашиваются. */
  pending: HealthBucket
  /** Всего строк и всего порталов с подключениями. */
  total: HealthBucket
  /**
   * Порталы, у которых ХОТЯ БЫ ОДНО подключение требует человека (`expired`/`no-refresh`).
   * Отдельно от счётчиков намеренно: чинится это не «в среднем по больнице», а походом к
   * конкретному клиенту, поэтому важно их число, а не число строк.
   */
  needAttention: number
}

function emptyBucket(): HealthBucket {
  return { connections: 0, portals: 0 }
}

/**
 * Свернуть строки в обзор. `nowMs` передаётся, а не берётся из часов: функция чистая, и тест не
 * должен зависеть от того, когда его запустили.
 *
 * ⚠ Ожидающие подключения (`~pending:`) СЧИТАЮТСЯ ОТДЕЛЬНО и не попадают в состояния. Формально
 * они живы, но опрашивать по ним нечего — у банка нет такого «номера». Смешав их с `ok`, экран
 * показывал бы здоровье там, где настройка не закончена.
 */
export function summarizeBankHealth(rows: readonly BankHealthRow[], nowMs: number): BankHealthOverview {
  const byHealth = {
    'ok': emptyBucket(),
    'due': emptyBucket(),
    'expired': emptyBucket(),
    'no-refresh': emptyBucket(),
    'unknown': emptyBucket()
  } as Record<BankConnectionHealth, HealthBucket>
  const portalsBy = new Map<BankConnectionHealth, Set<string>>()
  const pendingPortals = new Set<string>()
  const allPortals = new Set<string>()
  const attention = new Set<string>()
  const pending = emptyBucket()

  for (const row of rows) {
    allPortals.add(row.memberId)
    if (isPendingAccountKey(row.accountKey)) {
      pending.connections += 1
      pendingPortals.add(row.memberId)
      continue
    }
    const health = connectionHealth(row, nowMs)
    byHealth[health].connections += 1
    const set = portalsBy.get(health) ?? new Set<string>()
    set.add(row.memberId)
    portalsBy.set(health, set)
    if (health === 'expired' || health === 'no-refresh') attention.add(row.memberId)
  }

  for (const [health, set] of portalsBy) byHealth[health].portals = set.size
  pending.portals = pendingPortals.size

  return {
    byHealth,
    pending,
    total: { connections: rows.length, portals: allPortals.size },
    needAttention: attention.size
  }
}

/** Порядок показа: сначала то, что требует человека. Экран, начинающийся с «всё хорошо»,
 *  прячет единственную строку, ради которой его открыли. */
export const HEALTH_ORDER: readonly BankConnectionHealth[] = ['no-refresh', 'expired', 'due', 'unknown', 'ok']

/** Подписи состояний для экрана оператора — короче клиентских: оператор знает предметную область,
 *  ему нужен ярлык, а не объяснение. */
export const HEALTH_TITLE: Record<BankConnectionHealth, string> = {
  'no-refresh': 'нужно переподключить',
  'expired': 'истекло',
  'due': 'скоро обновим',
  'unknown': 'срок неизвестен',
  'ok': 'в порядке'
}
