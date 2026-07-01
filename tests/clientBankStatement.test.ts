import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseClientBankText } from '~/utils/clientBankText'
import {
  clientBankDateToIso,
  detectStatementCurrency,
  normalizeClientBank,
  normalizeClientBankRow,
  normalizeClientBankStatement
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
