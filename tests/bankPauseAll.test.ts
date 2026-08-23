import { describe, expect, it } from 'vitest'
import { pauseAllSummary, planPauseAll } from '~/utils/bankPauseAll'

// Массовое переключение паузы опроса (#581).
//
// ⚠ Ядро отвечает на три вопроса, в каждом из которых легко ошибиться молча: показывать ли кнопку,
// в какую сторону она переключает, и какие строки трогать. Ошибка в любом из них не падает и не
// видна на экране — она видна на боевом портале через сутки, когда «выключенный» счёт продолжает
// заводить дела.

const acc = (accountKey: string, pollPaused?: boolean) => ({ accountKey, pollPaused })

describe('planPauseAll', () => {
  it('все работают → «Приостановить всё», трогаем все', () => {
    const plan = planPauseAll([acc('BY1'), acc('BY2'), acc('BY3')])
    expect(plan?.paused).toBe(true)
    expect(plan?.label).toBe('Приостановить всё')
    expect(plan?.rows.map(r => r.accountKey)).toEqual(['BY1', 'BY2', 'BY3'])
  })

  it('все на паузе → «Возобновить всё»', () => {
    const plan = planPauseAll([acc('BY1', true), acc('BY2', true)])
    expect(plan?.paused).toBe(false)
    expect(plan?.label).toBe('Возобновить всё')
    expect(plan?.rows).toHaveLength(2)
  })

  it('смешанное состояние → ПРИОСТАНОВИТЬ, и только работающие строки', () => {
    // ⚠ Направление выбрано намеренно: кнопка заведена под намерение «слишком много операций,
    // выключить», и из смешанного состояния к нему ведёт пауза. Обратный выбор означал бы, что один
    // приостановленный счёт переворачивает смысл кнопки для остальных трёх.
    const plan = planPauseAll([acc('BY1', true), acc('BY2'), acc('BY3')])
    expect(plan?.paused).toBe(true)
    expect(plan?.rows.map(r => r.accountKey), 'уже приостановленную строку не трогаем').toEqual(['BY2', 'BY3'])
  })

  it('незавершённые подключения ИСКЛЮЧАЮТСЯ и не считаются за подключение', () => {
    // ⚠ У `~pending:` паузы нет и быть не может — банк такого «номера» не знает. Включив их, мы
    // слали бы заведомо бессмысленные запросы и портили счёт «сколько не вышло».
    expect(planPauseAll([acc('~pending:n1'), acc('~pending:n2')]), 'два ожидающих — переключать нечего').toBeNull()
    const plan = planPauseAll([acc('~pending:n1'), acc('BY1'), acc('BY2')])
    expect(plan?.rows.map(r => r.accountKey)).toEqual(['BY1', 'BY2'])
  })

  it('одно подключение кнопку НЕ показывает', () => {
    // Ради одной строки, у которой переключатель уже стоит рядом, вторая кнопка сверху — лишний
    // элемент, который надо прочитать и сопоставить с первым.
    expect(planPauseAll([acc('BY1')])).toBeNull()
    expect(planPauseAll([acc('BY1', true)])).toBeNull()
    expect(planPauseAll([])).toBeNull()
  })

  it('одно реальное подключение среди ожидающих — тоже без кнопки', () => {
    expect(planPauseAll([acc('~pending:n1'), acc('BY1')])).toBeNull()
  })
})

describe('pauseAllSummary', () => {
  it('всё получилось — говорит сколько и в какую сторону', () => {
    expect(pauseAllSummary(3, 0, true)).toBe('Опрос приостановлен по 3 подключениям.')
    expect(pauseAllSummary(1, 0, false)).toBe('Опрос возобновлён по 1 подключению.')
  })

  it('ЧАСТИЧНЫЙ отказ назван прямо — иначе он читается как полный успех', () => {
    // ⚠ Ровно та ложь, из-за которой потом ищут поломку в банке: администратор уверен, что опрос
    // выключен, а один счёт продолжает заводить дела.
    const s = pauseAllSummary(3, 1, true)
    expect(s).toContain('3')
    expect(s).toContain('1 не переключилось')
  })

  it('не вышло НИЧЕГО — отдельный текст, а не «0 из 4»', () => {
    const s = pauseAllSummary(0, 4, true)
    expect(s).toContain('ни одно')
    expect(s).toContain('состояние не изменилось')
    expect(s, 'бодрого «приостановлен по 0» тут быть не должно').not.toContain('приостановлен по 0')
  })

  it('склонения — через общий pluralRu, а не «подключение(й)»', () => {
    expect(pauseAllSummary(1, 0, true)).toContain('1 подключению')
    expect(pauseAllSummary(2, 0, true)).toContain('2 подключениям')
    expect(pauseAllSummary(5, 0, true)).toContain('5 подключениям')
    expect(pauseAllSummary(11, 0, true)).toContain('11 подключениям')
  })
})
