import { describe, expect, it } from 'vitest'
import {
  OPERATION_PERIOD_PRESETS,
  DEFAULT_OPERATION_PERIOD,
  operationPeriodRange,
  operationPeriodCaption,
  formatIsoDayRu,
  isValidDayRange,
  shiftIsoDay,
  todayIsoDay
} from '../app/utils/operationPeriod'

// Период показа «Последних операций» (#42). Ядро чистое, поэтому «сегодня» всегда передаётся —
// тесты не зависят ни от часов машины, ни от её пояса.

describe('shiftIsoDay', () => {
  it('переходит через границу месяца и года', () => {
    expect(shiftIsoDay('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftIsoDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftIsoDay('2026-08-26', 0)).toBe('2026-08-26')
  })

  it('знает про високосный год', () => {
    expect(shiftIsoDay('2028-03-01', -1)).toBe('2028-02-29')
    expect(shiftIsoDay('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('todayIsoDay', () => {
  it('складывает день из частей даты', () => {
    expect(todayIsoDay(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05')
  })

  // ⚠ Локальные части, а НЕ `toISOString()`: у пояса восточнее UTC (Минск = UTC+3) ранним утром
  // UTC-дата ещё вчерашняя, и «за сегодня» показывало бы вчерашний день.
  //
  // ⚠ Настоящим `new Date(...)` это НЕ проверяется: прогон идёт в UTC, где локальные части и
  // UTC совпадают, и подмена реализации на `toISOString()` проходила зелёной (замерено). Поэтому
  // подставляем объект, у которого две стороны РАСХОДЯТСЯ — так утверждение проверяет именно то,
  // о чём говорит, независимо от пояса машины.
  it('не берёт день из UTC-строки: 01:30 в UTC+3 — это уже сегодня', () => {
    const minskEarlyMorning = {
      getFullYear: () => 2026,
      getMonth: () => 7,
      getDate: () => 26,
      toISOString: () => '2026-08-25T22:30:00.000Z'
    } as unknown as Date
    expect(todayIsoDay(minskEarlyMorning)).toBe('2026-08-26')
  })
})

describe('operationPeriodRange', () => {
  // ⚠ Длина периода СЧИТАЕТ сегодняшний день: «2 дня» — сегодня и вчера. Иначе подпись «за 2 дня»
  // описывала бы три календарных дня.
  it('пресеты считают сегодняшний день внутри периода', () => {
    expect(operationPeriodRange('day', '2026-08-26')).toEqual({ from: '2026-08-26', to: '2026-08-26' })
    expect(operationPeriodRange('days2', '2026-08-26')).toEqual({ from: '2026-08-25', to: '2026-08-26' })
    expect(operationPeriodRange('days3', '2026-08-26')).toEqual({ from: '2026-08-24', to: '2026-08-26' })
    expect(operationPeriodRange('week', '2026-08-26')).toEqual({ from: '2026-08-20', to: '2026-08-26' })
  })

  it('длинные пресеты', () => {
    expect(operationPeriodRange('month', '2026-08-26').from).toBe('2026-07-28')
    expect(operationPeriodRange('quarter', '2026-08-26').from).toBe('2026-05-29')
    expect(operationPeriodRange('year', '2026-08-26').from).toBe('2025-08-27')
  })

  it('custom отдаёт ровно то, что выбрал человек', () => {
    expect(operationPeriodRange('custom', '2026-08-26', { from: '2020-01-01', to: '2020-02-01' }))
      .toEqual({ from: '2020-01-01', to: '2020-02-01' })
  })

  // ⚠ Пустая граница у custom — настоящая настройка «без ограничения с этой стороны», а не «ещё не
  // выбрал»: подставить сегодняшний день значило бы решить за человека, спрашивавшего «всё старше».
  it('custom сохраняет пустые границы', () => {
    expect(operationPeriodRange('custom', '2026-08-26', { from: '2020-01-01', to: '' }))
      .toEqual({ from: '2020-01-01', to: '' })
    expect(operationPeriodRange('custom', '2026-08-26')).toEqual({ from: '', to: '' })
  })
})

describe('operationPeriodCaption', () => {
  it('один день называется днём, а не диапазоном из себя в себя', () => {
    expect(operationPeriodCaption({ from: '2026-08-26', to: '2026-08-26' })).toBe('за 26 августа 2026')
  })

  it('диапазон, полуоткрытые границы и отсутствие границ', () => {
    expect(operationPeriodCaption({ from: '2026-08-20', to: '2026-08-26' }))
      .toBe('с 20 августа 2026 по 26 августа 2026')
    expect(operationPeriodCaption({ from: '2026-08-20', to: '' })).toBe('с 20 августа 2026')
    expect(operationPeriodCaption({ from: '', to: '2026-08-26' })).toBe('по 26 августа 2026')
    expect(operationPeriodCaption({ from: '', to: '' })).toBe('за всё время')
  })

  it('месяц — в родительном падеже (это подпись, а не заголовок таблицы)', () => {
    expect(formatIsoDayRu('2026-01-05')).toBe('5 января 2026')
    expect(formatIsoDayRu('2026-12-31')).toBe('31 декабря 2026')
  })
})

describe('isValidDayRange', () => {
  it('пустые границы допустимы', () => {
    expect(isValidDayRange({ from: '', to: '' })).toBe(true)
    expect(isValidDayRange({ from: '2026-08-01', to: '' })).toBe(true)
  })

  // ⚠ Несуществующий день — ОТКАЗ, а не «спросим без фильтра»: молча отброшенная граница
  // РАСШИРЯЕТ период, и человек увидел бы чужой срок под подписью своего.
  it('несуществующая дата и мусор отвергаются', () => {
    expect(isValidDayRange({ from: '2026-02-31', to: '' })).toBe(false)
    expect(isValidDayRange({ from: '', to: '26.08.2026' })).toBe(false)
  })

  it('перевёрнутый период отвергается, равные границы — нет', () => {
    expect(isValidDayRange({ from: '2026-08-31', to: '2026-08-01' })).toBe(false)
    expect(isValidDayRange({ from: '2026-08-01', to: '2026-08-01' })).toBe(true)
  })
})

describe('пресеты', () => {
  it('в списке есть все восемь вариантов, названных владельцем, и они уникальны', () => {
    const values = OPERATION_PERIOD_PRESETS.map(p => p.value)
    expect(values).toEqual(['day', 'days2', 'days3', 'week', 'month', 'quarter', 'year', 'custom'])
    expect(new Set(values).size).toBe(values.length)
  })

  // ⚠ Длина есть у КАЖДОГО пресета, кроме `custom`: пресет без длины упал бы в фолбэк «один день»
  // молча — экран показал бы сегодняшний день под чужой подписью.
  it('длина задана у всех, кроме custom, и растёт', () => {
    const days = OPERATION_PERIOD_PRESETS.filter(p => p.value !== 'custom').map(p => p.days)
    expect(days.every(d => typeof d === 'number' && d > 0)).toBe(true)
    expect([...days].sort((a, b) => (a as number) - (b as number))).toEqual(days)
    expect(OPERATION_PERIOD_PRESETS.find(p => p.value === 'custom')?.days).toBeNull()
  })

  it('период по умолчанию — из списка', () => {
    expect(OPERATION_PERIOD_PRESETS.some(p => p.value === DEFAULT_OPERATION_PERIOD)).toBe(true)
  })
})

describe('фолбэки ядра', () => {
  // ⚠ Невалидный день в подписи отдаётся КАК ЕСТЬ, а не пустотой: подпись — не место для
  // исключений, но и молча терять значение нельзя (пустая строка выглядела бы «за — по 26 августа»).
  it('formatIsoDayRu не глотает невалидное значение', () => {
    expect(formatIsoDayRu('26.08.2026')).toBe('26.08.2026')
    expect(formatIsoDayRu('2026-02-31')).toBe('2026-02-31')
    expect(formatIsoDayRu('')).toBe('')
  })

  // ⚠ Неизвестный пресет падает в ОДИН день, а не в широкий период: ошибка в сторону «меньше
  // данных» видна сразу, в сторону «больше» — тихо расширяет срок под чужой подписью.
  it('неизвестный пресет даёт один день, а не длинный период', () => {
    const r = operationPeriodRange('такого-нет' as never, '2026-08-26')
    expect(r).toEqual({ from: '2026-08-26', to: '2026-08-26' })
  })

  it('пробелы в границах не считаются заполненной границей', () => {
    expect(operationPeriodCaption({ from: '   ', to: '' })).toBe('за всё время')
  })
})
