import { describe, expect, it } from 'vitest'
import {
  normalizePriorTransaction,
  normalizePriorTransactionList
} from '~/utils/priorStatement'
import type { PriorTransaction } from '~/utils/priorStatement'

// A real Priorbank sandbox transaction (incoming credit) — anonymized test data
// as returned by GET /accounts/{id}/transactions/{listId}. See docs/PRIOR_API.md.
const creditTx: PriorTransaction = {
  transactionId: '4895639',
  creditDebitIndicator: 'Credit',
  status: 'Z00',
  bookingDateTime: '2022-01-26T00:00:00+03:00',
  transactionDetails: 'Оплата товаров и услуг',
  amount: 600000.00,
  debtor: {
    name: 'Счет 3012000041012',
    organisationIdentification: [{ code: 'TXID', identification: 'INN191167894' }]
  },
  debtorAccount: { schemeName: 'BY.NBRB.OTHER', identification: '3012000041012' },
  debtorAgent: { identification: 'PJCBBY2X', name: '«Приорбанк» ОАО' }
}

describe('normalizePriorTransaction — credit (приход)', () => {
  const item = normalizePriorTransaction(creditTx, { account: 'BY55PJCB301200000000700009 33', currency: 'BYN' })

  it('classifies Credit as a приход (credit) and maps the money/purpose', () => {
    expect(item.direction).toBe('credit')
    expect(item.amount).toBe(600000)
    expect(item.currency).toBe('BYN') // filled from the account context (tx omits it)
    expect(item.purpose).toBe('Оплата товаров и услуг')
    expect(item.docId).toBe('4895639')
    expect(item.acceptDate).toBe('2022-01-26T00:00:00+03:00')
  })

  it('takes the counterparty from the debtor (payer) on a credit', () => {
    expect(item.counterparty).toEqual({
      name: 'Счет 3012000041012',
      unp: '191167894', // digits pulled out of "INN191167894"
      account: '3012000041012',
      bank: '«Приорбанк» ОАО',
      bic: 'PJCBBY2X'
    })
  })
})

describe('normalizePriorTransaction — debit (расход)', () => {
  // Priorbank sandbox only returned credits; a debit puts the counterparty in creditor.
  const debitTx: PriorTransaction = {
    transactionId: '9001',
    number: 'PP-42',
    creditDebitIndicator: 'Debit',
    bookingDateTime: '2024-05-05T00:00:00+03:00',
    valueDate: '2024-05-06',
    transactionDetails: 'Оплата поставщику',
    amount: 1250.5,
    currency: 'USD',
    creditor: { name: 'ООО Ромашка', organisationIdentification: [{ identification: '123456789' }] },
    creditorAccount: { schemeName: 'BY.NBRB.IBAN', identification: 'BY13ALFA30120000000000000933' },
    creditorAgent: { identification: 'ALFABY2X', name: 'Альфа-Банк' }
  }

  it('classifies Debit as a расход and takes the counterparty from the creditor', () => {
    const item = normalizePriorTransaction(debitTx, { account: 'BY00X', currency: 'BYN' })
    expect(item.direction).toBe('debit')
    expect(item.docNum).toBe('PP-42')
    expect(item.currency).toBe('USD') // tx currency wins over the account currency
    expect(item.operDate).toBe('2024-05-06')
    expect(item.counterparty).toEqual({
      name: 'ООО Ромашка',
      unp: '123456789',
      account: 'BY13ALFA30120000000000000933',
      bank: 'Альфа-Банк',
      bic: 'ALFABY2X'
    })
  })
})

describe('normalizePriorTransaction — edge cases', () => {
  it('defaults direction to credit when the indicator is absent', () => {
    expect(normalizePriorTransaction({ amount: 1 }, { account: 'A' }).direction).toBe('credit')
  })
  it('omits docNum/operDate/bank/bic when absent', () => {
    const item = normalizePriorTransaction(
      { transactionId: 't', creditDebitIndicator: 'Credit', amount: 5, debtor: { name: 'X' } },
      { account: 'A' }
    )
    expect(item).not.toHaveProperty('docNum')
    expect(item).not.toHaveProperty('operDate')
    expect(item.counterparty).toEqual({ name: 'X', unp: '', account: '' })
  })
  it('keeps a non-numeric identification verbatim when no digits', () => {
    const item = normalizePriorTransaction(
      { creditDebitIndicator: 'Credit', debtor: { name: 'X', organisationIdentification: [{ identification: 'N/A' }] } },
      { account: 'A' }
    )
    expect(item.counterparty.unp).toBe('N/A')
    expect(item.amount).toBe(0)
  })
  it('reads the УНП from privateIdentification (physical-person counterparty)', () => {
    const item = normalizePriorTransaction(
      { creditDebitIndicator: 'Credit', debtor: { name: 'ИП Иванов', privateIdentification: [{ identification: 'ID3012345678' }] } },
      { account: 'A' }
    )
    expect(item.counterparty.unp).toBe('3012345678')
  })
  it('yields an empty УНП when there is no identification at all', () => {
    const item = normalizePriorTransaction(
      { creditDebitIndicator: 'Credit', debtor: { name: 'X' } },
      { account: 'A' }
    )
    expect(item.counterparty.unp).toBe('')
  })
  it('coerces a string amount and guards against NaN', () => {
    // Open Banking JSON may send the amount as a string.
    expect(normalizePriorTransaction({ amount: '1234.56' }, { account: 'A' }).amount).toBe(1234.56)
    expect(normalizePriorTransaction({ amount: 'oops' }, { account: 'A' }).amount).toBe(0)
  })
  it('empty transactionId collapses to an empty docId (dedup caveat)', () => {
    // Documented limitation: no transactionId → docId '' → weak dedup key.
    expect(normalizePriorTransaction({ creditDebitIndicator: 'Credit' }, { account: 'A' }).docId).toBe('')
  })
})

describe('normalizePriorTransactionList', () => {
  it('normalizes every transaction and falls back to the response accountId', () => {
    const res = { data: { accountId: 'C-78901', transaction: [creditTx, { ...creditTx, transactionId: '2' }] } }
    const items = normalizePriorTransactionList(res, { account: '', currency: 'BYN' })
    expect(items).toHaveLength(2)
    expect(items[0]!.account).toBe('C-78901')
    expect(items[1]!.docId).toBe('2')
  })
  it('returns [] for an empty/absent transaction array', () => {
    expect(normalizePriorTransactionList({ data: { transaction: [] } }, { account: 'A' })).toEqual([])
    expect(normalizePriorTransactionList({}, { account: 'A' })).toEqual([])
  })
})
