import { describe, expect, it } from 'vitest'
import type { ImportBatchResult } from '~/types/importBatch'
import {
  POLL_TIMEOUT_MS, batchStateLabel, hasPending, shouldKeepPolling, summaryMessage, totalsOf
} from '~/utils/importBatchView'

// Итог ручной загрузки (#417). Здесь ошибиться легко в ОБЕ стороны: не остановить опрос — вечные
// запросы к порталу из открытой вкладки; остановить рано — сотрудник опять не узнает исход.

function batch(over: Partial<ImportBatchResult> = {}): ImportBatchResult {
  return {
    batchId: 'a'.repeat(64),
    state: 'ok',
    fileName: 'vypiska.txt',
    operations: 5,
    created: 4,
    notified: 3,
    unmatched: 1,
    error: '',
    updatedAt: '2026-07-30T06:00:00.000Z',
    ...over
  }
}

describe('hasPending', () => {
  it('ждём, пока хоть одна загрузка в очереди', () => {
    expect(hasPending(['x'], [batch({ batchId: 'x', state: 'queued' })])).toBe(true)
    expect(hasPending(['x'], [batch({ batchId: 'x' })])).toBe(false)
  })

  it('НЕИЗВЕСТНЫЙ серверу ключ тоже считается ожиданием', () => {
    // Строка «принято» пишется best-effort и может не успеть до первого опроса. Считать такой
    // ключ завершённым значило бы бросить опрос ровно в тот момент, когда он и нужен.
    expect(hasPending(['x'], [])).toBe(true)
  })

  it('без ключей ждать нечего', () => {
    expect(hasPending([], [])).toBe(false)
  })
})

describe('shouldKeepPolling', () => {
  it('прекращаем по истечении срока, даже если что-то не завершилось', () => {
    const queued = [batch({ batchId: 'x', state: 'queued' })]
    expect(shouldKeepPolling(['x'], queued, 0)).toBe(true)
    expect(shouldKeepPolling(['x'], queued, POLL_TIMEOUT_MS)).toBe(false)
  })

  it('прекращаем сразу, как всё завершилось', () => {
    expect(shouldKeepPolling(['x'], [batch({ batchId: 'x' })], 0)).toBe(false)
  })
})

describe('totalsOf', () => {
  it('незавершённые в счётчики НЕ идут', () => {
    // Иначе итог «рос» бы на глазах и был бы неотличим от окончательного.
    const t = totalsOf([batch(), batch({ batchId: 'b', state: 'queued', operations: 99, created: 99 })])
    expect(t.operations).toBe(5)
    expect(t.created).toBe(4)
  })

  it('считает провалившиеся загрузки', () => {
    expect(totalsOf([batch({ state: 'error', operations: 0, created: 0 })]).failed).toBe(1)
  })
})

describe('summaryMessage', () => {
  it('называет операции без компании отдельно', () => {
    // «Записано 4 из 5» без объяснения читается как потеря данных.
    const msg = summaryMessage([batch()])
    expect(msg).toContain('Разобрано операций: 5')
    expect(msg).toContain('записано в CRM: 4')
    // Текст не только называет причину, но и говорит, ГДЕ искать: дела ушли в мою компанию
    // (каскад #91), иначе «записано 4 из 5» читается как потеря данных.
    expect(msg).toContain('не нашли компанию по счёту плательщика')
    expect(msg).toContain('записаны в вашу компанию')
  })

  it('пока ВСЁ в очереди — итога нет (нули читались бы как «ничего не записалось»)', () => {
    expect(summaryMessage([batch({ state: 'queued' }), batch({ batchId: 'b', state: 'queued' })])).toBe('')
  })

  it('склонение по числу операций без компании', () => {
    expect(summaryMessage([batch({ unmatched: 2 })])).toContain('По 2 операций')
    expect(summaryMessage([batch({ unmatched: 1 })])).toContain('По 1 операции')
  })

  it('провалившиеся файлы названы в сводке', () => {
    expect(summaryMessage([batch({ state: 'error' })])).toContain('не удалось обработать: 1 файл')
  })

  it('не поминает чат и компанию-плательщика, когда их нет', () => {
    const msg = summaryMessage([batch({ notified: 0, unmatched: 0 })])
    expect(msg).not.toContain('чат')
    expect(msg).not.toContain('компанию по счёту')
  })

  it('пусто, когда итогов ещё нет', () => {
    expect(summaryMessage([])).toBe('')
  })
})

describe('batchStateLabel', () => {
  it('показывает ПРИЧИНУ провала, а не голое «ошибка»', () => {
    expect(batchStateLabel(batch({ state: 'error', error: 'Формат не распознан.' }))).toBe('Формат не распознан.')
  })

  it('на провал без текста есть внятный запасной вариант', () => {
    expect(batchStateLabel(batch({ state: 'error', error: '' }))).toBe('ошибка обработки')
  })

  it('успех показывает разобранное и записанное', () => {
    expect(batchStateLabel(batch({ operations: 5, created: 4 }))).toBe('5 операций, записано 4')
    expect(batchStateLabel(batch({ operations: 1, created: 1 }))).toBe('1 операция, записано 1')
    expect(batchStateLabel(batch({ operations: 2, created: 2 }))).toBe('2 операции, записано 2')
  })

  it('в очереди — честное «обрабатывается»', () => {
    expect(batchStateLabel(batch({ state: 'queued' }))).toBe('обрабатывается…')
  })
})

// ⚠ #43: сводка загрузки — одна из ЧЕТЫРЁХ поверхностей, где жил невыполнимый совет «привяжите
// вручную». Bitrix24 не даёт сменить владельца у созданного дела (#579), поэтому текст обязан
// называть рабочий путь. Без этого гарда прежнюю формулировку можно вернуть молча: остальные
// тесты здесь проверяют только склонения.
describe('сводка не советует невыполнимую ручную привязку (#43)', () => {
  it('называет рабочий путь вместо «привяжите вручную»', () => {
    const text = summaryMessage([batch({ unmatched: 2 })])
    expect(text).not.toMatch(/привяж|ручн/i)
    expect(text).toMatch(/завед[ие]те/i)
    expect(text).toMatch(/удалит[ьеи]/i)
  })
})
