import { describe, expect, it } from 'vitest'
import type { StatementItem, StatementNormalizer } from '~/types/statement'
import { normalizeAlfa } from '~/utils/alfaStatement'
import { normalizePrior } from '~/utils/priorStatement'
import { normalizeClientBank } from '~/utils/clientBankStatement'
import { normalizeOneC } from '~/utils/oneCStatement'

// The unified statement interface (see app/types/statement.ts): every bank is
// fetched differently but its normalizer produces the SAME StatementItem[] — the
// exact fields the app needs. This test pins that identity across providers.

// The app-facing fields every normalized operation must expose.
function assertAppFields(item: StatementItem) {
  expect(typeof item.direction).toBe('string') // приход/расход
  expect(['credit', 'debit']).toContain(item.direction)
  expect(typeof item.amount).toBe('number') // сумма
  expect(typeof item.currency).toBe('string') // валюта
  expect(typeof item.purpose).toBe('string') // обоснование оплаты
  expect(typeof item.acceptDate).toBe('string') // дата операции
  expect(typeof item.docId).toBe('string') // идемпотентность (дедуп)
  expect(typeof item.account).toBe('string') // наш счёт
  // счёт + имя + УНП контрагента (для сопоставления компании в CRM)
  expect(typeof item.counterparty.account).toBe('string')
  expect(typeof item.counterparty.name).toBe('string')
  expect(typeof item.counterparty.unp).toBe('string')
}

// Compile-time conformance is proven where the normalizers are declared:
// `export const normalizeAlfa: StatementNormalizer<…>` / `normalizePrior: …`.
// Here we collect them into one heterogeneous list (hence the `as` to the
// unknown-raw form) to assert their RUNTIME output is identical across banks.
const providers: Array<{ id: string, normalize: StatementNormalizer, raw: unknown }> = [
  {
    id: 'alfa-by',
    normalize: normalizeAlfa as StatementNormalizer,
    raw: {
      page: [{
        number: 'BY10ALFA30120000000000000933',
        operType: 'C',
        amount: 1840.5,
        currIso: 'BYN',
        purpose: 'Оплата по счёту №1',
        docId: 'A1',
        acceptDate: '2024-05-01T00:00:00.000',
        corrName: 'ООО Ромашка',
        corrUnp: '191167894',
        corrNumber: 'BY20PJCB30120000000000000933'
      }]
    }
  },
  {
    id: 'prior-by',
    normalize: normalizePrior as StatementNormalizer,
    raw: {
      data: {
        accountId: 'C-78901',
        transaction: [{
          transactionId: 'P1',
          creditDebitIndicator: 'Credit',
          amount: 600000,
          transactionDetails: 'Оплата товаров и услуг',
          bookingDateTime: '2024-05-02T00:00:00+03:00',
          debtor: { name: 'Счет 3012000041012', organisationIdentification: [{ identification: 'INN191167894' }] },
          debtorAccount: { identification: '3012000041012' },
          debtorAgent: { identification: 'PJCBBY2X', name: '«Приорбанк» ОАО' }
        }]
      }
    }
  },
  {
    id: 'manual',
    normalize: normalizeClientBank as StatementNormalizer,
    raw: {
      GENERAL: { TYPE: '400', ACC: 'BY10ALFA30120000000000000933', TITLE: 'T' },
      IN_PARAM: { header: {}, items: [], footer: {}, unrouted: {} },
      OUT_PARAM: {
        header: {}, footer: {}, unrouted: {},
        items: [{
          DocDate: '28.09.2023', Num: '1', Opr: '6', Acc: 'BY20PJCB30120000000000000933',
          Db: '1840.50', UNNRec: '191167894', KorUNP: '191167894', KorName: 'ООО Ромашка',
          Nazn: 'Оплата по счёту №1', DocID: 'M1', OpDate: '28.09.2023 10:00:00'
        }]
      }
    }
  },
  {
    id: 'manual-1c',
    normalize: normalizeOneC as StatementNormalizer,
    raw: {
      header: { РасчСчет: '40702810900000000001' },
      accounts: [],
      documents: [{
        Вид: 'Платежное поручение', Номер: '4', Дата: '25.01.2018', Сумма: '1840.50',
        ПлательщикСчет: '40702810900000000001', ДатаСписано: '25.01.2018',
        ПолучательСчет: '40702810900000000999', ПолучательИНН: '7712345678',
        Получатель1: 'ООО Ромашка', НазначениеПлатежа: 'Оплата по счёту №1'
      }]
    }
  }
]

describe('unified statement interface — every provider yields the same shape', () => {
  for (const p of providers) {
    it(`${p.id}: normalizer → StatementItem[] with all app fields`, () => {
      const items = p.normalize(p.raw, { account: 'BY-our-account', currency: 'BYN' })
      expect(items.length).toBe(1)
      assertAppFields(items[0]!)
    })
  }

  it('the same set of keys is produced regardless of the bank', () => {
    const keysOf = (p: typeof providers[number]) =>
      Object.keys(p.normalize(p.raw, { account: 'A', currency: 'BYN' })[0]!).sort()
    // Optional keys may differ per row, but the required core must match.
    const core = ['account', 'amount', 'counterparty', 'currency', 'direction', 'docId', 'purpose', 'acceptDate'].sort()
    for (const p of providers) {
      expect(keysOf(p)).toEqual(expect.arrayContaining(core))
    }
  })
})
