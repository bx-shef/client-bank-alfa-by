import { describe, expect, it } from 'vitest'
import { landedCleanly, resolveOpLogMode, runSummaryLine, shouldLogOperation } from '../app/utils/opLogPolicy'

// Объём построчного лога (#498).
//
// Замер: строка `[op]` весит 221 байт с обвязкой docker json-file. На «10 порталов × 100 оплат/мин»
// это 12,6 МБ/час при ротации 10 МБ × 5 — вся история около ЧЕТЫРЁХ часов, а с включённым
// распознаванием (`[recognize]`/`[resolve]`) полтора. Лог перестаёт быть тем, ради чего заведён.

describe('landedCleanly', () => {
  it('приземлилось = клиент опознан И дело записано', () => {
    expect(landedCleanly({ owner: 'client', activityId: 42 })).toBe(true)
    expect(landedCleanly({ owner: 'client', activityId: '42' })).toBe(true)
  })

  it('фолбэк «в мою компанию» приземлением НЕ считается', () => {
    // ⚠ Дело записано, но клиент не опознан — а именно это админ и чинит, заводя реквизит.
    // Считать такую операцию обычной значило бы спрятать главный симптом ненастроенного портала.
    expect(landedCleanly({ owner: 'my-company', activityId: 42 })).toBe(false)
  })

  it('нет владельца или нет дела — не приземлилось', () => {
    expect(landedCleanly({ owner: 'none', activityId: 42 })).toBe(false)
    expect(landedCleanly({ owner: 'client', activityId: null })).toBe(false)
    expect(landedCleanly({ owner: 'client', activityId: '' })).toBe(false)
    expect(landedCleanly({ owner: 'client' })).toBe(false)
  })
})

describe('shouldLogOperation', () => {
  const landed = { owner: 'client', activityId: 7 } as const
  const stuck = { owner: 'none', activityId: null } as const

  it('по умолчанию печатает НЕприземлившиеся и молчит про приземлившиеся', () => {
    // Самонастраивающееся свойство: на здоровом портале лог тихий, на сломанном («117 обработано,
    // 0 создано») — полный, ровно тогда, когда он и нужен.
    expect(shouldLogOperation(stuck, 'notable')).toBe(true)
    expect(shouldLogOperation(landed, 'notable')).toBe(false)
  })

  it('`all` печатает всё — режим калибровки и живых прогонов', () => {
    expect(shouldLogOperation(landed, 'all')).toBe(true)
    expect(shouldLogOperation(stuck, 'all')).toBe(true)
  })

  it('`off` глушит и ДИАГНОСТИКУ — это аварийный клапан, а не «тихий прод»', () => {
    // Зафиксировано явно, чтобы режим не выбрали по названию: он выключает ровно то, ради чего
    // построчный лог существует.
    expect(shouldLogOperation(stuck, 'off')).toBe(false)
  })
})

describe('resolveOpLogMode', () => {
  it('мусор и пусто ⇒ notable, а не крайние режимы', () => {
    // Неизвестное значение не должно ни глушить диагностику, ни заливать диск.
    for (const raw of [undefined, '', '  ', 'yes', '1', 'verbose']) {
      expect(resolveOpLogMode(raw)).toBe('notable')
    }
  })

  it('понимает три режима, регистр и пробелы не мешают', () => {
    expect(resolveOpLogMode('all')).toBe('all')
    expect(resolveOpLogMode(' OFF ')).toBe('off')
    expect(resolveOpLogMode('Notable')).toBe('notable')
  })
})

describe('runSummaryLine', () => {
  const s = { processed: 117, landed: 0, created: 0, unmatched: 117, unresolved: 0, recognized: 0 }

  it('печатает итог прогона — запись, которой раньше НЕ БЫЛО ВОВСЕ', () => {
    // Сводка считалась, уезжала в БД и метрики, но в лог не попадала: безусловной записи уровня
    // прогона, переживающей ротацию, в логе не существовало.
    const line = runSummaryLine('M1', s, 'notable')
    expect(line).toContain('117 обработано')
    expect(line).toContain('117 без клиента')
    expect(line).toContain('M1')
  })

  it('НЕ молчит про опущенные строки', () => {
    // Молчаливое сокращение читается как «больше ничего и не было» — та самая ложь, из-за которой
    // первый боевой прогон пришлось разбирать вручную в базе.
    const line = runSummaryLine('M1', { ...s, processed: 10, landed: 8, created: 8, unmatched: 2 }, 'notable')
    expect(line).toContain('опущено 8')
  })

  it('в режиме `all` про опущенные не врёт — их нет', () => {
    const line = runSummaryLine('M1', { ...s, processed: 10, landed: 8, created: 8 }, 'all')
    expect(line).not.toContain('опущено')
  })
})
