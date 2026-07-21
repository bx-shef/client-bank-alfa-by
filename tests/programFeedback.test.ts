import { describe, expect, it } from 'vitest'
import {
  buildProgramFeedbackIssue,
  makeProgramSample,
  programSignalSignature,
  summarizeConfusion,
  CONFUSION_KINDS,
  type ProgramSignal
} from '~/utils/programFeedback'
import type { StatementItem } from '~/types/statement'

function sampleItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY00OUR',
    docId: 'D1',
    direction: 'credit',
    amount: 123.45,
    currency: 'BYN',
    purpose: 'оплата по счёту 42',
    counterparty: { name: 'ООО Ромашка', unp: '190000000', account: 'BY11ROMASHKA' },
    acceptDate: '2026-07-21',
    ...over
  }
}

describe('summarizeConfusion', () => {
  it('normalizes counts, lists fired kinds, and totals', () => {
    const r = summarizeConfusion({ unmatched: 2, ambiguous: 0, manual: 3 })
    expect(r.counts).toEqual({ unmatched: 2, ambiguous: 0, manual: 3 })
    expect(r.kinds).toEqual(['unmatched', 'manual'])
    expect(r.total).toBe(5)
  })
  it('clamps negative / non-finite / fractional counts to a non-negative integer', () => {
    const r = summarizeConfusion({ unmatched: -1, ambiguous: Number.NaN, manual: 1.9 })
    expect(r.counts).toEqual({ unmatched: 0, ambiguous: 0, manual: 1 })
    expect(r.total).toBe(1)
  })
  it('total 0 when nothing is confused (the caller then files nothing)', () => {
    expect(summarizeConfusion({ unmatched: 0, ambiguous: 0, manual: 0 }).total).toBe(0)
    expect(summarizeConfusion({}).kinds).toEqual([])
  })
})

describe('programSignalSignature', () => {
  it('confusion: namespaced, stable, only fired kinds', () => {
    const a: ProgramSignal = { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 2 } }
    expect(programSignalSignature(a)).toBe('confusion:unmatched+manual')
  })
  it('fail-open: namespaced, deduped + sorted entities', () => {
    const s: ProgramSignal = { type: 'fail-open', entities: ['deal', 'invoice', 'deal'] }
    expect(programSignalSignature(s)).toBe('failopen:deal+invoice')
  })
  it('format: namespaced by sanitized provider (default manual)', () => {
    expect(programSignalSignature({ type: 'format', providerId: 'alfa-by' })).toBe('format:alfa-by')
    expect(programSignalSignature({ type: 'format' })).toBe('format:manual')
    expect(programSignalSignature({ type: 'format', providerId: '../evil' })).toBe('format:evil') // stripped
  })
  it('types never collide (confusion vs fail-open vs format)', () => {
    const sigs = new Set([
      programSignalSignature({ type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 } }),
      programSignalSignature({ type: 'fail-open', entities: ['unmatched'] }),
      programSignalSignature({ type: 'format', providerId: 'unmatched' })
    ])
    expect(sigs.size).toBe(3)
  })
})

describe('buildProgramFeedbackIssue', () => {
  const labels = ['agent-feedback', 'feedback:problem']

  it('confusion: lists only fired kinds with counts, non-PII', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'abc123', commitSha: 'deadbee', signal: { type: 'confusion', counts: { unmatched: 2, ambiguous: 0, manual: 1 } } })
    expect(p.labels).toEqual(labels)
    expect(p.body).toContain('member_id:** `abc123`')
    expect(p.body).toContain('Сборка:** `deadbee`')
    expect(p.body).toContain('не найдена компания по счёту:** 2')
    expect(p.body).toContain('ручная очередь:** 1')
    expect(p.body).not.toContain('неоднозначное разнесение') // ambiguous=0 → omitted
    expect(p.title).toContain('портал abc123')
    expect(p.title).toContain('(3)')
    expect(p.body).toContain('Без данных клиента')
  })

  it('fail-open: lists the affected entity types + explanation, non-PII', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'fail-open', entities: ['invoice', 'deal'] } })
    expect(p.labels).toEqual(labels)
    expect(p.title).toContain('fail-open')
    expect(p.body).toContain('Сущности:** `deal, invoice`') // sorted
    expect(p.body).toContain('не** отсеиваются по стадии')
    expect(p.body).toContain('Без данных клиента')
  })

  it('format WITHOUT a file: provider + expected formats, non-PII, no embed', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'format', providerId: 'prior-by' } })
    expect(p.labels).toEqual(labels)
    expect(p.title).toContain('формат')
    expect(p.body).toContain('Провайдер:** `prior-by`')
    expect(p.body).toContain('Разбор выписки упал') // softened: fires on any parse throw, not only format
    expect(p.body).not.toContain('<details>') // no file attached
    expect(p.body).toContain('Без данных клиента') // footer: non-PII
  })

  it('format WITH the failed file: embeds it (inert) and flags client data', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'format', providerId: 'manual', fileText: '***** ^Type=99\nмусор</code></pre>x' } })
    expect(p.body).toContain('**Файл, который не разобрался**')
    expect(p.body).toContain('<details><summary>Показать содержимое</summary>')
    expect(p.body).toContain('^Type=99')
    expect(p.body).toContain('&lt;/code&gt;&lt;/pre&gt;') // escaped — can't break the block
    expect(p.body).not.toContain('мусор</code></pre>x')
    expect(p.body).toContain('Содержит данные клиента') // footer flips: PII attached
  })

  it('format with a blank / all-hostile file: no embed AND the footer denies client data', () => {
    // The `hasClientData` guard is stripHostileChars(fileText).trim(), not plain truthiness — a
    // whitespace / zero-width-only file must produce neither an embed nor a "содержит данные" footer
    // (else the footer would lie about attached PII that isn't actually there).
    const ZWSP = String.fromCharCode(0x200b)
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'format', providerId: 'manual', fileText: `  ${ZWSP}\n\t` } })
    expect(p.body).not.toContain('<details>')
    expect(p.body).not.toContain('Файл, который не разобрался')
    expect(p.body).toContain('Без данных клиента')
  })

  it('fail-open: renders entity names inert (backtick-strip + HTML-escape, code-span-safe)', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'fail-open', entities: ['<b>', 'de`al'] } })
    expect(p.body).toContain('&lt;b&gt;') // HTML-escaped
    expect(p.body).not.toContain('<b>')
    expect(p.body).not.toContain('de`al') // backtick stripped so it can't close the code span
  })

  it('carries NO client data and dashes an absent sha', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 1, manual: 1 } } })
    expect(p.body).toContain('Сборка:** `—`')
  })

  it('HTML-escapes member_id / sha defensively', () => {
    const p = buildProgramFeedbackIssue({ memberId: '<x>', commitSha: '<y>', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 } } })
    expect(p.body).toContain('&lt;x&gt;')
    expect(p.body).not.toContain('<x>')
  })

  it('CONFUSION_KINDS is exhaustive over the confusion body (all three lines when all fire)', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 1, manual: 1 } } })
    for (const k of CONFUSION_KINDS) expect(typeof k).toBe('string')
    expect(p.body.match(/^- \*\*[^:]+:\*\* \d+$/gm)?.length).toBe(3)
  })
})

describe('program op sample', () => {
  it('makeProgramSample extracts the redacted fields', () => {
    const s = makeProgramSample(sampleItem(), 'unmatched')
    expect(s).toEqual({
      kind: 'unmatched',
      direction: 'credit',
      amount: 123.45,
      currency: 'BYN',
      purpose: 'оплата по счёту 42',
      counterparty: 'ООО Ромашка',
      counterpartyAccount: 'BY11ROMASHKA',
      counterpartyUnp: '190000000'
    })
  })

  it('confusion issue with a sample renders the op section (amount, purpose, counterparty)', () => {
    const p = buildProgramFeedbackIssue({
      memberId: 'm',
      signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 }, sample: makeProgramSample(sampleItem(), 'unmatched') }
    })
    expect(p.body).toContain('**Пример операции**')
    expect(p.body).toContain('Сумма:** `123.45 BYN`')
    expect(p.body).toContain('Назначение:** `оплата по счёту 42`')
    expect(p.body).toContain('Контрагент:** `ООО Ромашка`')
    expect(p.body).toContain('Счёт контрагента:** `BY11ROMASHKA`')
    expect(p.body).toContain('УНП:** `190000000`')
  })

  it('omits the sample section when no sample is present', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 } } })
    expect(p.body).not.toContain('Пример операции')
  })

  it('renders sample fields INERT — HTML-escape, backtick-strip, newline-collapse (payer-controlled)', () => {
    const hostile = sampleItem({
      purpose: 'a`b\nc</code></pre>d',
      counterparty: { name: '<script>x</script>', unp: '1', account: 'BY`1' }
    })
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 }, sample: makeProgramSample(hostile, 'unmatched') } })
    expect(p.body).toContain('ab c&lt;/code&gt;&lt;/pre&gt;d') // backtick stripped, newline→space, escaped
    expect(p.body).not.toContain('a`b')
    expect(p.body).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(p.body).not.toContain('<script>')
    expect(p.body).toContain('BY1') // backtick stripped from account
  })

  it('strips Trojan-Source bidi / zero-width chars from payer-controlled sample fields', () => {
    const ZWSP = String.fromCharCode(0x200b)
    const RLO = String.fromCharCode(0x202e) // right-to-left override
    const hostile = sampleItem({ purpose: `опла${ZWSP}та${RLO}X`, counterparty: { name: `ООО${RLO}`, unp: '1', account: 'BY1' } })
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 }, sample: makeProgramSample(hostile, 'unmatched') } })
    expect(p.body).not.toContain(ZWSP)
    expect(p.body).not.toContain(RLO)
    expect(p.body).toContain('оплата') // reconstituted after strip
  })

  it('footer flags client data when a sample is attached, and denies it otherwise', () => {
    const withSample = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 }, sample: makeProgramSample(sampleItem(), 'unmatched') } })
    expect(withSample.body).toContain('Содержит данные клиента')
    expect(withSample.body).not.toContain('Без данных клиента')
    const noSample = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 } } })
    expect(noSample.body).toContain('Без данных клиента')
    // fail-open / format never claim client data
    expect(buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'fail-open', entities: ['deal'] } }).body).toContain('Без данных клиента')
  })

  it('drops empty sample fields (e.g. физлицо without УНП) rather than blank lines', () => {
    const p = buildProgramFeedbackIssue({
      memberId: 'm',
      signal: { type: 'confusion', counts: { unmatched: 1, ambiguous: 0, manual: 0 }, sample: makeProgramSample(sampleItem({ counterparty: { name: '', unp: '', account: '' } }), 'unmatched') }
    })
    expect(p.body).not.toContain('Контрагент:')
    expect(p.body).not.toContain('Счёт контрагента:')
    expect(p.body).not.toContain('УНП:')
  })
})
