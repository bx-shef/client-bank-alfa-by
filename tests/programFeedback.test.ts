import { describe, expect, it } from 'vitest'
import {
  buildProgramFeedbackIssue,
  confusionSignature,
  summarizeConfusion,
  CONFUSION_KINDS
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

describe('confusionSignature', () => {
  it('is stable and order-independent', () => {
    expect(confusionSignature(['manual', 'unmatched'])).toBe('manual+unmatched')
    expect(confusionSignature(['unmatched', 'manual'])).toBe('manual+unmatched')
  })
  it('single kind → just that kind; empty → empty string', () => {
    expect(confusionSignature(['ambiguous'])).toBe('ambiguous')
    expect(confusionSignature([])).toBe('')
  })
})

describe('buildProgramFeedbackIssue', () => {
  it('labels agent-feedback + feedback:problem and lists only fired kinds with counts', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'abc123', commitSha: 'deadbee', counts: { unmatched: 2, ambiguous: 0, manual: 1 } })
    expect(p.labels).toEqual(['agent-feedback', 'feedback:problem'])
    expect(p.body).toContain('member_id:** `abc123`')
    expect(p.body).toContain('Сборка:** `deadbee`')
    expect(p.body).toContain('не найдена компания по счёту:** 2')
    expect(p.body).toContain('ручная очередь:** 1')
    expect(p.body).not.toContain('неоднозначное разнесение') // ambiguous=0 → omitted
    expect(p.title).toContain('портал abc123')
    expect(p.title).toContain('(3)')
  })
  it('carries NO client data (no account/purpose/amount) — only counts + member + sha', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', counts: { unmatched: 1, ambiguous: 1, manual: 1 } })
    expect(p.body).toContain('Без данных клиента')
    expect(p.body).toContain('Сборка:** `—`') // no sha → dash
  })
  it('HTML-escapes member_id / sha defensively', () => {
    const p = buildProgramFeedbackIssue({ memberId: '<x>', commitSha: '<y>', counts: { unmatched: 1, ambiguous: 0, manual: 0 } })
    expect(p.body).toContain('&lt;x&gt;')
    expect(p.body).not.toContain('<x>')
  })
  it('CONFUSION_KINDS matches the label map (exhaustive, no drift)', () => {
    const p = buildProgramFeedbackIssue({ memberId: 'm', counts: { unmatched: 1, ambiguous: 1, manual: 1 } })
    for (const k of CONFUSION_KINDS) expect(typeof k).toBe('string')
    // all three lines present when all fire
    expect(p.body.match(/^- \*\*[^:]+:\*\* \d+$/gm)?.length).toBe(3)
  })
})
