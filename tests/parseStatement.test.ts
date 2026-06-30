import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseClientBankText } from '~/utils/clientBankText'
import { maskAccount, truncText, formatParsed } from '../scripts/lib/statement-format.ts'

describe('maskAccount', () => {
  it('keeps the last 4 of a long account', () => {
    expect(maskAccount('BY13ALFA12340000933')).toBe('****0933')
  })
  it('fully masks short values so nothing leaks', () => {
    expect(maskAccount('1234')).toBe('****')
    expect(maskAccount('12')).toBe('****')
  })
  it('shows ? for an empty account', () => {
    expect(maskAccount('')).toBe('?')
  })
})

describe('truncText', () => {
  it('truncates long strings', () => {
    expect(truncText('abcdef', 3)).toBe('abc…')
  })
  it('passes short/empty/undefined through', () => {
    expect(truncText('ab', 3)).toBe('ab')
    expect(truncText(undefined, 3)).toBe('')
  })
})

describe('formatParsed (integration with the canonical parser + a CP1251 fixture)', () => {
  const text = new TextDecoder('windows-1251').decode(
    readFileSync('tests/fixtures/client-bank/demo-prior-byn.txt')
  )
  const lines = formatParsed(parseClientBankText(text))

  it('renders a GENERAL line with the account masked (never the full number)', () => {
    const general = lines.find(l => l.startsWith('GENERAL:'))
    expect(general).toBeDefined()
    expect(general).toContain('****0933')
    expect(general).not.toMatch(/\d{10,}/) // no long raw account number leaked
  })
  it('renders both statement sections', () => {
    expect(lines.some(l => l.includes('[IN_PARAM]'))).toBe(true)
    expect(lines.some(l => l.includes('[OUT_PARAM]'))).toBe(true)
  })
})
