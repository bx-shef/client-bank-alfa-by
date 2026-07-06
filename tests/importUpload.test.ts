import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_UPLOAD_BYTES,
  decodeAndParse,
  dedupItems,
  uploadErrorMessage,
  validateUploadFile
} from '~/utils/importUpload'

// Fixtures are real windows-1251 statement exports (the ones the user debugs with);
// decodeAndParse must reproduce the parser's output on the actual bytes.
function fixture(rel: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)))
}

describe('validateUploadFile', () => {
  it('accepts a .txt under the size cap', () => {
    expect(validateUploadFile('export.txt', 1024)).toBeNull()
    expect(validateUploadFile('EXPORT.TXT', 1024)).toBeNull() // case-insensitive
  })
  it('rejects wrong extension, empty, and oversize', () => {
    expect(validateUploadFile('scan.pdf', 1024)).toMatch(/Неподдерживаемый тип/)
    expect(validateUploadFile('export.txt', 0)).toMatch(/Пустой/)
    expect(validateUploadFile('export.txt', MAX_UPLOAD_BYTES + 1)).toMatch(/слишком большой/)
  })
})

describe('decodeAndParse (real fixtures, windows-1251)', () => {
  it('parses a client-bank text export into operations', () => {
    const items = decodeAndParse(fixture('client-bank/demo-prior-byn.txt'))
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]).toHaveProperty('direction')
    expect(items[0]).toHaveProperty('amount')
  })

  it('parses a 1CClientBankExchange export into operations', () => {
    const items = decodeAndParse(fixture('1c-exchange/demo-1c.txt'))
    expect(items.length).toBeGreaterThan(0)
  })

  it('throws a helpful message on an unrecognized format', () => {
    const junk = new TextEncoder().encode('not a statement at all')
    expect(() => decodeAndParse(junk)).toThrow(/Неизвестный формат/)
  })
})

describe('uploadErrorMessage', () => {
  it('keeps a sane parser message, falls back otherwise', () => {
    expect(uploadErrorMessage(new Error('Неизвестный формат выписки'))).toBe('Неизвестный формат выписки')
    expect(uploadErrorMessage(new Error('x'.repeat(300)))).toBe('Не удалось разобрать файл')
    expect(uploadErrorMessage('weird')).toBe('Не удалось разобрать файл')
  })
})

describe('dedupItems', () => {
  it('drops operations with the same account|docId (same file dropped twice)', () => {
    const items = decodeAndParse(fixture('client-bank/demo-prior-byn.txt'))
    const doubled = [...items, ...items]
    expect(dedupItems(doubled)).toHaveLength(items.length)
  })
})
