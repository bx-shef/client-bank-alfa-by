import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BANK_REFRESH_TTL_MEASURED, BANK_REFRESH_TTL_SEC, KEEP_ALIVE_BAND, expiredCause } from '../app/utils/bankTokenLifetime'

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

// Гард на КЛАСС ошибки, а не на один скрипт (#488, поймано живым запуском 2026-09-06).
//
// ⚠ Обе прод-диагностики, читающие базу, подставляли `${POSTGRES_USER:-postgres}` — а compose
// задаёт `app`/`app` ЖЁСТКО, и переменных этих в шелле оператора нет вовсе. Значит подстановка
// всегда давала `postgres`, psql всегда падал, а `2>/dev/null` прятал причину: `make reap-status`
// не работал НИ РАЗУ с рождения и печатал «не смог прочитать базу» при здоровом Postgres.
// Отказ такого рода неотличим от настоящей аварии — и это худший вид поломки диагностики.
describe('прод-скрипты не угадывают креды базы и не прячут её ответ', () => {
  const DB_SCRIPTS = ['prod-bank-history.sh', 'prod-reap-status.sh']

  /**
   * Тело скрипта без строк-комментариев.
   *
   * ⚠ Нужно потому, что комментарии в этих скриптах ЦИТИРУЮТ сломанные формы, объясняя, чем они
   * были плохи. Проверка по сырому тексту краснела бы на самом разборе ошибки — то есть запрещала
   * бы её описывать, и следующий автор повторил бы её, не найдя ни строчки объяснения.
   */
  const code = (src: string): string =>
    src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

  for (const name of DB_SCRIPTS) {
    const src = code(readFileSync(join(ROOT, 'scripts', name), 'utf8'))

    it(`${name}: креды берутся из контейнера, а не угадываются`, () => {
      // Значение по умолчанию тут — сама ошибка: `compose` задаёт `app`/`app` жёстко, в шелле
      // оператора этих переменных нет, поэтому подстановка ВСЕГДА даёт литерал и psql всегда падает.
      expect(src).not.toMatch(/POSTGRES_(USER|DB):-/)
      expect(src).toContain('psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"')
    })

    it(`${name}: ответ Postgres показывается, а не глушится`, () => {
      // ⚠ Запрещаем глушение ИМЕННО у psql, а не везде: `cd … 2>/dev/null` законен, и общий запрет
      // заставил бы обходить гард вместо того, чтобы его соблюдать.
      const muted = src.split('\n').filter(l => l.includes('psql') && l.includes('2>/dev/null'))
      expect(muted, 'psql не должен уходить в /dev/null — иначе «не смог» без причины').toEqual([])
      expect(src).toMatch(/Что ответил Postgres/)
    })
  }
})

// Сроки жизни токена ПОВТОРЕНЫ в SQL — иначе скрипт не смог бы решить, произносить ли причину.
// Копия опасна ровно тем же, чем копия правила: разъедется молча, и совет «переподключите» уедет
// не туда. Держим числа сверкой с исходником.
describe('сроки в SQL совпадают с `bankTokenLifetime` (#488)', () => {
  const SQL = readFileSync(join(ROOT, 'scripts', 'prod-bank-history.sh'), 'utf8')

  it('срок Альфы и Приора взят из кода, а не выдуман', () => {
    expect(BANK_REFRESH_TTL_SEC['alfa-by']).toBe(36000)
    expect(BANK_REFRESH_TTL_SEC['prior-by']).toBe(43200)
    expect(SQL).toContain('CASE provider WHEN \'alfa-by\' THEN 36000 ELSE 43200 END')
  })

  it('полоса продления та же', () => {
    expect(KEEP_ALIVE_BAND).toBe(0.5)
    expect(SQL).toContain('END * 0.5')
  })

  it('«истекло» произносится только про ИЗМЕРЕННЫЙ срок', () => {
    // ⚠ У Приора срок — догадка (`BANK_REFRESH_TTL_MEASURED['prior-by'] === false`), и хоронить по
    // ней значит слать владельца счёта в интернет-банк за тем, что не ломалось.
    expect(BANK_REFRESH_TTL_MEASURED['alfa-by']).toBe(true)
    expect(BANK_REFRESH_TTL_MEASURED['prior-by']).toBe(false)
    expect(SQL).toContain('CASE provider WHEN \'alfa-by\' THEN \'expired\' ELSE \'due\' END')
  })

  it('причина произносится ТОЛЬКО у истёкшего подключения', () => {
    // ⚠ Живой прогон 2026-09-06: первая редакция посоветовала переподключить Приора, у которого
    // последняя удачная пара была два часа назад. В коде причину спрашивают под `h === 'expired'`.
    const verdict = SQL.slice(SQL.indexOf('case "$health" in'))
    expect(verdict).toMatch(/expired\)[\s\S]*bank-refused/)
    expect(SQL).toContain('Живо, продление в срок')
    // Ветки здорового состояния обязаны существовать — без них «ok» падал бы в общий совет.
    for (const branch of ['no-refresh)', 'due)', 'ok)']) expect(verdict).toContain(branch)
  })

  it('согласие банка перекрывает оценки по возрасту токена', () => {
    // Это дата САМОГО банка, а не наша оценка: вышла — обновлять нечего, порядок веток несущий.
    const health = SQL.slice(SQL.indexOf('CASE\n      WHEN consent_expires_at'))
    expect(health.indexOf('consent_expires_at')).toBeLessThan(health.indexOf('refresh_token_enc'))
  })
})
