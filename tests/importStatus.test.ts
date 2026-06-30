import { describe, expect, it } from 'vitest'
import { formatRelativeTime, importStateMeta, pluralRu } from '~/utils/importStatus'

describe('pluralRu', () => {
  it('picks the right Russian form', () => {
    const f: [string, string, string] = ['минуту', 'минуты', 'минут']
    expect(pluralRu(1, f)).toBe('минуту')
    expect(pluralRu(2, f)).toBe('минуты')
    expect(pluralRu(5, f)).toBe('минут')
    expect(pluralRu(11, f)).toBe('минут') // 11–14 → many
    expect(pluralRu(21, f)).toBe('минуту')
    expect(pluralRu(0, f)).toBe('минут')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-06-30T12:00:00.000Z')

  it('returns empty for null/invalid', () => {
    expect(formatRelativeTime(null, now)).toBe('')
    expect(formatRelativeTime('not-a-date', now)).toBe('')
  })

  it('says "только что" under a minute (and for future times)', () => {
    expect(formatRelativeTime('2026-06-30T11:59:30.000Z', now)).toBe('только что')
    expect(formatRelativeTime('2026-06-30T12:05:00.000Z', now)).toBe('только что')
  })

  it('formats minutes and hours with correct plurals', () => {
    expect(formatRelativeTime('2026-06-30T11:55:00.000Z', now)).toBe('5 минут назад')
    expect(formatRelativeTime('2026-06-30T11:59:00.000Z', now)).toBe('1 минуту назад')
    expect(formatRelativeTime('2026-06-30T10:00:00.000Z', now)).toBe('2 часа назад')
  })

  it('says "вчера" and falls back to an absolute date for older', () => {
    expect(formatRelativeTime('2026-06-29T11:00:00.000Z', now)).toBe('вчера')
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z', now)).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
  })
})

describe('importStateMeta', () => {
  it('maps every state to a label and colour', () => {
    for (const s of ['never', 'running', 'ok', 'error'] as const) {
      const meta = importStateMeta(s)
      expect(meta.label.trim()).not.toBe('')
      expect(meta.color).toMatch(/^air-/)
    }
  })

  it('uses success for ok and alert for error', () => {
    expect(importStateMeta('ok').color).toBe('air-primary-success')
    expect(importStateMeta('error').color).toBe('air-primary-alert')
  })
})
