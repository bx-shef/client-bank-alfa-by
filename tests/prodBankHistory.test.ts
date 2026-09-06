import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expiredCause } from '../app/utils/bankTokenLifetime'

// Гард диагностики «продлевал ли крон банк-токен» (#488).
//
// ⚠ Скрипт ПОВТОРЯЕТ правило `expiredCause` в SQL — иначе он не мог бы отвечать после перевыката,
// когда лог уже стёрт, а база ещё помнит. Повтор осознанный, и именно поэтому он опасен: две
// копии одного правила расходятся молча, а разойтись они могут только в одну сторону — скрипт
// скажет «дело не в банке» там, где банк отказал, и владелец пойдёт искать поломку у нас. Или
// наоборот, и тогда он пойдёт переподключать счёт, который сломан на нашей стороне.

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'prod-bank-history.sh'), 'utf8')

/**
 * Зеркало SQL-условия из скрипта. Держится РЯДОМ с проверкой направления ниже: без структурной
 * проверки зеркало доказывало бы лишь то, что я дважды написал одно и то же в этом файле.
 */
const sqlCause = (lastAttemptAtMs: number, updatedAtMs: number): 'bank-refused' | 'never-tried' =>
  lastAttemptAtMs > 0 && lastAttemptAtMs > updatedAtMs ? 'bank-refused' : 'never-tried'

describe('диагностика истории банк-подключений (#488)', () => {
  it('скрипт читается и ничего не пишет в базу', () => {
    expect(SCRIPT.length).toBeGreaterThan(500)
    // ⚠ Необратимых команд здесь быть не должно вовсе: скрипт запускают в аварии, впопыхах и с
    // телефона. «Сухой прогон» флагом означал бы, что один неверный булев стирает подключение.
    expect(SCRIPT).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER)\s/i)
  })

  it('SQL сравнивает попытку с УСПЕХОМ, а не с текущим временем', () => {
    // Направление — вся суть правила. Перевернув его, получим уверенный ответ наоборот.
    expect(SCRIPT).toContain('last_attempt_at > (extract(epoch FROM updated_at) * 1000)')
    expect(SCRIPT).toContain('last_attempt_at > 0')
  })

  it('SQL-правило совпадает с `expiredCause` на всех значащих случаях', () => {
    const cases: Array<{ attempt: number, success: number }> = [
      { attempt: 0, success: 1_000 }, // не пробовали ни разу
      { attempt: 2_000, success: 1_000 }, // попытка ПОЗЖЕ успеха — банк отказал
      { attempt: 1_000, success: 2_000 }, // попытка РАНЬШЕ успеха — с тех пор не ходили
      { attempt: 1_000, success: 1_000 }, // ровно совпали — не считаем отказом банка
      { attempt: 1, success: 0 } // успеха не было, попытка была
    ]
    for (const { attempt, success } of cases) {
      expect(
        sqlCause(attempt, success),
        `attempt=${attempt} success=${success}`
      ).toBe(expiredCause({ connectedAt: success, lastAttemptAt: attempt } as never, 0))
    }
  })

  it('пустая таблица объявляется АВАРИЕЙ, а не пустым экраном', () => {
    // ⚠ Ровно так выглядел простой 2026-08-26: подключений не стало, и четыре дня это читалось как
    // «ничего не происходит». Диагностика обязана называть пустоту находкой.
    expect(SCRIPT).toContain('НЕТ НИ ОДНОГО банковского подключения')
    expect(SCRIPT).toMatch(/это авария, а не пустой экран/)
  })

  it('номер счёта маскируется — строку пересылают в чат, а репозиторий публичный', () => {
    expect(SCRIPT).toContain('left(account_key, 6)')
    expect(SCRIPT).toContain('right(account_key, 4)')
  })
})
