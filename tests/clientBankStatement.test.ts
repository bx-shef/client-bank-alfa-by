import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseClientBankText } from '~/utils/clientBankText'
import {
  clientBankDateToIso,
  currencyFromNumericCode,
  detectStatementCurrency,
  isBelarusianAccount,
  normalizeClientBank,
  normalizeClientBankRow,
  normalizeClientBankStatement,
  rowDocId
} from '~/utils/clientBankStatement'

// Manual-upload provider (#19): parse a client-bank text export → normalize to
// the provider-agnostic StatementItem[]. Verified against the anonymized CP1251
// fixtures (the example files under tests/fixtures/client-bank/).
function loadFixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/client-bank/${name}`, import.meta.url))
  return new TextDecoder('windows-1251').decode(readFileSync(path))
}

describe('clientBankDateToIso', () => {
  it('converts date-only and date+time, drops on garbage', () => {
    expect(clientBankDateToIso('28.09.2023')).toBe('2023-09-28')
    expect(clientBankDateToIso('28.09.2023 10:19:04')).toBe('2023-09-28T10:19:04')
    expect(clientBankDateToIso('')).toBe('')
    expect(clientBankDateToIso('2023-09-28')).toBe('')
    expect(clientBankDateToIso(undefined)).toBe('')
  })
})

describe('detectStatementCurrency', () => {
  const byAcc = (acc: string) => ({ GENERAL: { TYPE: '', ACC: acc, TITLE: '' }, IN_PARAM: { header: {}, items: [], footer: {}, unrouted: {} }, OUT_PARAM: { header: {}, items: [], footer: {}, unrouted: {} } })
  it('BY own-account with no marker defaults to BYN', () => {
    expect(detectStatementCurrency(byAcc('BY86PJCB301200000000000009335'))).toBe('BYN')
  })
  it('explicit I3 alpha-3 marker wins', () => {
    const p = byAcc('BY86...')
    p.OUT_PARAM.unrouted = { I3: 'CNY' }
    expect(detectStatementCurrency(p)).toBe('CNY')
  })
  it('ctx currency seeds when the file has none and the account is not BY', () => {
    expect(detectStatementCurrency(byAcc('LT12...'), 'EUR')).toBe('EUR')
    expect(detectStatementCurrency(byAcc('LT12...'))).toBe('')
  })
  it('numeric CurrCode resolves a foreign «за день» statement, beating the BY-account BYN default (#169)', () => {
    const p = byAcc('BY86MMBN30120000000000000643') // BY valuta account
    p.OUT_PARAM.header = { CurrCode: '643' }
    expect(detectStatementCurrency(p)).toBe('RUB') // not BYN
  })
  it('numeric CurrCode=933 still yields BYN (Type=3 unchanged)', () => {
    const p = byAcc('BY86PJCB30120000000000000933')
    p.OUT_PARAM.header = { CurrCode: '933' }
    expect(detectStatementCurrency(p)).toBe('BYN')
  })
  it('falls back to a numeric I3/I1 when CurrCode is absent (#169)', () => {
    const p3 = byAcc('BY86...')
    p3.OUT_PARAM.unrouted = { I3: '643' }
    expect(detectStatementCurrency(p3)).toBe('RUB')
    const p1 = byAcc('BY86...')
    p1.OUT_PARAM.header = { I1: '840' }
    expect(detectStatementCurrency(p1)).toBe('USD')
  })
  it('an alpha marker still wins over a numeric one', () => {
    const p = byAcc('BY86...')
    p.OUT_PARAM.unrouted = { I3: 'EUR' }
    p.OUT_PARAM.header = { CurrCode: '643' }
    expect(detectStatementCurrency(p)).toBe('EUR')
  })
})

describe('normalizeClientBank — BYN statement (Type=400)', () => {
  const items = normalizeClientBank(parseClientBankText(loadFixture('demo-prior-byn.txt')), { account: '' })

  it('yields one debit operation in BYN', () => {
    expect(items).toHaveLength(1)
    const op = items[0]!
    expect(op.direction).toBe('debit') // Db=50.00 > 0 → расход
    expect(op.amount).toBe(50)
    expect(op.currency).toBe('BYN')
    expect(op.account).toBe('BY86PJCB30120000000000000933') // our account from the file header
    expect(op.docId).toBe('100000001') // now captured per row
    expect(op.docNum).toBe('4234')
    expect(op.operCodeName).toBe('6')
  })

  it('maps the counterparty (name, УНП digits, account, BIC)', () => {
    const cp = items[0]!.counterparty
    expect(cp.unp).toBe('191234567')
    expect(cp.account).toBe('BY86PJCB81010000000000000933')
    expect(cp.bic).toBe('PJCBBY2X')
    expect(cp.name).toContain('СЧЕТОВ')
  })

  it('concatenates the split payment purpose (Nazn + Nazn2)', () => {
    const purpose = items[0]!.purpose
    expect(purpose.startsWith('Плата за')).toBe(true)
    expect(purpose.endsWith('Без НДС.')).toBe(true)
  })

  it('uses OpDate as acceptDate; omits operDate when it equals the acceptance day', () => {
    expect(items[0]!.acceptDate).toBe('2023-09-28T10:19:04')
    expect(items[0]!.operDate).toBeUndefined()
  })
})

describe('normalizeClientBank — foreign-currency statement (Type=600, CNY)', () => {
  const items = normalizeClientBank(parseClientBankText(loadFixture('demo-prior-cny.txt')), { account: '' })

  it('yields two credit operations in CNY with per-row DocIDs', () => {
    expect(items).toHaveLength(2)
    expect(items.every(i => i.direction === 'credit')).toBe(true)
    expect(items.every(i => i.currency === 'CNY')).toBe(true)
    expect(items.map(i => i.docId)).toEqual(['100000002', '100000003'])
  })

  it('reports the account-currency (foreign, …Q) amount, not the BYN equivalent', () => {
    // Row 0 (Num=40) is a revaluation: CreQ=0.00 (0 CNY) though Cre=534.61 (BYN equiv).
    expect(items[0]!.amount).toBe(0)
    // Row 1 (Num=8) is a conversion: CreQ=76762.00 CNY (Cre=34362.51 is the BYN equiv).
    expect(items[1]!.amount).toBe(76762)
  })

  it('keeps operDate when the operation day differs from the acceptance day', () => {
    // Row 0: OpDate 27.09, DocDate 28.09 → distinct, operDate present.
    expect(items[0]!.acceptDate).toBe('2023-09-27T23:12:03')
    expect(items[0]!.operDate).toBe('2023-09-28')
  })
})

describe('normalizeClientBank — behavior', () => {
  it('ctx.account overrides the file own-account', () => {
    const items = normalizeClientBankStatement(parseClientBankText(loadFixture('demo-prior-byn.txt')), { account: 'OVERRIDE-ACC' })
    expect(items[0]!.account).toBe('OVERRIDE-ACC')
  })

  it('direction rule: a positive plain debit → debit, else credit', () => {
    expect(normalizeClientBankRow({ Db: '10.00', DocID: 'd1' }, 'A', 'BYN').direction).toBe('debit')
    expect(normalizeClientBankRow({ Cre: '10.00', DocID: 'c1' }, 'A', 'BYN').direction).toBe('credit')
    expect(normalizeClientBankRow({ DocID: 'z' }, 'A', 'BYN').direction).toBe('credit')
  })

  it('a per-row I2 alpha-3 marker overrides the statement currency', () => {
    const op = normalizeClientBankRow({ Cre: '5.00', I2: 'USD', DocID: 'x' }, 'A', 'BYN')
    expect(op.currency).toBe('USD')
  })

  it('foreign debit takes the account-currency …Q amount, never the BYN equivalent', () => {
    // Db=1000 (BYN equiv) but DebQ=500 (USD) — the reported amount must be 500 USD.
    const op = normalizeClientBankRow({ Db: '1000.00', DebQ: '500.00', I2: 'USD', DocID: 'x' }, 'A', 'BYN')
    expect(op.direction).toBe('debit')
    expect(op.amount).toBe(500)
    expect(op.currency).toBe('USD')
  })

  it('foreign row without a …Q field yields 0, not a mislabeled BYN value', () => {
    const op = normalizeClientBankRow({ Cre: '100.50', I2: 'USD', DocID: 'x' }, 'A', 'BYN')
    expect(op.amount).toBe(0)
    expect(op.currency).toBe('USD')
  })

  it('strips a non-digit УНП prefix (e.g. УНП191234567 → 191234567)', () => {
    expect(normalizeClientBankRow({ Cre: '1', UNNRec: 'УНП191234567', DocID: 'x' }, 'A', 'BYN').counterparty.unp).toBe('191234567')
  })

  it('empty DocID yields an empty docId (dedup key collapses — handled on backend)', () => {
    expect(normalizeClientBankRow({ Cre: '1' }, 'A', 'BYN').docId).toBe('')
  })

  it('never emits NaN for a malformed amount', () => {
    expect(normalizeClientBankRow({ Db: 'not-a-number', DocID: 'x' }, 'A', 'BYN').amount).toBe(0)
  })

  it('an empty statement (no OUT_PARAM rows) normalizes to []', () => {
    const parsed = parseClientBankText('***** ^Type=400^ ^Acc=BY00^  -  T\n[OUT_PARAM]')
    expect(normalizeClientBank(parsed, { account: '' })).toEqual([])
  })

  it('undetermined currency (non-BY account, no marker/ctx) stays empty — UI blocks import', () => {
    const parsed = parseClientBankText('***** ^Type=400^ ^Acc=LT12^  -  T\n[OUT_PARAM]\n^DocDate=01.01.2024^\n^Cre=5.00^\n^DocID=z^')
    expect(normalizeClientBank(parsed, { account: '' })[0]!.currency).toBe('')
  })
})

// Real-file gaps surfaced by user-provided Type=4 exports (issue #19): legacy
// 13-digit BY accounts, and rows with no DocID at all.
describe('real-file robustness', () => {
  it('isBelarusianAccount: IBAN and legacy 13-digit, not RU 20-digit', () => {
    expect(isBelarusianAccount('BY79ALFA30132522540010270000')).toBe(true)
    expect(isBelarusianAccount('3013212016013')).toBe(true) // legacy BY (13 digits)
    expect(isBelarusianAccount('40702810902520000706')).toBe(false) // RU 20-digit
    expect(isBelarusianAccount('LT121000011101001000')).toBe(false)
  })

  it('legacy 13-digit BY account defaults the statement to BYN (was empty before)', () => {
    const parsed = parseClientBankText('***** ^Type=4^ ^Acc=3013212016013^  -  T\n[OUT_PARAM]\n^DocDate=02.11.2016^\n^Num=134^\n^Db=750.00^\n^Credit=0.00^')
    const items = normalizeClientBank(parsed, { account: '' })
    expect(items[0]!.currency).toBe('BYN')
  })

  it('rowDocId prefers a unique id (DocID, then OperationID) over the Num|DocDate fallback (#73)', () => {
    expect(rowDocId({ DocID: 'D1', Num: '134', DocDate: '02.11.2016' })).toBe('D1')
    // Type=4 "за период" export carries OperationID (unique), not DocID.
    expect(rowDocId({ OperationID: 'OPID1', Num: '362', DocDate: '14.05.2026' })).toBe('OPID1')
    expect(rowDocId({ DocID: 'D1', OperationID: 'OPID1' })).toBe('D1') // DocID still wins
    expect(rowDocId({ Num: '134', DocDate: '02.11.2016' })).toBe('134|02.11.2016')
    expect(rowDocId({})).toBe('')
  })

  it('Type=4: two operations sharing a Num get distinct dedup ids via OperationID (#73 — no data loss)', () => {
    // Regression for the real defect: `Num` repeats across different operations
    // in the Type=4 export; without OperationID both collapsed to one dedup key.
    const parsed = parseClientBankText(
      '***** ^Type=4^ ^Acc=BY34ALFA30122H10700010270000^  -  T\n[OUT_PARAM]\n'
      + '^DocDate=14.05.2026^\n^Num=362^\n^Acc=BY70ALFA30132788650010270000^\n^OperationID=OPID1^\n^Db=140.18^\n^Credit=0.00^\n^KorName=A^\n'
      + '^DocDate=14.05.2026^\n^Num=362^\n^Acc=BY80ALFA30132000000010270000^\n^OperationID=OPID2^\n^Db=57.05^\n^Credit=0.00^\n^KorName=B^'
    )
    const items = normalizeClientBank(parsed, { account: '' })
    expect(items.map(i => i.docId)).toEqual(['OPID1', 'OPID2'])
    expect(new Set(items.map(i => i.docId)).size).toBe(2) // no collision → no dropped op
  })

  it('a Type=4 statement with no DocID yields distinct dedup ids per operation', () => {
    const parsed = parseClientBankText(
      '***** ^Type=4^ ^Acc=BY79ALFA30130000000000000000^  -  T\n[OUT_PARAM]\n'
      + '^DocDate=29.03.2018^\n^Num=134^\n^Db=390.22^\n^Credit=0.00^\n^KorName=A^\n'
      + '^DocDate=29.03.2018^\n^Num=136^\n^Db=0.00^\n^Credit=1288.00^\n^KorName=B^'
    )
    const items = normalizeClientBank(parsed, { account: '' })
    expect(items.map(i => i.docId)).toEqual(['134|29.03.2018', '136|29.03.2018'])
    expect(items[0]!.direction).toBe('debit')
    expect(items[1]!.direction).toBe('credit') // Credit>0 → приход
  })
})

// Real-format fixtures (anonymized) from live aida exports — the CURRENT bank
// formats: Type=3 "за день" (VpskExport), Type=4 "за период" (#73) and the foreign
// Type=5 valuta "за день" (#169).
describe('real client-bank formats (Type 3 / Type 4 / Type 5 fixtures)', () => {
  it('Type=4 "за период": OperationID dedup, counterparty account/УНП/BIC, balance reconciles', () => {
    const items = normalizeClientBank(parseClientBankText(loadFixture('demo-type4-alfa.txt')), { account: '' })
    expect(items).toHaveLength(3)
    // Unique dedup ids from OperationID even though two rows share Num=362.
    expect(items.map(i => i.docId)).toEqual(['OPID000000000001', 'OPID000000000002', 'OPID000000000003'])
    // Our own account is parsed from the file header (ends 0270000).
    expect(items[0]!.account).toBe('BY34ALFA30122H10700010270000')
    // Counterparty fields come from the right keys.
    expect(items[0]!.counterparty.account).toBe('BY70ALFA30132788650010270000')
    expect(items[0]!.counterparty.unp).toBe('200000001')
    expect(items[0]!.counterparty.bic).toBe('ALFABY2X') // BIC from `Code` in Type=4
    // Amounts + direction (all debits here); total matches RestIn − RestOut.
    expect(items.every(i => i.direction === 'debit')).toBe(true)
    expect(items.every(i => i.currency === 'BYN')).toBe(true)
    const total = items.reduce((s, i) => s + i.amount, 0)
    expect(total).toBeCloseTo(1000.0 - 702.77, 2) // 297.23
  })

  it('Type=600: a numeric `Code` (currency code 156, not a BIC) never leaks as counterparty.bic (#75)', () => {
    const items = normalizeClientBank(parseClientBankText(loadFixture('demo-prior-cny.txt')), { account: 'BY00X0156', currency: 'CNY' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(i => i.counterparty.bic === undefined)).toBe(true)
  })

  it('Type=3 "за день": Num|DocDate dedup, приход/расход split, balance reconciles', () => {
    const items = normalizeClientBank(parseClientBankText(loadFixture('demo-type3-vpsk.txt')), { account: '' })
    expect(items).toHaveLength(2)
    // No OperationID/DocID in Type=3 → Num|DocDate identity (unique within a day).
    expect(items.map(i => i.docId)).toEqual(['101|08.01.2026', '102|08.01.2026'])
    expect(items[0]!.direction).toBe('debit') // Db>0
    expect(items[0]!.amount).toBeCloseTo(300, 2)
    expect(items[0]!.counterparty.account).toBe('BY24TESTAB00000000000000001234')
    expect(items[0]!.counterparty.unp).toBe('192220456')
    expect(items[1]!.direction).toBe('credit') // Credit>0 → приход
    expect(items[1]!.amount).toBeCloseTo(500, 2)
    expect(items.every(i => i.currency === 'BYN')).toBe(true)
    // CrIn 1000 − ΣDb 300 + ΣCredit 500 = CrOut 1200.
    const net = items.reduce((s, i) => s + (i.direction === 'credit' ? i.amount : -i.amount), 0)
    expect(1000 + net).toBeCloseTo(1200, 2)
  })

  it('Type=5 valuta "за день": numeric CurrCode → foreign currency, amount from the …Q field not the BYN equivalent (#169)', () => {
    const items = normalizeClientBank(parseClientBankText(loadFixture('demo-type5-vpsk.txt')), { account: '' })
    expect(items).toHaveLength(1)
    const op = items[0]!
    // Currency from numeric CurrCode=643, NOT the BY-account BYN default.
    expect(op.currency).toBe('RUB')
    expect(op.direction).toBe('credit') // Cre>0 → приход
    // Account-currency amount from CreQ (170595.00), NOT the 6384.35 BYN equivalent (Cre).
    expect(op.amount).toBeCloseTo(170595.00, 2)
    expect(op.account).toBe('BY86DEMO30120000000000000643')
    expect(op.counterparty.account).toBe('40702810000000000000')
    expect(op.docId).toBe('180|06.02.2026') // no DocID/OperationID → Num|DocDate
  })
})

describe('currencyFromNumericCode (ISO 4217 numeric → alpha, #73 building block)', () => {
  it('maps known numeric codes', () => {
    expect(currencyFromNumericCode('933')).toBe('BYN')
    expect(currencyFromNumericCode('840')).toBe('USD')
    expect(currencyFromNumericCode('978')).toBe('EUR')
    expect(currencyFromNumericCode('643')).toBe('RUB')
    expect(currencyFromNumericCode('156')).toBe('CNY')
    expect(currencyFromNumericCode(' 933 ')).toBe('BYN') // trims
  })
  it('returns undefined for unknown/empty/undefined input', () => {
    expect(currencyFromNumericCode('000')).toBeUndefined()
    expect(currencyFromNumericCode('')).toBeUndefined()
    expect(currencyFromNumericCode(undefined)).toBeUndefined()
  })
})

describe('counterparty BIC (Cod / Code, shape-guarded, #75)', () => {
  const base = { KorName: 'X', Db: '1.00', Credit: '0.00', DocDate: '01.01.2026', Num: '1' }
  const bicOf = (row: Record<string, string>) => normalizeClientBankRow(row, 'BY00X', 'BYN').counterparty.bic

  it('takes Cod (classic) and Code (Type=4) when BIC-shaped', () => {
    expect(bicOf({ ...base, Cod: 'PJCBBY2X' })).toBe('PJCBBY2X')
    expect(bicOf({ ...base, Code: 'ALFABY2X' })).toBe('ALFABY2X')
    expect(bicOf({ ...base, Cod: 'MMBNBY22' })).toBe('MMBNBY22') // 8-char
    expect(bicOf({ ...base, Cod: 'ALFABY2XXXX' })).toBe('ALFABY2XXXX') // 11-char branch
  })
  it('prefers Cod over Code when both are present', () => {
    expect(bicOf({ ...base, Cod: 'PJCBBY2X', Code: 'ALFABY2X' })).toBe('PJCBBY2X')
  })
  it('rejects a non-BIC Code (numeric currency code) and omits bic when absent', () => {
    expect(bicOf({ ...base, Code: '156' })).toBeUndefined()
    expect(bicOf(base)).toBeUndefined()
  })
})
