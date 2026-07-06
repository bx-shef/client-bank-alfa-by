import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  decodeAndParse,
  dedupItems,
  processUploadBatch,
  uploadErrorMessage,
  validateUploadFile,
  type UploadFileLike
} from '~/utils/importUpload'

// Fixtures are real windows-1251 statement exports (the ones the user debugs with);
// decodeAndParse must reproduce the parser's output on the actual bytes.
function fixture(rel: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)))
}

// A File-like backed by fixture bytes (or arbitrary bytes) for the batch processor.
function fileLike(name: string, bytes: Uint8Array): UploadFileLike {
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes }
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

  it('parses a Type=4 «за период» Альфа export (multiple operations, no mojibake)', () => {
    const items = decodeAndParse(fixture('client-bank/demo-type4-alfa.txt'))
    expect(items.length).toBeGreaterThan(1)
    expect(items.every(it => typeof it.amount === 'number' && it.direction)).toBe(true)
    // A correct windows-1251 decode leaves no replacement char in the output.
    expect(JSON.stringify(items)).not.toContain('�')
  })

  it('decodes Cyrillic content correctly (windows-1251, not mojibake)', () => {
    const items = decodeAndParse(fixture('client-bank/demo-prior-byn.txt'))
    const blob = JSON.stringify(items)
    expect(blob).toMatch(/[А-Яа-я]/)
    expect(blob).not.toContain('�')
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

describe('processUploadBatch', () => {
  const good = fixture('client-bank/demo-prior-byn.txt')
  const junk = new TextEncoder().encode('not a statement at all')

  it('parses each file in isolation — one bad file never sinks the rest', async () => {
    const { results, truncated } = await processUploadBatch([
      fileLike('a.txt', good),
      fileLike('bad.txt', junk),
      fileLike('b.txt', good)
    ])
    expect(truncated).toBe(0)
    expect(results.map(r => r.ok)).toEqual([true, false, true])
    expect(results[0]!.items.length).toBeGreaterThan(0)
    expect(results[1]!.error).toMatch(/формат/i)
  })

  it('surfaces per-file validation errors without decoding', async () => {
    const { results } = await processUploadBatch([
      fileLike('scan.pdf', good),
      fileLike('empty.txt', new Uint8Array(0))
    ])
    expect(results[0]!.error).toMatch(/Неподдерживаемый тип/)
    expect(results[1]!.error).toMatch(/Пустой/)
  })

  it('caps the batch at MAX_UPLOAD_FILES and reports how many were dropped', async () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 3 }, (_, i) => fileLike(`f${i}.txt`, good))
    const { results, truncated } = await processUploadBatch(many)
    expect(results).toHaveLength(MAX_UPLOAD_FILES)
    expect(truncated).toBe(3)
  })

  it('yields to the injected defer between processed files', async () => {
    let defers = 0
    const bump = async () => {
      defers++
    }
    await processUploadBatch([fileLike('a.txt', good), fileLike('b.txt', good)], bump)
    expect(defers).toBe(2)
  })
})
