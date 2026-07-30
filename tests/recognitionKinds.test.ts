import { describe, expect, it } from 'vitest'
import type { IdentifierKind } from '~/utils/purposeMatch'
import { ALPHABET_ITEMS, CONFIG_FIELD_ROWS, IDENTIFIER_KIND_ITEMS, IDENTIFIER_KIND_LABELS, blankMatrix, MATRIX_PRESETS, missingPresets } from '~/utils/recognitionKinds'

// Every IdentifierKind must have a label/option (compile-time via Record; this test guards
// the value data + option order + config-field keys the «карта сопоставления» editor renders.
const ALL_KINDS: IdentifierKind[] = [
  'invoice-number', 'invoice-id', 'deal-id', 'deal-field', 'order-id', 'order-number',
  'payment-id', 'payment-number', 'smart-id', 'smart-field', 'document-number'
]

describe('recognitionKinds', () => {
  it('labels EVERY IdentifierKind with a non-empty RU label (exhaustive)', () => {
    expect(Object.keys(IDENTIFIER_KIND_LABELS).sort()).toEqual([...ALL_KINDS].sort())
    for (const k of ALL_KINDS) expect(IDENTIFIER_KIND_LABELS[k].length).toBeGreaterThan(0)
  })

  it('IDENTIFIER_KIND_ITEMS is one {label,value} per kind in declaration order', () => {
    expect(IDENTIFIER_KIND_ITEMS.map(i => i.value)).toEqual(ALL_KINDS)
    expect(IDENTIFIER_KIND_ITEMS.every(i => i.label.length > 0)).toBe(true)
  })

  it('alphabet items cover cyrillic + latin', () => {
    expect(ALPHABET_ITEMS.map(i => i.value)).toEqual(['cyrillic', 'latin'])
  })

  it('config-field rows match the resolver config keys (smart-entity/deal-field/smart-field)', () => {
    expect(CONFIG_FIELD_ROWS.map(r => r.key)).toEqual(['smart-entity', 'deal-field', 'smart-field'])
    expect(CONFIG_FIELD_ROWS.every(r => r.label && r.hint)).toBe(true)
  })

  it('blankMatrix is an empty mask with a valid default kind', () => {
    const m = blankMatrix()
    expect(m.mask).toBe('')
    expect(ALL_KINDS).toContain(m.kind)
  })
})

describe('MATRIX_PRESETS / missingPresets', () => {
  it('пресеты — рабочие маски, а не заглушки', () => {
    // Если бы маска не содержала `d`, «типовой» шаблон не распознавал бы вообще ничего, и кнопка
    // молча ухудшала бы настройку.
    expect(MATRIX_PRESETS.length).toBeGreaterThan(0)
    for (const p of MATRIX_PRESETS) {
      expect(p.mask).toMatch(/d/)
      expect(IDENTIFIER_KIND_LABELS[p.kind]).toBeTruthy()
    }
  })

  it('повторное добавление НЕ задваивает уже добавленные маски', () => {
    // Дубль маски даёт дубль распознавания — повторный клик по кнопке не должен ухудшать карту.
    const all = missingPresets([])
    expect(all).toHaveLength(MATRIX_PRESETS.length)
    expect(missingPresets(all)).toEqual([])
  })

  it('сравнение масок регистронезависимо', () => {
    const first = MATRIX_PRESETS[0]!
    const left = missingPresets([{ mask: first.mask.toUpperCase(), kind: first.kind }])
    expect(left.some(p => p.mask === first.mask)).toBe(false)
  })

  it('отдаёт КОПИИ — правка в форме не должна менять сам пресет', () => {
    const [row] = missingPresets([])
    row!.mask = 'изменено'
    expect(MATRIX_PRESETS[0]!.mask).not.toBe('изменено')
  })
})
