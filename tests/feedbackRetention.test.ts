import { describe, expect, it } from 'vitest'
import { fileEmbedLines } from '../app/utils/feedback'
import {
  FEEDBACK_RETENTION_DAYS,
  REDACTION_MARKER,
  hasStatementBlock,
  isPurgeable,
  planRetention,
  redactStatementBlocks,
  resolveRetentionDays
} from '../app/utils/feedbackRetention'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-07-22T00:00:00Z')

/** Build a realistic issue body carrying a statement block (via the real writer, so the markers can't drift). */
function bodyWithStatement(text = 'СЧЕТ 3012000000001\nСумма 1000.00 BYN\nООО Ромашка'): string {
  return ['## Отзыв', '', '<pre><code>комментарий</code></pre>', ...fileEmbedLines(text)].join('\n')
}

describe('resolveRetentionDays', () => {
  it('defaults on blank/undefined/invalid, clamps range', () => {
    expect(resolveRetentionDays(undefined)).toBe(FEEDBACK_RETENTION_DAYS)
    expect(resolveRetentionDays('')).toBe(FEEDBACK_RETENTION_DAYS)
    expect(resolveRetentionDays('abc')).toBe(FEEDBACK_RETENTION_DAYS)
    expect(resolveRetentionDays(0)).toBe(FEEDBACK_RETENTION_DAYS)
    expect(resolveRetentionDays(-5)).toBe(FEEDBACK_RETENTION_DAYS)
    expect(resolveRetentionDays('14')).toBe(14)
    expect(resolveRetentionDays(9999)).toBe(365)
    expect(resolveRetentionDays(30.9)).toBe(30)
  })
})

describe('redactStatementBlocks', () => {
  it('replaces the statement block with the marker and reports changed', () => {
    const body = bodyWithStatement()
    expect(hasStatementBlock(body)).toBe(true)
    const { body: redacted, changed } = redactStatementBlocks(body)
    expect(changed).toBe(true)
    expect(redacted).toContain(REDACTION_MARKER)
    expect(redacted).not.toContain('Ромашка')
    expect(redacted).not.toContain('<summary>')
    // Non-PII metadata survives.
    expect(redacted).toContain('## Отзыв')
    expect(redacted).toContain('комментарий')
  })

  it('is idempotent — a second pass is a no-op', () => {
    const once = redactStatementBlocks(bodyWithStatement()).body
    const twice = redactStatementBlocks(once)
    expect(twice.changed).toBe(false)
    expect(twice.body).toBe(once)
  })

  it('redacts multiple blocks in one body', () => {
    const body = [bodyWithStatement('первая выписка A'), bodyWithStatement('вторая выписка B')].join('\n\n')
    const { body: redacted } = redactStatementBlocks(body)
    expect(redacted).not.toContain('выписка A')
    expect(redacted).not.toContain('выписка B')
    expect(redacted.match(new RegExp(REDACTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
  })

  it('no statement block → unchanged', () => {
    const body = '## Отзыв\n\nтолько комментарий, файла нет'
    expect(hasStatementBlock(body)).toBe(false)
    expect(redactStatementBlocks(body)).toEqual({ body, changed: false })
  })

  it('hasStatementBlock is stateless across repeated calls (global-regex guard)', () => {
    const body = bodyWithStatement()
    expect(hasStatementBlock(body)).toBe(true)
    expect(hasStatementBlock(body)).toBe(true)
    expect(hasStatementBlock(body)).toBe(true)
  })
})

describe('isPurgeable', () => {
  const closed = (closedAt: string, body = bodyWithStatement()) =>
    ({ number: 1, state: 'closed', closed_at: closedAt, body })

  it('closed past the window with a block → purgeable', () => {
    expect(isPurgeable(closed('2026-06-01T00:00:00Z'), NOW, 30)).toBe(true)
  })

  it('closed but within the window → skip', () => {
    expect(isPurgeable(closed('2026-07-20T00:00:00Z'), NOW, 30)).toBe(false)
  })

  it('open issue → skip regardless of age', () => {
    expect(isPurgeable({ number: 1, state: 'open', closed_at: null, body: bodyWithStatement() }, NOW, 30)).toBe(false)
  })

  it('closed, aged, but body already redacted → skip (idempotent)', () => {
    const redacted = redactStatementBlocks(bodyWithStatement()).body
    expect(isPurgeable(closed('2026-01-01T00:00:00Z', redacted), NOW, 30)).toBe(false)
  })

  it('missing/invalid closed_at → skip (fail-safe)', () => {
    expect(isPurgeable({ number: 1, state: 'closed', closed_at: null, body: bodyWithStatement() }, NOW, 30)).toBe(false)
    expect(isPurgeable({ number: 1, state: 'closed', closed_at: 'nonsense', body: bodyWithStatement() }, NOW, 30)).toBe(false)
  })

  it('cutoff boundary: exactly N days old (window elapsed) purges; one second younger keeps', () => {
    const atCutoff = new Date(NOW - 30 * DAY).toISOString()
    expect(isPurgeable(closed(atCutoff), NOW, 30)).toBe(true)
    const younger = new Date(NOW - 30 * DAY + 1000).toISOString()
    expect(isPurgeable(closed(younger), NOW, 30)).toBe(false)
  })
})

describe('planRetention', () => {
  it('returns only purgeable issues with redacted bodies', () => {
    const issues = [
      { number: 10, state: 'closed', closed_at: '2026-06-01T00:00:00Z', body: bodyWithStatement('old A') },
      { number: 11, state: 'closed', closed_at: '2026-07-21T00:00:00Z', body: bodyWithStatement('recent B') },
      { number: 12, state: 'open', closed_at: null, body: bodyWithStatement('open C') },
      { number: 13, state: 'closed', closed_at: '2026-05-01T00:00:00Z', body: 'no block' }
    ]
    const plan = planRetention(issues, NOW, 30)
    expect(plan.map(p => p.number)).toEqual([10])
    expect(plan[0]!.body).toContain(REDACTION_MARKER)
    expect(plan[0]!.body).not.toContain('old A')
  })
})
