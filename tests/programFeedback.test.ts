import { describe, expect, it } from 'vitest'
import {
  buildProgramFeedbackIssue,
  programSignalSignature,
  summarizeConfusion,
  CONFUSION_KINDS,
  type ProgramSignal
} from '~/utils/programFeedback'

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

  it('format: notes the provider + expected formats, non-PII', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', signal: { type: 'format', providerId: 'prior-by' } })
    expect(p.labels).toEqual(labels)
    expect(p.title).toContain('формат')
    expect(p.body).toContain('Провайдер:** `prior-by`')
    expect(p.body).toContain('Разбор выписки упал') // softened: fires on any parse throw, not only format
    expect(p.body).toContain('только по каналу «сотрудник»') // no file embedded here
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
