import { describe, expect, it } from 'vitest'
import { MISSED_TICKS_BEFORE_ALARM, pulseAgeMs, pulseState, type KeepAlivePulse } from '../app/utils/keepAlivePulse'
import { evaluateKeepAlivePulse } from '../server/utils/bankHealthAlert'

// Пульс продления банковских токенов (#504). Продление — голый `setInterval`, а не задача очереди,
// поэтому его остановка невидима всеми существующими способами: алертинг читает только очереди,
// экран готовности смотрит на факт строки, бейдж в настройках надо открыть.

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const INTERVAL = HOUR // штатная каденция продления

const pulse = (agoMs: number): KeepAlivePulse => ({
  atMs: NOW - agoMs,
  summary: { selected: 2, refreshed: 2, skipped: 0, failed: 0, unrefreshable: 0, expired: 0 }
})

describe('pulseState', () => {
  it('свежий пульс — ok', () => {
    expect(pulseState(pulse(10 * 60_000), NOW, INTERVAL)).toBe('ok')
  })

  it('прогонов ещё не было и процесс только поднялся — «never», это НЕ «сломалось»', () => {
    expect(pulseState(null, NOW, INTERVAL)).toBe('never')
    expect(pulseState(null, NOW, INTERVAL, { startedAtMs: NOW - 10 * 60_000 })).toBe('never')
  })

  it('ЭСКАЛАЦИЯ: пульса нет дольше окна с момента старта — это уже stale', () => {
    // ⚠ Без эскалации регрессия «таймер не завёлся вовсе / падает с первого тика» давала бы тишину
    // НАВСЕГДА: тот же «умерли в пятницу, узнали в понедельник», только зайдя с другого конца.
    expect(pulseState(null, NOW, INTERVAL, { startedAtMs: NOW - 5 * HOUR })).toBe('stale')
  })

  it('без известного времени старта эскалации нет — не выдумываем возраст процесса', () => {
    // Роль без крона (`QUEUE_CRON=0`) таймер не запускает вовсе, и тревожить по ней не о чем.
    expect(pulseState(null, NOW, INTERVAL, { startedAtMs: null })).toBe('never')
  })

  it('один пропущенный тик — ещё не авария', () => {
    // Перезапуск контейнера, выкат, тик в недоступную на секунду базу — штатная жизнь. Тревога на
    // первом же пропуске приучает игнорировать канал, заведённый ради редкого случая.
    expect(pulseState(pulse(INTERVAL + 60_000), NOW, INTERVAL)).toBe('ok')
  })

  it(`старше ${MISSED_TICKS_BEFORE_ALARM} тиков — stale`, () => {
    expect(pulseState(pulse(INTERVAL * MISSED_TICKS_BEFORE_ALARM + 60_000), NOW, INTERVAL)).toBe('stale')
  })

  it('ровно на границе ещё ok — тревога строго ПОСЛЕ порога', () => {
    expect(pulseState(pulse(INTERVAL * MISSED_TICKS_BEFORE_ALARM), NOW, INTERVAL)).toBe('ok')
  })

  it('порог тревоги короче ночи — иначе подключение умрёт раньше, чем мы узнаем', () => {
    // Смысл всей задачи: подключение Альфы умирает за ночь. Порог обязан быть заметно меньше.
    expect(INTERVAL * MISSED_TICKS_BEFORE_ALARM).toBeLessThan(8 * HOUR)
  })

  it('кривой интервал НЕ превращается в «всё протухло»', () => {
    // Опечатка в env иначе стала бы неотличима от настоящей аварии, и канал получил бы тревогу на
    // каждом тике. Кривой интервал — повод для envCheck, а не для ложного пейджа.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pulseState(pulse(50 * HOUR), NOW, bad), String(bad)).toBe('ok')
    }
  })

  it('часы, ушедшие назад, не читаются как древний пульс', () => {
    expect(pulseState({ ...pulse(0), atMs: NOW + HOUR }, NOW, INTERVAL)).toBe('ok')
  })
})

describe('pulseAgeMs', () => {
  it('возраст в мс, null — прогонов не было', () => {
    expect(pulseAgeMs(pulse(5 * 60_000), NOW)).toBe(5 * 60_000)
    expect(pulseAgeMs(null, NOW)).toBeNull()
  })
})

describe('evaluateKeepAlivePulse', () => {
  it('живой пульс — тишина', () => {
    expect(evaluateKeepAlivePulse(pulse(10 * 60_000), NOW, INTERVAL)).toEqual([])
  })

  it('«ещё не было прогонов» сразу после старта тревогой НЕ считается', () => {
    // Иначе каждый рестарт процесса пейджил бы оператора.
    expect(evaluateKeepAlivePulse(null, NOW, INTERVAL)).toEqual([])
    expect(evaluateKeepAlivePulse(null, NOW, INTERVAL, NOW - 10 * 60_000)).toEqual([])
  })

  it('таймер не завёлся вовсе — тревога говорит «ни разу», а не выдуманные часы', () => {
    const [a] = evaluateKeepAlivePulse(null, NOW, INTERVAL, NOW - 5 * HOUR)
    expect(a?.kind).toBe('keepalive-stale')
    expect(a?.text).toContain('НИ РАЗУ')
    expect(a?.text).not.toMatch(/\d+ час/)
  })

  it('протухший пульс — тревога с возрастом и с указанием, что чинить НАМ', () => {
    const [a] = evaluateKeepAlivePulse(pulse(5 * HOUR), NOW, INTERVAL)
    expect(a?.kind).toBe('keepalive-stale')
    expect(a?.text).toContain('5 часов')
    expect(a?.text).toContain('НЕ отказ банка')
  })

  it('склонение часов — по русским правилам', () => {
    expect(evaluateKeepAlivePulse(pulse(4 * HOUR), NOW, INTERVAL)[0]?.text).toContain('4 часа')
    expect(evaluateKeepAlivePulse(pulse(21 * HOUR), NOW, INTERVAL)[0]?.text).toContain('21 час')
  })

  it('ОТДЕЛЬНЫЙ эпизод от мёртвых подключений — это разные диагнозы', () => {
    // «Банк нас отверг» чинит владелец счёта в интернет-банке; «наша машинерия встала» чиним мы.
    // Один эпизод на двоих отправил бы оператора не туда.
    const [a] = evaluateKeepAlivePulse(pulse(5 * HOUR), NOW, INTERVAL)
    expect(a?.queue).toBe('bank-keepalive')
    expect(a?.kind).not.toBe('bank-dead')
  })

  it('в тексте нет ни счетов, ни member_id — канал внешний', () => {
    const text = evaluateKeepAlivePulse(pulse(5 * HOUR), NOW, INTERVAL).map(a => a.text).join('')
    expect(text).not.toMatch(/BY\d|member/i)
  })
})
