import { describe, expect, it, vi } from 'vitest'
import {
  buildRegistryFields, DIRECTION_LABELS, writePaymentRegistryViaRest, backfillPaymentRegistryViaRest
} from '../server/utils/paymentRegistryWrite'
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
      // ⚠ Только календарная часть: поле типа `date`, а портал переводит момент в свой часовой
      // пояс прежде, чем взять дату (замерено), поэтому сырой момент дал бы сдвиг на сутки.
      operationDate: '2026-08-21',
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

  it('провайдер ручной загрузки тоже получает человеческое имя, а не пустую клетку', () => {
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
    // ⚠ Проверяются ВСЕ ВОСЕМЬ. Прежняя версия смотрела на четыре — и мутация «убрать строку из
    // карты постфиксов» для остальных четырёх проходила зелёной: поле просто не доезжало до
    // `crm.item.add`, а сказать об этом было некому.
    expect(f[uf(PAYMENT_SP_FIELDS.operationDate.postfix)]).toBe('2026-08-21')
    expect(f[uf(PAYMENT_SP_FIELDS.direction.postfix)]).toBe('Приход')
    expect(f[uf(PAYMENT_SP_FIELDS.counterparty.postfix)]).toBe('ООО «Ромашка»')
    expect(f[uf(PAYMENT_SP_FIELDS.counterpartyAccount.postfix)]).toBe('BY11ALFA30120A11111111111111')
    expect(f[uf(PAYMENT_SP_FIELDS.counterpartyUnp.postfix)]).toBe('191234567')
    expect(f[uf(PAYMENT_SP_FIELDS.purpose.postfix)]).toBe('Оплата по счёту СЧ-1234')
    expect(f[uf(PAYMENT_SP_FIELDS.ownAccount.postfix)]).toBe(op().account)
    expect(f[uf(PAYMENT_SP_FIELDS.bank.postfix)]).toBe('Приорбанк')
    // Денежные поля на месте — реестр их не вытеснил.
    expect(f[uf(PAYMENT_SP_FIELDS.total.postfix)]).toBe(1840.55)
    expect(f[uf(PAYMENT_SP_FIELDS.marker.postfix)]).toBe('M')
  })

  it('значение обрезается по краям, а не пишется с пробелами', () => {
    // ⚠ Мутация «оставить проверку на пустоту, но писать нетримленное значение» прежде проходила
    // зелёной. Пробелы по краям в колонке CRM — это несовпадение при фильтре и поиске, то есть
    // ровно та беда, от которой реестр и должен спасать.
    const call = buildPaymentElementAddCall(SP, {
      opportunity: 1, currency: 'BYN', marker: 'M',
      registry: buildRegistryFields(op({ purpose: '  Оплата по счёту СЧ-1234  ' }), 'alfa-by')
    })
    const f = call.params.fields as Record<string, unknown>
    expect(f[uf(PAYMENT_SP_FIELDS.purpose.postfix)]).toBe('Оплата по счёту СЧ-1234')
  })

  it('постфиксы полей закреплены ЛИТЕРАЛАМИ — переименование осиротит поле на живом портале', () => {
    // ⚠ Единственное место, где строки проверяются НЕЗАВИСИМО от объявления. Всё остальное (и
    // провижининг, и карта записи, и тесты выше) читает `PAYMENT_SP_FIELDS`, поэтому переименование
    // постфикса сходится само с собой и проходит зелёным. А на портале это означает: старое поле
    // `UF_CRM_<id>_PURPOSE` остаётся висеть со всеми значениями, рядом создаётся пустое новое, и
    // никакой миграции у нас нет. Меняешь строку здесь — значит, осознанно.
    expect(PAYMENT_SP_FIELDS.operationDate.postfix).toBe('OP_DATE')
    expect(PAYMENT_SP_FIELDS.direction.postfix).toBe('DIRECTION')
    expect(PAYMENT_SP_FIELDS.counterparty.postfix).toBe('COUNTERPARTY')
    expect(PAYMENT_SP_FIELDS.counterpartyAccount.postfix).toBe('CP_ACCOUNT')
    expect(PAYMENT_SP_FIELDS.counterpartyUnp.postfix).toBe('CP_UNP')
    expect(PAYMENT_SP_FIELDS.purpose.postfix).toBe('PURPOSE')
    expect(PAYMENT_SP_FIELDS.ownAccount.postfix).toBe('OWN_ACCOUNT')
    expect(PAYMENT_SP_FIELDS.bank.postfix).toBe('BANK')
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

  it('без блока реестра форма вызова прежняя — плюс внешний код', () => {
    // ⚠ `xmlId` пишется ВСЕГДА, когда есть маркер: это естественный внешний код записи (счёт|id
    // операции в банке). Портал оставлял его пустым, и связь элемента с выпиской снаружи не
    // читалась вовсе — только через наше поле (замечание владельца по живой карточке).
    const call = buildPaymentElementAddCall(SP, { opportunity: 5, currency: 'BYN', marker: 'M' })
    const f = call.params.fields as Record<string, unknown>
    expect(Object.keys(f).sort()).toEqual([
      'xmlId',
      uf(PAYMENT_SP_FIELDS.currency.postfix),
      uf(PAYMENT_SP_FIELDS.marker.postfix),
      uf(PAYMENT_SP_FIELDS.needDistributionsSum.postfix),
      uf(PAYMENT_SP_FIELDS.total.postfix)
    ].sort())
    expect(f.xmlId).toBe('M')
  })

  it('человеческий заголовок вместо «Импорт выписки: платежи #45»', () => {
    // ⚠ Заголовок стоит в списке реестра, в поиске и в каждой ссылке на элемент — то есть ровно
    // там, где человек ищет платёж глазами. Портальное умолчание не говорит о платеже ничего.
    const call = buildPaymentElementAddCall(SP, {
      opportunity: 5, currency: 'BYN', marker: 'M', title: 'Приход 450,00 BYN от ИП Иванов'
    })
    expect((call.params.fields as Record<string, unknown>).title).toBe('Приход 450,00 BYN от ИП Иванов')
  })

  it('пустой заголовок не отправляется — портал подставит своё, а не пустоту', () => {
    const call = buildPaymentElementAddCall(SP, { opportunity: 5, currency: 'BYN', marker: 'M', title: '   ' })
    expect('title' in (call.params.fields as Record<string, unknown>)).toBe(false)
  })
})

describe('#575 нейтрализация полей, которые пишет плательщик', () => {
  it('BB-разметка из назначения и имени контрагента не доезжает до карточки живой', () => {
    // ⚠ Назначение платежа и имя контрагента набирает ПЛАТЕЛЬЩИК. В проекте их нейтрализует каждый
    // писатель — описание дела, сообщение в чат, оповещения об ошибках; реестр не имеет права быть
    // исключением, тем более что в список смарт-процесса смотрят чаще, чем в описание дела.
    const f = buildRegistryFields(op({
      purpose: 'Оплата [URL=https://evil.test]тут[/URL] по счёту',
      counterparty: { name: 'ООО [B]Ромашка[/B]', unp: '191234567', account: 'BY26PJCB30120000000000000933' }
    }), 'alfa-by')
    expect(f.purpose).not.toContain('[')
    expect(f.purpose).not.toContain(']')
    expect(f.counterparty).not.toContain('[')
    // ⚠ Текст при этом ЧИТАЕМ — нейтрализация меняет скобки на полноширинные, а не вырезает слова:
    // реестр обязан оставаться пригодным для поиска по назначению.
    expect(f.purpose).toContain('Оплата')
    expect(f.purpose).toContain('по счёту')
    expect(f.counterparty).toContain('Ромашка')
  })

  it('на настоящих данных нейтрализация — тождественная замена', () => {
    // Счёт и УНП скобок не содержат никогда, поэтому защита не портит то, что бухгалтер копирует.
    const f = buildRegistryFields(op(), 'alfa-by')
    expect(f.counterpartyAccount).toBe(op().counterparty.account)
    expect(f.counterpartyUnp).toBe(op().counterparty.unp)
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

describe('#578 колонки дописываются элементу, который УЖЕ существует', () => {
  // ⚠ Ядро долговременной дозаписи (#578) и слепое пятно прежних тестов: `ensurePaymentElement` —
  // find-or-create БЕЗ ветки update, поэтому найдя маркер, он молча возвращает id. К моменту
  // повтора элемент мог быть создан ГОЛЫМ (разнесением или упавшим прогоном), и без этого вызова
  // задача «успешно» не делала бы ничего, а колонки не появились бы уже никогда. Мутационный
  // прогон подтвердил: удаление этой ветки не роняло НИ ОДНОГО теста.
  const sp: SpRef = { entityTypeId: 1044, id: 44 }

  function recorder(existingId: string | null) {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'crm.item.list') {
        return { result: { items: existingId ? [{ id: existingId }] : [] } }
      }
      return { result: { item: { id: existingId ?? '99' } } }
    }
    return { call, calls }
  }

  it('элемент найден → уходит `crm.item.update` С КОЛОНКАМИ, второго `add` нет', async () => {
    const { call, calls } = recorder('77')
    const id = await writePaymentRegistryViaRest(op(), 'CO', 'alfa-by', sp, call)
    expect(id).toBe('77')
    expect(calls.map(c => c.method)).toEqual(['crm.item.list', 'crm.item.update'])
    const update = calls[1]!.params as { entityTypeId: number, id: number, fields: Record<string, unknown> }
    expect(update.entityTypeId).toBe(sp.entityTypeId)
    expect(update.id).toBe(77)
    // Колонки те же, что и при создании — маппинг общий, второй копии нет.
    expect(Object.values(update.fields)).toContain('Приход')
  })

  it('элемент создан нами → лишнего `update` НЕТ', async () => {
    // Счастливый путь не должен платить вторым вызовом на каждую операцию.
    const { call, calls } = recorder(null)
    await writePaymentRegistryViaRest(op(), null, 'alfa-by', sp, call)
    expect(calls.map(c => c.method)).toEqual(['crm.item.list', 'crm.item.add'])
  })
})

// ⚠ #45: дозаливка реестра у операции, которую дедуп УЖЕ отсеял. Транспорт не был покрыт ничем —
// проводка проверялась фейком, всегда возвращавшим 'filled', то есть ровно те ветки, где живут оба
// найденных ревью риска, не проверялись выполнением.
describe('#45 backfillPaymentRegistryViaRest', () => {
  const dirField = buildUfFieldNameCamel(SP.id, PAYMENT_SP_FIELDS.direction.postfix)

  /** Транспорт: probe возвращает `items`, всё прочее — пустой успех. */
  function fake(items: Record<string, unknown>[]) {
    return vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'crm.item.list') return { result: { items } }
      if (method === 'crm.item.add') return { result: { item: { id: 77 } } }
      return { result: { item: {} } }
    }) as unknown as RestCall
  }

  it('элемента НЕТ — создаём полноценно, а не выходим (главный случай #45)', async () => {
    // ⚠ Портал, где смарт-процесс появился ПОЗЖЕ импорта: на том прогоне элемент не создавался
    // вовсе. Прежняя редакция возвращала здесь `missing` и не делала ничего — то есть починка,
    // обещанная человеку в справке, молча не срабатывала именно там, где нужна (находка ревью).
    const call = fake([])
    expect(await backfillPaymentRegistryViaRest(op(), '9', 'alfa-by', SP, call)).toBe('created')
    const add = recorded(call).find(([m]) => m === 'crm.item.add')
    expect(add, 'элемент обязан создаться').toBeTruthy()
    const fields = (add![1].fields ?? {}) as Record<string, unknown>
    expect(fields[dirField]).toBe('Приход')
    expect(fields.companyId, 'ссылка на плательщика — половина смысла реестра').toBe(9)
  })

  it('элемент ПУСТОЙ — дописываем колонки', async () => {
    const call = fake([{ id: 42, [dirField]: '' }])
    expect(await backfillPaymentRegistryViaRest(op(), null, 'alfa-by', SP, call)).toBe('filled')
    const upd = recorded(call).find(([m]) => m === 'crm.item.update')
    expect(upd![1].id).toBe(42)
    expect((upd![1].fields as Record<string, unknown>)[dirField]).toBe('Приход')
  })

  it('элемент УЖЕ заполнен — ни одного лишнего вызова', async () => {
    const call = fake([{ id: 42, [dirField]: 'Приход' }])
    expect(await backfillPaymentRegistryViaRest(op(), null, 'alfa-by', SP, call)).toBe('already')
    expect(recorded(call).some(([m]) => m !== 'crm.item.list'), 'update слать не за чем').toBe(false)
  })

  // ⚠ ИНДИКАТОР — НАПРАВЛЕНИЕ, А НЕ ДАТА, и это находка ревью, а не вкусовщина. Дата приходит ИЗ
  // ВЫПИСКИ, и все четыре нормализатора умеют вернуть пустую строку (банк не прислал / формат не
  // разобран). Пустые значения `registryFieldPayload` опускает, поэтому колонка даты у такой
  // операции не появится НИКОГДА — и дозаливка повторялась бы на каждой загрузке вечно, а счётчик
  // в логе врал бы «дозаполнено N».
  it('операция без даты в выписке не дозаполняется бесконечно — #45', async () => {
    const noDate = op({ acceptDate: '' })
    const call = fake([{ id: 42, [dirField]: 'Приход' }]) // направление записано прошлым прогоном
    expect(await backfillPaymentRegistryViaRest(noDate, null, 'alfa-by', SP, call)).toBe('already')
    expect(recorded(call).some(([m]) => m === 'crm.item.update')).toBe(false)
  })

  it('probe ищет по маркеру операции — чужой элемент не трогаем', async () => {
    const call = fake([{ id: 42, [dirField]: 'Приход' }])
    await backfillPaymentRegistryViaRest(op(), null, 'alfa-by', SP, call)
    const [, params] = recorded(call).find(([m]) => m === 'crm.item.list')!
    const markerField = buildUfFieldNameCamel(SP.id, PAYMENT_SP_FIELDS.marker.postfix)
    expect((params.filter as Record<string, unknown>)[markerField]).toBe(dedupKey(op()))
    // Индикатор идёт тем же запросом — заполненный элемент не стоит второго round-trip.
    expect(params.select).toContain(dirField)
  })
})
