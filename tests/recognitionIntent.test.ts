import { describe, expect, it } from 'vitest'
import type { RecognitionSettings } from '~/utils/settings'
import { recognizePurposeIntents } from '~/utils/recognitionIntent'

// Pure composition recognize → route (#109, §4). Verifies the two cores compose:
// recognizeByMatrices extracts the value, routeIdentifier attaches the dispatch.

const settings = (matrices: RecognitionSettings['matrices'], alphabet: RecognitionSettings['alphabet'] = 'cyrillic'): RecognitionSettings =>
  ({ alphabet, matrices, configFields: {} })

describe('recognizePurposeIntents', () => {
  it('recognizes an invoice number and routes it (by-number → invoice)', () => {
    const out = recognizePurposeIntents('Оплата по счету СЧ-1234', settings([{ mask: 'СЧ-dddd', kind: 'invoice-number' }]))
    expect(out).toEqual([{
      kind: 'invoice-number',
      value: 'СЧ-1234',
      route: { targetKind: 'invoice', strategy: 'by-number', needsConfiguredField: false }
    }])
  })

  it('returns [] when recognition is off (no matrices)', () => {
    expect(recognizePurposeIntents('Оплата по счету СЧ-1234', settings([]))).toEqual([])
  })

  it('returns [] when nothing matches', () => {
    expect(recognizePurposeIntents('перевод без номера', settings([{ mask: 'dddd', kind: 'invoice-number' }]))).toEqual([])
  })

  it('returns [] for an empty purpose (boundary input)', () => {
    expect(recognizePurposeIntents('', settings([{ mask: 'dddd', kind: 'invoice-number' }]))).toEqual([])
  })

  it('routes each recognized kind to its distinct strategy (id vs number vs document)', () => {
    const out = recognizePurposeIntents(
      'сделка 77 документ ДОК-5',
      settings([{ mask: 'dd', kind: 'deal-id' }, { mask: 'ДОК-d', kind: 'document-number' }])
    )
    expect(out.map(i => [i.kind, i.value, i.route.targetKind, i.route.strategy])).toEqual([
      ['deal-id', '77', 'deal', 'by-id'],
      ['document-number', 'ДОК-5', null, 'via-document'] // document bridge → targetKind null
    ])
  })

  it('folds homoglyphs by the configured alphabet before matching (BOPC↔ВОРС)', () => {
    // Latin mask, purpose in Cyrillic homoglyphs → folded to latin, matches.
    const out = recognizePurposeIntents('оплата BOPC-12/3', settings([{ mask: 'BOPC-dd/d', kind: 'smart-field' }], 'latin'))
    expect(out.map(i => i.kind)).toEqual(['smart-field'])
  })
})
