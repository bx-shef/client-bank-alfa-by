import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_CLIENT_BANK_CHARS, parseClientBankText } from '~/utils/clientBankText'

// Characterization tests for the ported client-bank text parser (see #19).
// Fixtures are windows-1251 — decode them the way a real caller must.
// NOTE: account numbers / bank name asserted below are the SYNTHETIC values from
// the anonymized fixtures; update them in lockstep if a fixture is regenerated.
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

  // #19 fix: `DocID` (the `account|docId` idempotency key) and `Cod` (counterparty
  // bank BIC) are now captured per-row, not dropped into `unrouted`.
  it('captures DocID and Cod (BIC) per row', () => {
    expect(parsed.OUT_PARAM.items[0]!.DocID).toBe('100000001')
    expect(parsed.OUT_PARAM.items[0]!.Cod).toBe('PJCBBY2X')
    expect(parsed.OUT_PARAM.unrouted.DocID).toBeUndefined()
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

  it('drops unrouted keys into the unrouted bucket (e.g. bank name)', () => {
    expect(parsed.OUT_PARAM.unrouted.MyBankName).toContain('Приорбанк')
  })

  it('has no explicit I3 currency marker (BYN inferred downstream)', () => {
    expect(parsed.OUT_PARAM.unrouted.I3).toBeUndefined()
  })

  it('parses IN_PARAM (its lone Date1 key is unrouted, no items)', () => {
    expect(parsed.IN_PARAM.items).toHaveLength(0)
    expect(parsed.IN_PARAM.unrouted.Date1).toBe('28.09.2023')
  })
})

describe('parseClientBankText — foreign-currency statement (Type=600, I3=CNY)', () => {
  const parsed = parseClientBankText(loadFixture('demo-prior-cny.txt'))

  it('reads the file header', () => {
    expect(parsed.GENERAL.TYPE).toBe('600')
    expect(parsed.GENERAL.ACC).toBe('BY86PJCB30120000000000000156')
  })

  it('parses both operation rows in file order with their amounts', () => {
    expect(parsed.OUT_PARAM.items).toHaveLength(2)
    expect(parsed.OUT_PARAM.items[0]!.Num).toBe('40')
    expect(parsed.OUT_PARAM.items[0]!.Cre).toBe('534.61')
    // Explicit OpDate of the first row overrides its DocDate-derived alias.
    expect(parsed.OUT_PARAM.items[0]!.OpDate).toBe('27.09.2023 23:12:03')
    expect(parsed.OUT_PARAM.items[1]!.Num).toBe('8')
    expect(parsed.OUT_PARAM.items[1]!.Cre).toBe('34362.51')
  })

  it('exposes the explicit I3 currency marker via the unrouted bucket', () => {
    expect(parsed.OUT_PARAM.unrouted.I3).toBe('CNY')
  })

  it('aliases InCre→RestIn (header) and OutCre→RestOut (footer)', () => {
    expect(parsed.OUT_PARAM.header.InCre).toBe('190921.06')
    expect(parsed.OUT_PARAM.header.RestIn).toBe('190921.06')
    expect(parsed.OUT_PARAM.footer.OutCre).toBe('225818.18')
    expect(parsed.OUT_PARAM.footer.RestOut).toBe('225818.18')
  })

  // #19 fix: each of the two operations keeps its own DocID (no more last-write-wins).
  it('captures each operation’s own DocID per row', () => {
    expect(parsed.OUT_PARAM.items[0]!.DocID).toBe('100000002')
    expect(parsed.OUT_PARAM.items[1]!.DocID).toBe('100000003')
    expect(parsed.OUT_PARAM.unrouted.DocID).toBeUndefined()
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

  it('seeds OpDate from DocDate when no explicit OpDate line follows', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^DocDate=01.01.2024^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items[0]!.OpDate).toBe('01.01.2024')
  })

  it('aliases DocTime into OpTime on the row', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^DocDate=01.01.2024^\n^DocTime=09:00:00^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items[0]!.DocTime).toBe('09:00:00')
    expect(parsed.OUT_PARAM.items[0]!.OpTime).toBe('09:00:00')
  })

  it('preserves "=" inside a value (splits on the first "=" only)', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^DocDate=01.01.2024^\n^Nazn=ОПЛАТА=НДС 20%^'
    )
    expect(parsed.OUT_PARAM.items[0]!.Nazn).toBe('ОПЛАТА=НДС 20%')
  })

  it('keeps the full title even when it contains a hyphen', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  Выписка - с приложениями\n[OUT_PARAM]'
    )
    expect(parsed.GENERAL.TITLE).toBe('Выписка - с приложениями')
  })

  it('routes DateIn to the header without slash-normalization', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^DateIn=28/09/2023^\n^DocDate=01.01.2024^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.header.DateIn).toBe('28/09/2023')
    expect(parsed.OUT_PARAM.items[0]!.DateIn).toBeUndefined()
  })

  it('handles CRLF (Windows) line endings', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\r\n[OUT_PARAM]\r\n^DocDate=01.01.2024^\r\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items).toHaveLength(1)
    expect(parsed.OUT_PARAM.items[0]!.Num).toBe('1')
  })

  it('ignores item keys that appear before the first DocDate', () => {
    const parsed = parseClientBankText(
      '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n^Num=999^\n^DocDate=01.01.2024^\n^Num=1^'
    )
    expect(parsed.OUT_PARAM.items).toHaveLength(1)
    expect(parsed.OUT_PARAM.items[0]!.Num).toBe('1')
  })

  it('rejects an oversized input before parsing (DoS guard, #19)', () => {
    const big = '***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]\n' + 'x'.repeat(50)
    // Tiny explicit cap → throws with a size message, never builds the line array.
    expect(() => parseClientBankText(big, 16)).toThrow(/too large/)
    // A valid statement under the cap still parses.
    expect(() => parseClientBankText(big, 10_000)).not.toThrow()
    // The default cap is a large, sane number (~20 MB).
    expect(MAX_CLIENT_BANK_CHARS).toBeGreaterThan(1_000_000)
  })
})
