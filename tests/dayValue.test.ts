import { describe, expect, it } from 'vitest'
import { dayVerdictMessage, isIsoDay, isoDayFromMs, MAX_POLL_DAY_AGE_DAYS, pollDayVerdict, toIsoDay } from '../app/utils/dayValue'

describe('день как строка ГГГГ-ММ-ДД', () => {
  it('несуществующая дата днём НЕ считается', () => {
    // ⚠ Одной маски мало: `2026-02-31` ей соответствует, а такого дня нет. Уйдя в банк, он вернул бы
    // пустоту, и это читалось бы как «за день операций не было».
    expect(isIsoDay('2026-08-17')).toBe(true)
    expect(isIsoDay('2026-02-31')).toBe(false)
    expect(isIsoDay('2026-13-01')).toBe(false)
    expect(isIsoDay('17.08.2026')).toBe(false)
    expect(isIsoDay('')).toBe(false)
  })

  it('части календаря дополняются нулями', () => {
    expect(toIsoDay({ year: 2026, month: 8, day: 7 })).toBe('2026-08-07')
  })

  it('день считается по UTC — тем же способом, что окно опроса', () => {
    expect(isoDayFromMs(Date.parse('2026-08-17T23:30:00Z'))).toBe('2026-08-17')
  })
})

describe('годится ли день для ручного забора', () => {
  const today = '2026-08-22'

  it('сегодня разрешён — это самый частый случай', () => {
    // ⚠ «Провёл платёж, хочу увидеть его сейчас»: банк отдаёт операции текущих суток по мере их
    // появления, и запрет сегодняшнего дня убрал бы ровно то, ради чего кнопку и нажимают.
    expect(pollDayVerdict(today, today)).toBe('ok')
  })

  it('будущее отвергается', () => {
    expect(pollDayVerdict('2026-08-23', today)).toBe('future')
  })

  it('прошлое в пределах глубины разрешено, за ней — нет', () => {
    expect(pollDayVerdict('2026-08-17', today)).toBe('ok')
    const edge = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_POLL_DAY_AGE_DAYS * 86_400_000)
    expect(pollDayVerdict(edge.toISOString().slice(0, 10), today), 'ровно граница').toBe('ok')
    const past = new Date(Date.parse(`${today}T00:00:00Z`) - (MAX_POLL_DAY_AGE_DAYS + 1) * 86_400_000)
    expect(pollDayVerdict(past.toISOString().slice(0, 10), today)).toBe('too-old')
    // ⚠ Опечатка в годе — самый дорогой промах: без верхней границы она молча сжигает запрос из
    // общего лимита банка и возвращает пустоту, неотличимую от «операций не было».
    expect(pollDayVerdict('1926-08-17', today)).toBe('too-old')
  })

  it('кривая строка — отдельный исход, а не «слишком давно»', () => {
    expect(pollDayVerdict('вчера', today)).toBe('malformed')
  })

  it('у каждого отказа есть объяснение, а у «ok» его нет', () => {
    for (const v of ['malformed', 'future', 'too-old'] as const) {
      expect(dayVerdictMessage(v), v).not.toBe('')
    }
    expect(dayVerdictMessage('ok')).toBe('')
  })
})
