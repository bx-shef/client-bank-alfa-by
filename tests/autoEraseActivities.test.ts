import { describe, expect, it } from 'vitest'
import {
  AUTO_ERASE_GRACE_DAYS,
  AUTO_ERASE_MIN_DAYS,
  autoEraseCutoff,
  autoEraseLogLine,
  autoEraseThresholdDays,
  buildAutoEraseFilter,
  portalDayBack,
  selectAutoErasable,
  type AutoEraseFacts,
  type AutoEraseRow
} from '../app/utils/autoEraseActivities'
import { ACTIVITY_ORIGIN } from '../app/utils/activity'

// Чистое ядро автоудаления дел (#722).
//
// ⚠ Половина этих тестов существует не ради «покрытия», а ради ОДНОГО конкретного отказа,
// случившегося при первом же замере на живом портале: `<=CREATED` с неэкранированным именем ключа
// Bitrix24 принимает МОЛЧА и возвращает ПОЛНЫЙ список. То есть фильтр, который выглядит рабочим и
// не сужает ничего. На автомате это означало бы «снести сегодняшние дела на каждом согласившемся
// портале», поэтому вторая граница (перепроверка возраста по ответу) проверяется отдельно и
// придирчиво.

describe('autoEraseThresholdDays', () => {
  it('на умолчании окна держит пол владельца, а не окно+надбавку', () => {
    // Окно по умолчанию — сутки; одна надбавка дала бы три дня, то есть пятницу-воскресенье.
    expect(autoEraseThresholdDays(1)).toBe(AUTO_ERASE_MIN_DAYS)
    expect(autoEraseThresholdDays(3)).toBe(AUTO_ERASE_MIN_DAYS)
  })

  it('на широком окне растёт вместе с ним — иначе удалённое вернётся следующим опросом', () => {
    // ⚠ ГЛАВНОЕ свойство: порог обязан быть СТРОГО больше окна. Маркер дедупа живёт на самом деле
    // (#259), поэтому дело, стёртое внутри окна, запишется заново — и автомат будет воевать с
    // импортом вечно. Мутация «вернуть зашитую пятёрку» роняет именно этот тест.
    for (const lookback of [4, 7, 10, 30, 90]) {
      expect(autoEraseThresholdDays(lookback)).toBe(lookback + AUTO_ERASE_GRACE_DAYS)
      expect(autoEraseThresholdDays(lookback)).toBeGreaterThan(lookback)
    }
  })

  it('кривое окно из env упирается в пол, а не выключает удаление и не уносит его в бесконечность', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(autoEraseThresholdDays(bad)).toBeGreaterThanOrEqual(AUTO_ERASE_MIN_DAYS)
    }
    expect(autoEraseThresholdDays(100_000)).toBeLessThanOrEqual(400)
  })
})

describe('portalDayBack', () => {
  it('считает день в поясе портала, а не по UTC-часам процесса', () => {
    // 2026-09-16T00:30 UTC — это уже 03:30 16 сентября в Минске. Оба совпадают.
    expect(portalDayBack(Date.parse('2026-09-16T00:30:00Z'), 0)).toBe('2026-09-16')
    // ⚠ А вот здесь они РАСХОДЯТСЯ: 21:30 UTC 15-го — это 00:30 16-го по Минску. Наивный
    // `toISOString()` от UTC вернул бы 15-е, то есть граница уехала бы на сутки В СТОРОНУ
    // УДАЛЕНИЯ ЛИШНЕГО. Мутация «считать по UTC» роняет только эту строку.
    expect(portalDayBack(Date.parse('2026-09-15T21:30:00Z'), 0)).toBe('2026-09-16')
  })

  it('отматывает ровно столько суток, сколько просили', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    expect(portalDayBack(now, 5)).toBe('2026-09-11')
    expect(portalDayBack(now, 1)).toBe('2026-09-15')
  })
})

describe('buildAutoEraseFilter', () => {
  it('всегда несёт наш ORIGINATOR_ID и границу по дате СОЗДАНИЯ', () => {
    const cutoff = autoEraseCutoff(Date.parse('2026-09-16T12:00:00Z'), 3)
    const filter = buildAutoEraseFilter(cutoff)
    expect(filter.ORIGINATOR_ID).toBe(ACTIVITY_ORIGIN)
    expect(filter['<=CREATED']).toBe('2026-09-11T00:00:00')
    // ⚠ Отрицание: по DEADLINE не фильтруем НИКОГДА. Дата платежа и дата создания расходятся
    // (замерено на живом портале: 4 дела из 17), и ручная загрузка старой выписки исчезла бы
    // на первом же тике. Вернуть сюда `<=DEADLINE` — первое, что придёт в голову следующему,
    // кто увидит рядом ручную «Очистку», которая фильтрует именно по нему.
    expect(Object.keys(filter)).not.toContain('<=DEADLINE')
    expect(Object.keys(filter)).not.toContain('>=DEADLINE')
  })
})

const row = (o: Partial<AutoEraseRow>): AutoEraseRow => ({
  id: '1', originatorId: ACTIVITY_ORIGIN, created: '2026-09-01T10:00:00+03:00', ...o
})

describe('selectAutoErasable', () => {
  const cutoff = autoEraseCutoff(Date.parse('2026-09-16T12:00:00Z'), 3) // граница 2026-09-11

  it('берёт только наши дела старше границы', () => {
    const rows = [
      row({ id: '1', created: '2026-09-01T10:00:00+03:00' }),
      row({ id: '2', created: '2026-09-10T23:59:59+03:00' })
    ]
    expect(selectAutoErasable(rows, cutoff).map(r => r.id)).toEqual(['1', '2'])
  })

  it('НЕ трогает дело, созданное в день границы или позже', () => {
    const rows = [
      row({ id: '3', created: '2026-09-11T00:00:00+03:00' }),
      row({ id: '4', created: '2026-09-16T09:00:00+03:00' })
    ]
    expect(selectAutoErasable(rows, cutoff)).toEqual([])
  })

  it('ВТОРАЯ граница: фильтр портала проигнорирован — свежие дела всё равно не удаляются', () => {
    // ⚠ Это не гипотетический сценарий. Ровно так ответил живой портал на неэкранированный
    // `<=CREATED`: вернул ПОЛНЫЙ список, ничего не сузив. Без этой проверки автомат снёс бы
    // сегодняшние дела у всех, кто включил настройку.
    const asIfFilterIgnored = [
      row({ id: '1', created: '2026-09-01T10:00:00+03:00' }),
      row({ id: '2', created: '2026-09-16T10:00:00+03:00' }),
      row({ id: '3', created: '2026-09-15T10:00:00+03:00' })
    ]
    expect(selectAutoErasable(asIfFilterIgnored, cutoff).map(r => r.id)).toEqual(['1'])
  })

  it('чужой ORIGINATOR_ID не удаляется, даже если портал его вернул', () => {
    const rows = [row({ id: '9', originatorId: 'CRM_OTHER_APP' }), row({ id: '10', originatorId: '' })]
    expect(selectAutoErasable(rows, cutoff)).toEqual([])
  })

  it('нечитаемая дата создания — это НЕЗНАНИЕ возраста, а не разрешение', () => {
    const rows = [row({ id: '11', created: '' }), row({ id: '12', created: 'позавчера' })]
    expect(selectAutoErasable(rows, cutoff)).toEqual([])
  })

  it('строка без id не удаляется (удалять нечем)', () => {
    expect(selectAutoErasable([row({ id: '' })], cutoff)).toEqual([])
  })
})

describe('autoEraseLogLine', () => {
  const facts = (o: Partial<AutoEraseFacts> = {}): AutoEraseFacts => ({
    considered: 0, enabled: 0, unreadable: 0, touched: 0,
    deleted: 0, withRemainder: 0, failed: 0, capped: false, thresholdDays: 5, ...o
  })

  it('печатается даже когда удалять было нечего', () => {
    // Молчание автомата, удаляющего данные клиента, неотличимо от «автомат не запускался».
    const line = autoEraseLogLine(facts({ considered: 3 }))
    expect(line).toContain('порталов рассмотрено 3')
    expect(line).toContain('порог 5 сут.')
  })

  it('отказы называет отдельно от штатных чисел', () => {
    const line = autoEraseLogLine(facts({ considered: 5, enabled: 2, unreadable: 1, failed: 1, capped: true }))
    expect(line).toContain('⚠ 1 пропущено')
    expect(line).toContain('⚠ 1 с ошибкой удаления')
    expect(line).toContain('⚠ упёрлись в потолок')
  })
})
