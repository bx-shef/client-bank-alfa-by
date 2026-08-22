import { describe, expect, it, vi } from 'vitest'
import { buildRegistryFields, DIRECTION_LABELS, writePaymentRegistryViaRest } from '../server/utils/paymentRegistryWrite'
import { buildPaymentElementAddCall } from '../app/utils/distributionLedger'
import { PAYMENT_SP_FIELDS, buildUfFieldNameCamel } from '../app/config/distributionSp'
import { dedupKey } from '../app/utils/statement'
import type { StatementItem } from '../app/types/statement'
import type { SpRef } from '../app/config/distributionSp'
import type { RestCall } from '../server/utils/companyLookup'

/** Записанные вызовы транспорта. ⚠ Мок типизируется как настоящий `RestCall` (два параметра) —
 *  однопараметрический `vi.fn(async (method) => …)` компилятору выглядит корректным, но тогда
 *  `params` в тестах не существует ВОВСЕ, то есть контракт транспорта не проверяется ничем
 *  (тот же класс промаха, что описан в CLAUDE.md про моки `QueryFn`). */
const recorded = (call: RestCall): [string, Record<string, unknown>][] =>
  (call as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls

// Реестр платежей (#575). СП называется «Импорт выписки: платежи», и владелец ждёт от него реестр —
// каждую операцию выписки. До этой правки элемент писался ТОЛЬКО когда разнесение удалось, поэтому
// на портале, где плательщиков нет в CRM (замерено: 366 счетов, ноль совпадений), СП оставался пуст
// при работающем импорте, и ничего об этом не говорило.

const SP: SpRef = { entityTypeId: 1038, id: 7 }

const op = (over: Partial<StatementItem> = {}): StatementItem => ({
  account: 'BY26PJCB30120699071000000933',
  docId: '752038522',
  direction: 'credit',
  amount: 1840.55,
  currency: 'BYN',
  purpose: 'Оплата по счёту СЧ-1234',
  counterparty: { name: 'ООО «Ромашка»', unp: '191234567', account: 'BY11ALFA30120A11111111111111' },
  acceptDate: '2026-08-21T14:00:00.000',
  ...over
})

describe('#575 buildRegistryFields', () => {
  it('переносит всё, что сказала выписка, включая банк человеческим именем', () => {
    const f = buildRegistryFields(op(), 'prior-by')
    expect(f).toEqual({
      operationDate: '2026-08-21T14:00:00.000',
      direction: 'Приход',
      counterparty: 'ООО «Ромашка»',
      counterpartyAccount: 'BY11ALFA30120A11111111111111',
      counterpartyUnp: '191234567',
      purpose: 'Оплата по счёту СЧ-1234',
      ownAccount: 'BY26PJCB30120699071000000933',
      bank: 'Приорбанк'
    })
  })

  it('направление — словом, а не внутренним токеном', () => {
    // ⚠ Колонку читает бухгалтер в списке CRM; `credit`/`debit` там не данные, а наш жаргон.
    expect(buildRegistryFields(op({ direction: 'debit' }), 'alfa-by').direction).toBe('Расход')
    expect(DIRECTION_LABELS).toEqual({ credit: 'Приход', debit: 'Расход' })
  })

  it('неизвестный провайдер отдаёт свой id, а не пустую клетку', () => {
    // «Имени для этого банка у нас нет» — тоже факт; пустая клетка читается как «банк неизвестен».
    const f = buildRegistryFields(op(), 'manual')
    expect(f.bank).toBeTruthy()
  })
})

describe('#575 колонки реестра в crm.item.add', () => {
  // ⚠ Имя поля строит сам продовый билдер: постфиксы камелизируются (`NEED_DISTR` → `NeedDistr`),
  // и повторять это правило в тесте значило бы завести вторую копию, которая однажды разойдётся.
  const uf = (postfix: string) => buildUfFieldNameCamel(SP.id, postfix)

  it('кладёт колонки реестра рядом с денежными полями', () => {
    const call = buildPaymentElementAddCall(SP, {
      opportunity: 1840.55, currency: 'BYN', marker: 'M',
      registry: buildRegistryFields(op(), 'prior-by')
    })
    const f = call.params.fields as Record<string, unknown>
    expect(f[uf(PAYMENT_SP_FIELDS.counterparty.postfix)]).toBe('ООО «Ромашка»')
    expect(f[uf(PAYMENT_SP_FIELDS.counterpartyAccount.postfix)]).toBe('BY11ALFA30120A11111111111111')
    expect(f[uf(PAYMENT_SP_FIELDS.purpose.postfix)]).toBe('Оплата по счёту СЧ-1234')
    expect(f[uf(PAYMENT_SP_FIELDS.bank.postfix)]).toBe('Приорбанк')
    // Денежные поля на месте — реестр их не вытеснил.
    expect(f[uf(PAYMENT_SP_FIELDS.total.postfix)]).toBe(1840.55)
    expect(f[uf(PAYMENT_SP_FIELDS.marker.postfix)]).toBe('M')
  })

  it('пустое значение НЕ пишется пустой строкой', () => {
    // ⚠ Пустая клетка в списке CRM честно читается как «банк ничего не прислал»; запись '' делает
    // элемент шумнее, не добавляя факта.
    const call = buildPaymentElementAddCall(SP, {
      opportunity: 1, currency: 'BYN', marker: 'M',
      registry: buildRegistryFields(op({ counterparty: { name: '', unp: '', account: '' }, purpose: '  ' }), 'alfa-by')
    })
    const f = call.params.fields as Record<string, unknown>
    for (const p of [PAYMENT_SP_FIELDS.counterparty, PAYMENT_SP_FIELDS.counterpartyUnp, PAYMENT_SP_FIELDS.purpose]) {
      expect(Object.hasOwn(f, uf(p.postfix)), `${p.postfix} записан пустым`).toBe(false)
    }
  })

  it('без блока реестра форма вызова прежняя — старые вызывающие не сломаны', () => {
    const call = buildPaymentElementAddCall(SP, { opportunity: 5, currency: 'BYN', marker: 'M' })
    const f = call.params.fields as Record<string, unknown>
    expect(Object.keys(f).sort()).toEqual([
      uf(PAYMENT_SP_FIELDS.currency.postfix),
      uf(PAYMENT_SP_FIELDS.marker.postfix),
      uf(PAYMENT_SP_FIELDS.needDistributionsSum.postfix),
      uf(PAYMENT_SP_FIELDS.total.postfix)
    ].sort())
  })
})

describe('#575 writePaymentRegistryViaRest', () => {
  it('идемпотентен по ключу операции — повтор не создаёт второй элемент', async () => {
    const existing = { result: { items: [{ id: '42' }] } }
    const call: RestCall = vi.fn(async (method: string, _params: Record<string, unknown>) => (method === 'crm.item.list' ? existing : { result: { item: { id: '99' } } }))
    const id = await writePaymentRegistryViaRest(op(), '5', 'prior-by', SP, call)
    expect(id).toBe('42')
    expect(recorded(call).some(c => c[0] === 'crm.item.add')).toBe(false)
  })

  it('ищет по ТОМУ ЖЕ ключу, что и маркер дела', async () => {
    const call: RestCall = vi.fn(async (method: string, _params: Record<string, unknown>) => (method === 'crm.item.list'
      ? { result: { items: [] } }
      : { result: { item: { id: '77' } } }))
    await writePaymentRegistryViaRest(op(), null, 'prior-by', SP, call)
    const listParams = recorded(call).find(c => c[0] === 'crm.item.list')![1] as { filter: Record<string, unknown> }
    expect(Object.values(listParams.filter)).toContain(dedupKey(op()))
  })

  it('связывает плательщика, когда он опознан, и не связывает никого, когда нет', async () => {
    // ⚠ Сюда передаётся КЛИЕНТ или null — не фолбэк «моя компания»: иначе чужой платёж был бы
    // подписан нашей собственной компанией.
    for (const [companyId, expected] of [['5', 5], [null, undefined]] as const) {
      const call: RestCall = vi.fn(async (method: string, _params: Record<string, unknown>) => (method === 'crm.item.list'
        ? { result: { items: [] } }
        : { result: { item: { id: '1' } } }))
      await writePaymentRegistryViaRest(op(), companyId, 'alfa-by', SP, call)
      const addParams = recorded(call).find(c => c[0] === 'crm.item.add')![1] as { fields: Record<string, unknown> }
      expect(addParams.fields.companyId).toBe(expected)
    }
  })
})
