import type { Statement } from '~/types/statement'

// Demo statement used by the in-portal view until the live Alfa integration is
// wired (backend, after credentials arrive). Mirrors the real normalized shape
// so the UI built against it won't change when real data replaces the mock.
export const MOCK_STATEMENT: Statement = {
  providerId: 'alfa-by',
  account: 'BY80ALFA30121122220090270000',
  items: [
    {
      account: 'BY80ALFA30121122220090270000',
      docId: '100231',
      docNum: '541',
      direction: 'credit',
      amount: 1840.00,
      currency: 'BYN',
      purpose: 'Оплата по счёту №541 от 12.06.2026 за консультационные услуги',
      counterparty: {
        name: 'ООО «Ромашка»',
        unp: '191234567',
        account: 'BY24ALFA30120000000000000001',
        bank: 'ОАО «Альфа-Банк»',
        bic: 'ALFABY2X'
      },
      acceptDate: '2026-06-26T00:00:00.000Z',
      operCodeName: 'Зачисление'
    },
    {
      account: 'BY80ALFA30121122220090270000',
      docId: '100232',
      docNum: '542',
      direction: 'credit',
      amount: 320.50,
      currency: 'BYN',
      purpose: 'Возврат депозита по договору аренды',
      counterparty: {
        name: 'ИП Петров П. П.',
        unp: '291112223',
        account: 'BY24PJCB30120000000000000002',
        bank: 'ОАО «Приорбанк»',
        bic: 'PJCBBY2X'
      },
      acceptDate: '2026-06-27T00:00:00.000Z',
      operCodeName: 'Зачисление'
    },
    {
      account: 'BY80ALFA30121122220090270000',
      docId: '100233',
      docNum: '88',
      direction: 'debit',
      amount: 540.00,
      currency: 'BYN',
      purpose: 'Оплата аренды офиса за июнь 2026',
      counterparty: {
        name: 'ООО «Бизнес-Центр»',
        unp: '190009988',
        account: 'BY24ALFA30120000000000000003',
        bank: 'ОАО «Альфа-Банк»',
        bic: 'ALFABY2X'
      },
      acceptDate: '2026-06-27T00:00:00.000Z',
      operCodeName: 'Списание'
    }
  ]
}
