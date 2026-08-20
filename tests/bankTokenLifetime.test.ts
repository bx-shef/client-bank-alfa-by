import { describe, expect, it } from 'vitest'
import {
  BANK_REFRESH_TTL_MEASURED, BANK_REFRESH_TTL_SEC, connectionHealth, connectionHealthBadge, refreshAtAgeMs,
  consentExpiringSoon,
  CONSENT_WARN_DAYS
} from '../app/utils/bankTokenLifetime'

// ⚠ Эти числа читают ДВА потребителя: сервер решает по ним, кого обновлять, интерфейс — что
// показать администратору. Разъехавшись, они дали бы зелёную строку на подключении, которое
// сервер уже похоронил, — то есть ровно ту беду, ради которой всё и писалось (#488).

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const c = (over: Partial<Parameters<typeof connectionHealth>[0]> = {}) =>
  ({ provider: 'alfa-by' as const, connectedAt: NOW - HOUR, hasRefresh: true, ...over })

describe('connectionHealth', () => {
  it('свежее подключение — «ok», и бейджа у него нет', () => {
    // Значок на каждой исправной строке приучает не читать значки.
    expect(connectionHealth(c(), NOW)).toBe('ok')
    expect(connectionHealthBadge('ok')).toBeNull()
  })

  it('в полосе обновления — «due», и человеку сказано, что делать НИЧЕГО не надо', () => {
    expect(connectionHealth(c({ connectedAt: NOW - 9 * HOUR }), NOW)).toBe('due')
    expect(connectionHealthBadge('due')?.hint).toContain('Действий не требуется')
  })

  it('старше всего срока жизни — «expired», и сказано, что нужен владелец счёта', () => {
    expect(connectionHealth(c({ connectedAt: NOW - 11 * HOUR }), NOW)).toBe('expired')
    expect(connectionHealthBadge('expired')?.hint).toContain('интернет-банк')
  })

  it('без refresh-токена — «no-refresh» ДАЖЕ если подключение свежее', () => {
    // Возраст тут ни при чём: продлевать нечем с самого начала.
    expect(connectionHealth(c({ hasRefresh: false, connectedAt: NOW }), NOW)).toBe('no-refresh')
  })

  it('неизвестный срок жизни — молчим, а не гадаем', () => {
    expect(connectionHealth(c({ provider: 'manual' }), NOW)).toBe('unknown')
    expect(connectionHealthBadge('unknown')).toBeNull()
  })

  it('метка времени из будущего — «unknown», а не «свежайшее»', () => {
    // Расхождение часов не должно читаться как подтверждение здоровья.
    expect(connectionHealth(c({ connectedAt: NOW + HOUR }), NOW)).toBe('unknown')
    expect(connectionHealth(c({ connectedAt: Number.NaN }), NOW)).toBe('unknown')
  })

  it('границы ВКЛЮЧИТЕЛЬНЫЕ на обоих порогах', () => {
    expect(connectionHealth(c({ connectedAt: NOW - 8 * HOUR }), NOW)).toBe('due')
    expect(connectionHealth(c({ connectedAt: NOW - 10 * HOUR }), NOW)).toBe('expired')
  })

  it('цвет бейджа НЕСЁТ СМЫСЛ — три состояния тремя разными цветами', () => {
    // `alert` = «действуй сейчас, импорт стоит», `warning` = «однажды встанет»,
    // `accent` = «мы уже это делаем, тебя не касается». Сваленные в один цвет, они перестают
    // отличаться, и человек перестаёт их читать.
    expect(connectionHealthBadge('no-refresh')).toMatchObject({ label: 'нужно переподключить', color: 'air-primary-warning' })
    expect(connectionHealthBadge('expired')?.color).toBe('air-primary-alert')
    expect(connectionHealthBadge('due')?.color).toBe('air-secondary-accent')
  })

  it('порог обновления — ПОЛОВИНА срока жизни провайдера', () => {
    // ⚠ Было 80 % (#489). Живой прогон показал цену: при полосе 0.2 окно, в котором обновление
    // вообще возможно, для Альфы составляло 8..10 часов — ДВА часовых тика. Любой перерыв длиннее
    // двух часов ровно в этом окне (деплой, простой Redis, остановка крон-инстанса) означал, что
    // подключение перевалит за срок, а лечится это походом ВЛАДЕЛЬЦА СЧЁТА в интернет-банк.
    // Половина срока даёт пять шансов вместо двух ценой примерно вдвое большего числа обращений
    // за токеном — на фоне лимита банка (80/мин) это неизмеримо мало.
    expect(refreshAtAgeMs('alfa-by')).toBe(5 * HOUR)
    expect(BANK_REFRESH_TTL_SEC['alfa-by']).toBe(36_000)
  })
})

describe('измеренный срок против угаданного', () => {
  it('⚠ «истекло» произносим ТОЛЬКО про измеренный срок', () => {
    // У Альфы срок подтверждён живым отказом банка (#488) — там «истекло» это факт.
    expect(connectionHealth({ provider: 'alfa-by', connectedAt: NOW - 11 * HOUR, hasRefresh: true }, NOW)).toBe('expired')
    // У Приора он УГАДАН. Ложная надпись «истекло» стоит человеку похода в интернет-банк за тем,
    // что не ломалось, поэтому потолок остаётся «пора обновить»: приложение попробует само, и
    // состояние станет честным по ответу банка, а не по нашей догадке (#503).
    expect(connectionHealth({ provider: 'prior-by', connectedAt: NOW - 99 * HOUR, hasRefresh: true }, NOW)).toBe('due')
  })

  it('таблица «измерено ли» исчерпывающая — новый банк не проскочит молча', () => {
    expect(BANK_REFRESH_TTL_MEASURED['alfa-by']).toBe(true)
    expect(BANK_REFRESH_TTL_MEASURED['prior-by']).toBe(false)
    expect(Object.keys(BANK_REFRESH_TTL_MEASURED).sort()).toEqual(Object.keys(BANK_REFRESH_TTL_SEC).sort())
  })
})

describe('согласие банка перекрывает оценку по refresh (#503)', () => {
  // ⚠ Два РАЗНЫХ срока: refresh-токен и согласие. У Приора согласие живёт ~90 дней, и когда оно
  // вышло, обновление токена не поможет ничем — нужен вход владельца счёта в интернет-банк.
  // Свежий refresh при истёкшем согласии выглядит здоровым и не работает.
  const T = 1_700_000_000_000
  const DAY = 86_400_000

  it('согласие истекло — «истекло», даже если токен только что обновлён', () => {
    expect(connectionHealth(
      { provider: 'prior-by', connectedAt: T, hasRefresh: true, consentExpiresAt: T - 1 }, T
    )).toBe('expired')
  })

  it('согласие истекло — перекрывает и «нет refresh-токена»', () => {
    // Оба состояния требуют человека, но причина у них разная: «переподключите» против
    // «согласие кончилось». Побеждает то, что сказал банк.
    expect(connectionHealth(
      { provider: 'prior-by', connectedAt: T, hasRefresh: false, consentExpiresAt: T - 1 }, T
    )).toBe('expired')
  })

  it('согласие ещё живо — решает обычное правило', () => {
    expect(connectionHealth(
      { provider: 'prior-by', connectedAt: T, hasRefresh: true, consentExpiresAt: T + 30 * DAY }, T
    )).toBe('ok')
  })

  it('ДАТЫ НЕТ ⇒ «неизвестно», а не «истекло»', () => {
    // Умолчание решает исход для всех подключений без даты: у Альфы согласия нет вовсе, а Приор,
    // подключённый до #503, её не хранит. «Не знаем ⇒ истекло» разом объявило бы их мёртвыми.
    for (const v of [undefined, 0, Number.NaN, -1]) {
      expect(connectionHealth(
        { provider: 'alfa-by', connectedAt: T, hasRefresh: true, consentExpiresAt: v as number }, T
      ), String(v)).toBe('ok')
    }
  })

  it('порог «скоро истечёт» — неделя, а не день', () => {
    // Продлевает согласие НЕ администратор, а владелец счёта в интернет-банке; за вечер такое
    // не организуешь, и предупреждение за день было бы уведомлением об уже случившемся простое.
    const c = (at: number) => ({ provider: 'prior-by' as const, connectedAt: T, hasRefresh: true, consentExpiresAt: at })
    expect(consentExpiringSoon(c(T + 3 * DAY), T)).toBe(true)
    expect(consentExpiringSoon(c(T + 30 * DAY), T)).toBe(false)
    expect(CONSENT_WARN_DAYS).toBeGreaterThanOrEqual(7)
  })

  it('уже истёкшее — не «скоро истечёт»: это разные сообщения', () => {
    expect(consentExpiringSoon(
      { provider: 'prior-by', connectedAt: T, hasRefresh: true, consentExpiresAt: T - 1 }, T
    )).toBe(false)
  })

  it('без даты «скоро истечёт» не срабатывает', () => {
    expect(consentExpiringSoon({ provider: 'alfa-by', connectedAt: T, hasRefresh: true }, T)).toBe(false)
  })
})
