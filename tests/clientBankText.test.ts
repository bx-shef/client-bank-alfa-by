import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseClientBankText } from '~/utils/clientBankText'

// Characterization tests for the ported client-bank text parser (see #19).
// Fixtures are windows-1251 — decode them the way a real caller must.
function loadFixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/client-bank/${name}`, import.meta.url))
  return new TextDecoder('windows-1251').decode(readFileSync(path))
}

describe('parseClientBankText — BYN statement (Type=400, no I3 marker)', () => {
  const parsed = parseClientBankText(loadFixture('demo-prior-byn.txt'))

  it('reads the file header (type, account, title)', () => {
    expect(parsed.GENERAL.TYPE).toBe('400')
    expect(parsed.GENERAL.ACC).toBe('BY86PJCB30120000000000000933')
    expect(parsed.GENERAL.TITLE).toContain('Выписка')
  })

  it('parses exactly one operation row with its fields', () => {
    expect(parsed.OUT_PARAM.items).toHaveLength(1)
    const row = parsed.OUT_PARAM.items[0]!
    expect(row.Num).toBe('4234')
    expect(row.Db).toBe('50.00')
    // OpDate key (timestamp) overrides the DocDate-derived alias.
    expect(row.OpDate).toBe('28.09.2023 10:19:04')
  })

  // Known rough edge (#19): `DocID` is NOT in the item-key dictionary, so it is
  // not captured per-row — it lands in the shared `wtf` bucket (last write wins).
  // The refactor must capture it per row; it is the `account|docId` idempotency key.
  it('does NOT capture DocID per row (lands in wtf — refactor target)', () => {
    expect(parsed.OUT_PARAM.items[0]!.DocID).toBeUndefined()
    expect(parsed.OUT_PARAM.wtf.DocID).toBe('100000001')
  })

  it('aliases UNNRec into KorUNP on the row', () => {
    const row = parsed.OUT_PARAM.items[0]!
    expect(row.UNNRec).toBe('191234567')
    expect(row.KorUNP).toBe(row.UNNRec)
  })

  it('routes opening/closing balances to header/footer with aliases', () => {
    expect(parsed.OUT_PARAM.header.CrIn).toBe('3329.82')
    expect(parsed.OUT_PARAM.header.RestIn).toBe('3329.82')
    expect(parsed.OUT_PARAM.footer.CrOut).toBe('3279.82')
    expect(parsed.OUT_PARAM.footer.RestOut).toBe('3279.82')
  })

  it('drops unrouted keys into the wtf bucket (e.g. bank name)', () => {
    expect(parsed.OUT_PARAM.wtf.MyBankName).toContain('Приорбанк')
  })

  it('has no explicit I3 currency marker (BYN inferred downstream)', () => {
    expect(parsed.OUT_PARAM.wtf.I3).toBeUndefined()
  })
})

describe('parseClientBankText — foreign-currency statement (Type=600, I3=CNY)', () => {
  const parsed = parseClientBankText(loadFixture('demo-prior-cny.txt'))

  it('reads the file header', () => {
    expect(parsed.GENERAL.TYPE).toBe('600')
    expect(parsed.GENERAL.ACC).toBe('BY86PJCB30120000000000000156')
  })

  it('parses both operation rows in file order', () => {
    expect(parsed.OUT_PARAM.items).toHaveLength(2)
    expect(parsed.OUT_PARAM.items[0]!.Num).toBe('40')
    expect(parsed.OUT_PARAM.items[1]!.Num).toBe('8')
    expect(parsed.OUT_PARAM.items[1]!.Cre).toBe('34362.51')
  })

  it('exposes the explicit I3 currency marker via the wtf bucket', () => {
    expect(parsed.OUT_PARAM.wtf.I3).toBe('CNY')
  })
})

describe('parseClientBankText — behavior', () => {
  it('throws on an unrecognized file', () => {
    expect(() => parseClientBankText('not a statement')).toThrow('Unexpected file format')
  })

  it('normalizes the date separator in DocDate (28/09/2023 -> 28.09.2023)', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^DocDate=28/09/2023^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items[0]!.DocDate).toBe('28.09.2023')
  })

  it('ignores item keys that appear before the first DocDate', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^Num=999^\n^DocDate=01.01.2024^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items).toHaveLength(1)
    expect(parsed.OUT_PARAM.items[0]!.Num).toBe('1')
  })
})
