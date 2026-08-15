import { describe, expect, it } from 'vitest'
import type { MatchMatrix } from '~/utils/purposeMatch'
import { foldHomoglyphs, recognizeByMatrices } from '~/utils/purposeMatch'

// Pure matrix-based identifier recognition from a payment purpose (#109, §4).
// Masks are config (real prefixes arrive with live statements) — tests supply
// their own. Covers: digit masks, word-boundary, literal prefixes, composite
// numbers, homoglyph folding (Cyrillic↔Latin), no-space-inside, case, dedup.

const invNum = (mask: string): MatchMatrix => ({ mask, kind: 'invoice-number' })

describe('foldHomoglyphs', () => {
  it('folds Cyrillic look-alikes to Latin and back', () => {
    expect(foldHomoglyphs('ВОРС', 'latin')).toBe('BOPC')
    expect(foldHomoglyphs('BOPC', 'cyrillic')).toBe('ВОРС')
  })
  it('leaves non-homoglyph characters and digits untouched', () => {
    expect(foldHomoglyphs('Ч-1234', 'latin')).toBe('Ч-1234') // Ч has no Latin twin
    expect(foldHomoglyphs('123/45', 'cyrillic')).toBe('123/45')
  })
  // #242: the fold table must cover every Belarusian letter in ALNUM that HAS a Latin
  // homoglyph. `І`↔`I` was missing; `Ў`/`Ё` genuinely have no Latin twin (must stay put).
  it('folds Belarusian І↔I (both cases), and leaves twin-less Ў/Ё alone', () => {
    expect(foldHomoglyphs('І', 'latin')).toBe('I')
    expect(foldHomoglyphs('і', 'latin')).toBe('i')
    expect(foldHomoglyphs('I', 'cyrillic')).toBe('І')
    expect(foldHomoglyphs('BOPC-І23', 'latin')).toBe('BOPC-I23')
    // no Latin look-alike → pass through unchanged in both directions
    for (const ch of ['Ў', 'ў', 'Ё', 'ё']) {
      expect(foldHomoglyphs(ch, 'latin')).toBe(ch)
    }
  })
})

describe('recognizeByMatrices', () => {
  it('extracts a bare digit mask', () => {
    expect(recognizeByMatrices('Оплата 2001 за услуги', [invNum('dddd')]))
      .toEqual([{ kind: 'invoice-number', value: '2001' }])
  })

  it('does NOT grab a fragment of a longer number (word boundary)', () => {
    expect(recognizeByMatrices('перевод 12345', [invNum('dddd')])).toEqual([])
  })

  it('matches a literal-prefixed mask (СЧ-dddd)', () => {
    expect(recognizeByMatrices('счёт СЧ-1234 за март', [invNum('СЧ-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'СЧ-1234' }])
  })

  it('keeps composite numbers (BOPC-ddd/dd)', () => {
    expect(recognizeByMatrices('оплата BOPC-123/45', [invNum('BOPC-ddd/dd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-123/45' }])
  })

  it('folds homoglyphs: Latin mask matches a Cyrillic-typed code (alphabet=latin)', () => {
    // purpose typed in Cyrillic «ВОРС-123», mask in Latin «BOPC-ddd»
    expect(recognizeByMatrices('оплата ВОРС-123', [invNum('BOPC-ddd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-123' }])
  })

  it('folds homoglyphs the other way (alphabet=cyrillic)', () => {
    expect(recognizeByMatrices('оплата BOPC-123', [invNum('BOPC-ddd')], 'cyrillic'))
      .toEqual([{ kind: 'invoice-number', value: 'ВОРС-123' }])
  })

  it('requires the exact literals — a space instead of the dash does not match', () => {
    expect(recognizeByMatrices('счёт СЧ 1234', [invNum('СЧ-dddd')])).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(recognizeByMatrices('оплата сч-1234', [invNum('СЧ-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'сч-1234' }])
  })

  it('applies several matrices and returns all, in matrix then position order', () => {
    const res = recognizeByMatrices('счёт СЧ-1 и заказ 6001', [
      invNum('СЧ-d'),
      { mask: 'dddd', kind: 'order-number' }
    ])
    expect(res).toEqual([
      { kind: 'invoice-number', value: 'СЧ-1' },
      { kind: 'order-number', value: '6001' }
    ])
  })

  it('dedups same kind+value, keeps distinct values', () => {
    expect(recognizeByMatrices('счёт 2001, ещё 2001', [invNum('dddd')]))
      .toEqual([{ kind: 'invoice-number', value: '2001' }])
    expect(recognizeByMatrices('2001 и 2002', [invNum('dddd')]))
      .toEqual([
        { kind: 'invoice-number', value: '2001' },
        { kind: 'invoice-number', value: '2002' }
      ])
  })

  it('returns [] for no match, empty mask, or empty matrix list', () => {
    expect(recognizeByMatrices('без номера', [invNum('СЧ-dddd')])).toEqual([])
    expect(recognizeByMatrices('счёт 1', [invNum('   ')])).toEqual([])
    expect(recognizeByMatrices('счёт 1', [])).toEqual([])
  })

  it('skips an absurdly long value (> MAX_ID_CHARS) without throwing', () => {
    const huge = 'd'.repeat(80)
    const text = `счёт ${'9'.repeat(80)}`
    expect(recognizeByMatrices(text, [invNum(huge)])).toEqual([])
  })

  it('accepts a value of exactly MAX_ID_CHARS (64) — no off-by-one', () => {
    const mask = 'd'.repeat(64)
    const text = `счёт ${'9'.repeat(64)} конец`
    expect(recognizeByMatrices(text, [invNum(mask)]))
      .toEqual([{ kind: 'invoice-number', value: '9'.repeat(64) }])
  })

  it('folds LOWERCASE homoglyphs too (ворс, not just ВОРС)', () => {
    expect(foldHomoglyphs('ворс', 'latin')).toBe('bopc')
    expect(recognizeByMatrices('оплата ворс-123', [invNum('BOPC-ddd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'bopc-123' }])
  })

  it('folds a MIXED-alphabet token (ВOРC → BOPC under latin)', () => {
    // В,Р cyrillic + O,C latin — one visual "BOPC"
    expect(recognizeByMatrices('оплата ВOРC-9', [invNum('BOPC-d')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-9' }])
  })

  it('treats uppercase D in a mask as a literal (case-insensitive match)', () => {
    expect(recognizeByMatrices('код D-1234', [invNum('D-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'D-1234' }])
    expect(recognizeByMatrices('код d-1234', [invNum('D-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'd-1234' }])
  })

  it('does not grab a number after a Belarusian letter (Ўў/Іі in the boundary)', () => {
    expect(recognizeByMatrices('плацёж№ў2001', [invNum('dddd')])).toEqual([])
    expect(recognizeByMatrices('код і2002', [invNum('dddd')])).toEqual([])
  })

  it('skips an over-long mask (> MAX_MASK_CHARS) without throwing', () => {
    expect(recognizeByMatrices('счёт 1', [invNum('d'.repeat(200))])).toEqual([])
  })
})

describe('квантификатор d+ (#421)', () => {
  const m = (mask: string, kind = 'invoice-number' as const) => [{ mask, kind }]

  it('покрывает номера РАЗНОЙ длины — нумерация Б24 растёт от СЧ-1', () => {
    // Ради этого он и заведён: маска фиксированной длины описывает нумерацию, которой не бывает.
    for (const n of ['1', '27', '1234', '150000']) {
      expect(recognizeByMatrices(`Оплата по счету СЧ-${n}`, m('СЧ-d+'), 'cyrillic')[0]?.value)
        .toBe(`СЧ-${n}`)
    }
  })

  it('границы токена соблюдаются — не выкусывает фрагмент длинного числа', () => {
    expect(recognizeByMatrices('УНП 191234567', m('d+'), 'cyrillic').map(r => r.value)).toEqual(['191234567'])
    expect(recognizeByMatrices('счет СЧ-12АБ', m('СЧ-d+'), 'cyrillic')).toEqual([])
  })

  it('составной номер оплаты заказа любой длины', () => {
    expect(recognizeByMatrices('оплата заказа 12/1', m('d+/d+', 'order-number')[0] ? m('d+/d+', 'order-number') : [], 'cyrillic')[0]?.value)
      .toBe('12/1')
    expect(recognizeByMatrices('оплата 1234/56', m('d+/d+', 'order-number'), 'cyrillic')[0]?.value).toBe('1234/56')
  })

  it('маска без квантификатора работает как раньше — ровно одна цифра на `d`', () => {
    // Обратная совместимость: у портала уже могут быть свои маски фиксированной длины.
    expect(recognizeByMatrices('счет СЧ-1234', m('СЧ-dddd'), 'cyrillic')[0]?.value).toBe('СЧ-1234')
    expect(recognizeByMatrices('счет СЧ-12', m('СЧ-dddd'), 'cyrillic')).toEqual([])
  })
})

describe('номер, слипшийся с предыдущим словом или с префиксом N (#492)', () => {
  // Замерено на 40 боевых приходах: три номера, которые в тексте ЕСТЬ, были для нас невидимы —
  // и все три по одной причине. Примеры синтетические, воспроизводят форму, а не значения:
  // репозиторий публичный, а номера из чужой выписки — финансовые ПДн.
  const m = (mask: string) => [{ mask, kind: 'invoice-number' as const }]

  // ⚠ Возвращаемое значение — из СВЁРНУТОГО назначения, поэтому латинская `B` приезжает обратно
  // кириллической `В` (алфавит по умолчанию — кириллица). Это не дефект, а суть свёртки: номер,
  // записанный любым из двух алфавитов, должен сравниваться одинаково.
  it('«ПО СЧЕТУ1000001-B24» — номер слип с предлогом', () => {
    const got = recognizeByMatrices('ОПЛАТА ПО СЧЕТУ1000001-B24 ОТ 01.01.2026', m('d+-B24'))
    expect(got.map(r => r.value)).toEqual(['1000001-В24'])
  })

  it('«СЧЕТУ N1000002-B24» — номер слип с префиксом N', () => {
    const got = recognizeByMatrices('СОГЛАСНО СЧЕТУ N1000002-B24 ОТ 01.01.2026', m('d+-B24'))
    expect(got.map(r => r.value)).toEqual(['1000002-В24'])
  })

  it('«СЧЕТУ N10003\\01.01.26» — то же, с датой в номере', () => {
    const got = recognizeByMatrices('СОГЛАСНО СЧЕТУ N10003\\01.01.26 ЗА УСЛУГИ', m('d+\\dd.dd.dd'))
    expect(got.map(r => r.value)).toEqual(['10003\\01.01.26'])
  })

  it('падежи слова «счёт» покрыты, включая написание через ё', () => {
    for (const word of ['СЧЕТ', 'СЧЕТА', 'СЧЕТУ', 'СЧЁТ', 'СЧ']) {
      const got = recognizeByMatrices(`ОПЛАТА ПО ${word}1000001-B24`, m('d+-B24'))
      expect(got.map(r => r.value), word).toEqual(['1000001-В24'])
    }
  })

  it('№ работал и раньше — он не буква и границу не нарушает', () => {
    const got = recognizeByMatrices('ОПЛАТА ПО СЧЕТУ №1000001-B24', m('d+-B24'))
    expect(got.map(r => r.value)).toEqual(['1000001-В24'])
  })
})

describe('послабление границы НЕ открыло дорогу ложным номерам (#492)', () => {
  const bare = [{ mask: 'd+', kind: 'invoice-number' as const }]

  it('хвост артикула по-прежнему не номер', () => {
    // Это и есть цена, которую платит вариант «разрешить любую букву слева»: `d+` начал бы
    // выхватывать цифры из любого кода, и на каждой приложение кричало бы «цель не найдена».
    expect(recognizeByMatrices('ОПЛАТА ЗА КЛЕЙ2000 И ГРУНТ3000', bare)).toEqual([])
  })

  it('«N», приклеенный к букве, границей не считается — иначе `PN1234` стал бы номером', () => {
    expect(recognizeByMatrices('ТОВАР PN1234 ШТ', bare)).toEqual([])
  })

  it('слово, ЗАКАНЧИВАЮЩЕЕСЯ на «СЧ», префиксом не считается', () => {
    // Вложенная проверка границы у самого префикса: «ЛИСЧ» — одно слово, а не «ЛИ» + «СЧ».
    expect(recognizeByMatrices('КОД ЛИСЧ1234', bare)).toEqual([])
  })

  it('«N» на своём месте номер всё-таки открывает', () => {
    expect(recognizeByMatrices('ТОВАР N1234 ШТ', bare).map(r => r.value)).toEqual(['1234'])
  })
})

describe('латинский алфавит: список префиксов сворачивается вместе с назначением (#492)', () => {
  // Под `latin` «СЧЕТУ» превращается в «CЧETY» (у Ч нет латинского двойника). Несвёрнутый
  // литерал просто не совпал бы — и починка молча ничего не сделала бы ровно на тех порталах,
  // которые выбрали этот алфавит.
  const m = [{ mask: 'd+-B24', kind: 'invoice-number' as const }]

  it('кириллическое «СЧЕТУ» слитно с номером распознаётся и в латинском алфавите', () => {
    const got = recognizeByMatrices('ОПЛАТА ПО СЧЕТУ1000001-В24', m, 'latin')
    // Под `latin` кириллическая `В` сворачивается в латинскую `B` — зеркально случаю выше.
    expect(got.map(r => r.value)).toEqual(['1000001-B24'])
  })

  it('и в кириллическом — тоже', () => {
    const got = recognizeByMatrices('ОПЛАТА ПО СЧЕТУ1000001-B24', m, 'cyrillic')
    expect(got).toHaveLength(1)
  })
})
