import { describe, expect, it } from 'vitest'
import { ALERT_CHANNEL_CLASS, HEALTH_STALE_MS, HEALTH_TONE_COLOR, presentQueueHealth } from '~/utils/queueHealthView'
import { queueAlertState, recordQueueHealth, resetQueueAlertState } from '../server/utils/queueAlertState'
import type { QueueAlert } from '../server/utils/queueAlert'

// The screen half of #426. The single thing worth testing: an empty alert list has THREE meanings,
// and rendering them identically is the same lie as showing an unreadable queue as a healthy one.

const T0 = 1_800_000_000_000
const alert = { kind: 'stalled' as const, queue: 'crm-sync', text: 'очередь «crm-sync» не разгребается' }

describe('presentQueueHealth', () => {
  it('никогда не проверяли ≠ всё хорошо', () => {
    const v = presentQueueHealth({ alerts: [], alertsCheckedAt: null }, T0)
    expect(v.tone).toBe('unknown')
    expect(v.note).not.toContain('не обнаружено')
  })

  it('нет данных вовсе (эндпоинт не ответил тем, чем должен) — тоже «неизвестно»', () => {
    expect(presentQueueHealth(null, T0).tone).toBe('unknown')
    expect(presentQueueHealth({}, T0).tone).toBe('unknown')
  })

  it('свежая проверка без тревог — единственный случай, когда говорим «всё хорошо»', () => {
    expect(presentQueueHealth({ alerts: [], alertsCheckedAt: T0 - 60_000 }, T0).tone).toBe('ok')
  })

  it('протухшая проверка не выдаётся за здоровье — мог умереть сам проверяющий', () => {
    const v = presentQueueHealth({ alerts: [], alertsCheckedAt: T0 - HEALTH_STALE_MS - 60_000 }, T0)
    expect(v.tone).toBe('stale')
    expect(v.note).toContain('устарели')
  })

  it('протухшая проверка ВСЁ РАВНО показывает найденные тревоги (данные старые, а не отсутствуют)', () => {
    const v = presentQueueHealth({ alerts: [alert], alertsCheckedAt: T0 - HEALTH_STALE_MS - 60_000 }, T0)
    expect(v.tone).toBe('stale')
    expect(v.alerts).toHaveLength(1)
  })

  it('граница свежести: ровно на пороге ещё свежо, на миллисекунду позже — протухло', () => {
    expect(presentQueueHealth({ alerts: [], alertsCheckedAt: T0 - HEALTH_STALE_MS }, T0).tone).toBe('ok')
    expect(presentQueueHealth({ alerts: [], alertsCheckedAt: T0 - HEALTH_STALE_MS - 1 }, T0).tone).toBe('stale')
  })

  it('свежие тревоги — проблема, и они отдаются на отрисовку', () => {
    const v = presentQueueHealth({ alerts: [alert], alertsCheckedAt: T0 - 60_000 }, T0)
    expect(v.tone).toBe('problem')
    expect(v.alerts[0]!.text).toContain('crm-sync')
  })

  it('метка из будущего (расхождение часов) не читается как гигантский возраст', () => {
    expect(presentQueueHealth({ alerts: [], alertsCheckedAt: T0 + 60_000 }, T0).tone).toBe('ok')
  })

  it('у каждого тона есть свой цвет, и «всё хорошо» с «проблемой» не совпадают', () => {
    const colors = Object.values(HEALTH_TONE_COLOR)
    expect(new Set(colors).size).toBe(colors.length)
    expect(HEALTH_TONE_COLOR.ok).not.toBe(HEALTH_TONE_COLOR.problem)
  })
})

describe('queueAlertState (процесс-широкое состояние)', () => {
  it('до первой проверки — null, а не «пусто и хорошо»', () => {
    resetQueueAlertState()
    expect(queueAlertState()).toEqual({ alerts: [], checkedAtMs: null })
  })

  it('хранит последний вердикт и его время', () => {
    resetQueueAlertState()
    recordQueueHealth([alert], T0)
    expect(queueAlertState()).toEqual({ alerts: [alert], checkedAtMs: T0 })
  })

  it('следующая проверка ЗАМЕЩАЕТ прошлый вердикт, а не копит', () => {
    resetQueueAlertState()
    recordQueueHealth([alert], T0)
    recordQueueHealth([], T0 + 60_000)
    expect(queueAlertState()).toEqual({ alerts: [], checkedAtMs: T0 + 60_000 })
  })

  it('отданный массив — копия: правка у вызывающего не переписывает хранимый вердикт', () => {
    resetQueueAlertState()
    recordQueueHealth([alert], T0)
    queueAlertState().alerts.push({ kind: 'failing', queue: 'x', text: 'подделка' })
    expect(queueAlertState().alerts).toHaveLength(1)
  })

  it('переданный массив тоже копируется — мутация у вызывающего не меняет хранимое', () => {
    resetQueueAlertState()
    const source: QueueAlert[] = [alert]
    recordQueueHealth(source, T0)
    source.push({ kind: 'failing', queue: 'x', text: 'подделка' })
    expect(queueAlertState().alerts).toHaveLength(1)
  })
})

describe('цвета строки канала не ниже порога контраста (#466 §3)', () => {
  it('красный — ИЗМЕРЕННАЯ пара, а не «семантический» токен заливки', () => {
    // ⚠ `--ui-color-accent-main-alert` выглядит правильным по конвенции и молча ломает читаемость:
    // это цвет ЗАЛИВКИ, текстом на светлом он даёт 3.12:1 при пороге 4.5:1 (CLAUDE.md §Цвет и
    // контраст, замерено в #528). Первая редакция взяла именно его. Хуже всего читалась бы строка
    // о том, что сигнализация мертва.
    expect(ALERT_CHANNEL_CLASS.broken, 'взят цвет заливки вместо текстового')
      .not.toMatch(/accent-main-(alert|success)/)
    expect(ALERT_CHANNEL_CLASS.broken, 'нет тёмного переопределения — пара обязана быть двойной')
      .toMatch(/dark:/)
  })

  it('«не настроен» и «сломан» — РАЗНЫЕ цвета', () => {
    // Схлопнув их, мы приучили бы игнорировать красное на странице, где оно обязано что-то значить.
    expect(ALERT_CHANNEL_CLASS.off).not.toBe(ALERT_CHANNEL_CLASS.broken)
  })

  it('сырые Tailwind-классы не используются', () => {
    // `text-base-500` в b24ui не существует вовсе (шкала base — 1..8) и молча не даёт ничего.
    for (const cls of Object.values(ALERT_CHANNEL_CLASS)) {
      expect(cls, `сырой Tailwind-класс: ${cls}`).toMatch(/--ui-color-/)
    }
  })
})
