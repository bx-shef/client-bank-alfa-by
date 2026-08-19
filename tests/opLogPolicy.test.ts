import { describe, expect, it } from 'vitest'
import { landedCleanly, resolveOpLogMode, runSummaryLine, shouldLogOperation } from '../app/utils/opLogPolicy'

// Объём построчного лога (#498).
//
// Замер: строка `[op]` весит 221 байт с обвязкой docker json-file. На «10 порталов × 100 оплат/мин»
// это 12,6 МБ/час при ротации 10 МБ × 5 — вся история около ЧЕТЫРЁХ часов. Лог перестаёт быть тем,
// ради чего заведён. ⚠ Замерена одна строка, четыре часа — арифметика над ней; оценка «с
// распознаванием ~1,5 часа» — экстраполяция (×2,5), не замер.

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
  const s = { processed: 117, landed: 0, created: 0, unmatched: 117, unresolved: 0, recognized: 0, skipped: 0, excluded: 0 }

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

  it('режим `off` ОБЪЯВЛЯЕТ СЕБЯ — пустой лог не должен выглядеть здоровым', () => {
    // ⚠ Ровно то же правило, ради которого заведён хвост, и в `off` оно нарушалось бы сильнее
    // всего: там гасятся ВСЕ построчные записи, включая неприземлившиеся, то есть диагностика.
    // Без этой пометки `off` становится способом получить тихий лог, выглядящий здоровым, — то
    // самое возражение, из-за которого отвергнут вариант «просто выключить построчный лог флагом».
    const line = runSummaryLine('M1', { ...s, processed: 117, unmatched: 117 }, 'off')
    expect(line).toContain('ВЫКЛЮЧЕН')
    expect(line).toContain('STATEMENT_OP_LOG=off')
    // ⚠ Счётчики при этом на месте: `off` глушит построчный лог, а не итог прогона.
    expect(line).toContain('117 обработано')
    expect(line).toContain('117 без клиента')
  })

  it('ЗДОРОВЫЙ повторный опрос отличим от сломанного портала', () => {
    // ⚠ Главная находка ревью. Окно опроса намеренно нахлёстывается (`CRON_LOOKBACK_DAYS`), поэтому
    // каждый повтор заново прогоняет вчерашние операции и все они дедуплицируются. Без пометки про
    // дедуп тихая ночь на исправном портале печаталась БУКВАЛЬНО той же сигнатурой, которой оба
    // документа описывают сломанный портал: «N обработано, 0 создано, 0 приземлилось».
    const quiet = runSummaryLine('M1', { ...s, processed: 2, unmatched: 0, skipped: 2 }, 'notable')
    const broken = runSummaryLine('M1', s, 'notable')
    expect(quiet).toContain('2 уже было записано')
    expect(broken).not.toContain('уже было записано')
    // Различимость — суть проверки: одинаковый текст здесь и был дефектом.
    expect(quiet.replace('2 обработано', '117 обработано')).not.toBe(broken)
  })

  it('исключённые правилами тоже названы — иначе «0 создано» выглядит отказом', () => {
    const line = runSummaryLine('M1', { ...s, processed: 5, unmatched: 0, excluded: 5 }, 'notable')
    expect(line).toContain('5 исключено правилами')
  })

  it('нулевые пояснения НЕ печатаются — постоянный шум перестают читать', () => {
    const line = runSummaryLine('M1', { ...s, processed: 3, landed: 3, created: 3, unmatched: 0 }, 'all')
    expect(line).not.toContain('уже было записано')
    expect(line).not.toContain('исключено правилами')
  })

  it('в `off` не печатается счётчик опущенных — он был бы неверным', () => {
    // В `off` гасятся ВСЕ строки, а не только приземлившиеся, поэтому число `landed` описывало бы
    // лишь часть подавленного. Пометка про выключенный режим честнее любого числа здесь.
    const line = runSummaryLine('M1', { ...s, processed: 10, landed: 8, created: 8, unmatched: 2 }, 'off')
    expect(line).not.toContain('опущено 8')
  })
})
