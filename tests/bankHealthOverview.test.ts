import { describe, expect, it } from 'vitest'
import {
  attentionHeadline, bankHealthRows, HEALTH_ORDER, HEALTH_TITLE, PREVIEW_BANK_HEALTH,
  spreadLabel, subscriptionRowViews, summarizeBankHealth, type BankHealthRow
} from '../app/utils/bankHealthOverview'
import { BANK_REFRESH_TTL_SEC, refreshAtAgeMs } from '../app/utils/bankTokenLifetime'
import { SUBSCRIPTION_CUTOFF_DAYS } from '../app/utils/portalSubscription'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'

// Обзор состояния подключений ДЛЯ НАС (#497 §3). Умирающее подключение сегодня узнаётся по факту
// неработающего импорта — то есть позже клиента, тогда как критерий приёмки сформулирован ровно
// наоборот: «бухгалтер видит свои платежи, а МЫ видим его проблемы».

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function row(over: Partial<BankHealthRow> = {}): BankHealthRow {
  return {
    id: 1,
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY01',
    connectedAt: NOW,
    expiresAt: NOW + HOUR,
    hasRefresh: true,
    ...over
  }
}

describe('summarizeBankHealth', () => {
  it('пустой стор — честные нули, а не отсутствие ответа', () => {
    const s = summarizeBankHealth([], NOW)
    expect(s.total).toEqual({ connections: 0, portals: 0 })
    expect(s.needAttention).toBe(0)
    expect(s.byHealth.ok.connections).toBe(0)
  })

  it('считает и подключения, и ПОРТАЛЫ — это разные числа', () => {
    // Пять умерших подключений одного клиента и пять у пяти разных — совершенно разные ситуации,
    // и по одному счётчику их не отличить.
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A' }),
      row({ memberId: 'M1', accountKey: 'B' }),
      row({ memberId: 'M2', accountKey: 'C' })
    ], NOW)
    expect(s.total).toEqual({ connections: 3, portals: 2 })
    expect(s.byHealth.ok).toEqual({ connections: 3, portals: 2 })
  })

  it('без refresh-токена — «нужно переподключить», и портал попадает в требующие внимания', () => {
    const s = summarizeBankHealth([row({ hasRefresh: false })], NOW)
    expect(s.byHealth['no-refresh'].connections).toBe(1)
    expect(s.needAttention).toBe(1)
  })

  it('в полосе обновления — «скоро обновим», человека не требует', () => {
    const age = refreshAtAgeMs('alfa-by') + HOUR
    const s = summarizeBankHealth([row({ connectedAt: NOW - age })], NOW)
    expect(s.byHealth.due.connections).toBe(1)
    expect(s.needAttention).toBe(0)
  })

  it('старше измеренного срока — «истекло» и требует человека', () => {
    const age = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 + HOUR
    const s = summarizeBankHealth([row({ connectedAt: NOW - age })], NOW)
    expect(s.byHealth.expired.connections).toBe(1)
    expect(s.needAttention).toBe(1)
  })

  it('портал считается требующим внимания ОДИН раз, даже если у него сломано несколько счетов', () => {
    // Чинится это походом к конкретному клиенту, а не «в среднем по больнице»: важно число
    // разговоров, которые предстоят, а не число строк.
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A', hasRefresh: false }),
      row({ memberId: 'M1', accountKey: 'B', hasRefresh: false }),
      row({ memberId: 'M1', accountKey: 'C', connectedAt: NOW - BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 - HOUR })
    ], NOW)
    expect(s.needAttention).toBe(1)
    expect(s.byHealth['no-refresh'].connections).toBe(2)
  })

  it('ожидающие подключения считаются ОТДЕЛЬНО и не выдаются за здоровые', () => {
    // Формально они живы, но опрашивать по ним нечего — у банка нет такого «номера». Смешав их с
    // `ok`, экран показывал бы здоровье там, где настройка просто не закончена.
    const s = summarizeBankHealth([
      row({ accountKey: provisionalAccountKey('n1') }),
      row({ accountKey: 'BY01' })
    ], NOW)
    expect(s.pending).toEqual({ connections: 1, portals: 1 })
    expect(s.byHealth.ok.connections).toBe(1)
    expect(s.total.connections).toBe(2)
  })

  it('угаданный срок жизни не превращается в «истекло» — как и на сервере, и в интерфейсе', () => {
    // Инвариант держится по всей цепочке: у Приора цифра — догадка, и хоронить по ней нельзя нигде.
    const age = BANK_REFRESH_TTL_SEC['prior-by'] * 1000 + HOUR
    const s = summarizeBankHealth([row({ provider: 'prior-by', connectedAt: NOW - age })], NOW)
    expect(s.byHealth.expired.connections).toBe(0)
    expect(s.byHealth.due.connections).toBe(1)
    expect(s.needAttention).toBe(0)
  })
})

describe('подача на экране', () => {
  it('сначала то, что требует человека — экран не должен начинаться с «всё хорошо»', () => {
    expect(HEALTH_ORDER[0]).toBe('no-refresh')
    expect(HEALTH_ORDER[1]).toBe('expired')
    expect(HEALTH_ORDER[HEALTH_ORDER.length - 1]).toBe('ok')
  })

  it('у каждого состояния есть подпись', () => {
    for (const h of HEALTH_ORDER) expect(HEALTH_TITLE[h]?.length).toBeGreaterThan(0)
  })

  it('порядок покрывает ВСЕ состояния — новое не должно молча исчезнуть с экрана', () => {
    expect([...HEALTH_ORDER].sort()).toEqual(Object.keys(HEALTH_TITLE).sort())
  })
})

describe('склонения на экране', () => {
  it('«портале/порталах» по русским правилам, а не через «=== 1»', () => {
    // ⚠ Первая версия склоняла в шаблоне руками и для 5+ выдавала «5 портала(ов)». Ручной
    // суррогат в `<script setup>` нельзя было покрыть тестом — поэтому он и дожил до ревью.
    expect(spreadLabel(1, 1)).toBe('1 на 1 портале')
    expect(spreadLabel(3, 2)).toBe('3 на 2 порталах')
    expect(spreadLabel(9, 5)).toBe('9 на 5 порталах')
    expect(spreadLabel(0, 21)).toBe('0 на 21 портале')
  })

  it('заголовок склоняет «портал требует/порталов требуют» и не говорит «(ов)»', () => {
    const one = attentionHeadline({ ...PREVIEW_BANK_HEALTH, needAttention: 1 })
    const five = attentionHeadline({ ...PREVIEW_BANK_HEALTH, needAttention: 5 })
    expect(one).toContain('1 портал требует')
    expect(five).toContain('5 порталов требуют')
    expect(five).not.toContain('(ов)')
  })

  it('без проблем заголовок говорит «живы», а не «0 порталов требуют»', () => {
    expect(attentionHeadline({ ...PREVIEW_BANK_HEALTH, needAttention: 0 })).toBe('Все подключения живы.')
  })

  it('строки идут «сначала требующие человека» и без пустых', () => {
    const rows = bankHealthRows(PREVIEW_BANK_HEALTH)
    expect(rows[0]?.health).toBe('no-refresh')
    expect(rows.map(r => r.health)).not.toContain('unknown') // 0 подключений — строки нет
    expect(rows.every(r => r.connections > 0)).toBe(true)
  })

  it('у каждой строки готовая подпись — компонент только печатает', () => {
    const row = bankHealthRows(PREVIEW_BANK_HEALTH).find(r => r.health === 'expired')
    expect(row?.countLabel).toBe('2 на 1 портале')
    expect(row?.title).toBe('истекло')
  })
})

describe('приватность сводки', () => {
  it('в ответе нет ни номеров счетов, ни идентификаторов порталов', () => {
    // Оператор смотрит сюда, чтобы понять «что-то ломается и у скольких», а не чтобы читать
    // реквизиты чужих компаний.
    const s = summarizeBankHealth([row({ memberId: 'SECRET-MEMBER', accountKey: 'BY00SECRET0001' })], NOW)
    const json = JSON.stringify(s)
    expect(json).not.toContain('SECRET-MEMBER')
    expect(json).not.toContain('BY00SECRET0001')
  })

  it('у ведра РОВНО два поля — лишнее не проскочит мимо проверки по подстроке', () => {
    // ⚠ Проверка по подстроке ловит только те утечки, чьё значение мы угадали в фикстуре. Утечка
    // приезжает как ЛИШНЕЕ ПОЛЕ («заодно положим сюда последний member_id, пригодится»), и поймать
    // её надо структурно, независимо от того, что в нём лежит.
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A', hasRefresh: false }),
      row({ memberId: 'M2', accountKey: 'B' })
    ], NOW)
    for (const [name, bucket] of Object.entries(s.byHealth)) {
      expect(Object.keys(bucket).sort(), name).toEqual(['connections', 'portals'])
    }
    expect(Object.keys(s.pending).sort()).toEqual(['connections', 'portals'])
    expect(Object.keys(s.total).sort()).toEqual(['connections', 'portals'])
  })

  it('верхний уровень сводки — тоже закрытый список полей', () => {
    const s = summarizeBankHealth([row()], NOW)
    expect(Object.keys(s).sort()).toEqual(['byHealth', 'needAttention', 'pending', 'total'])
  })
})

describe('метки требующих внимания порталов', () => {
  it('без хешера поля НЕТ — забытая зависимость не может отдать сырые member_id', () => {
    // Fail-safe важнее удобства: если бы поле появлялось «как есть» при отсутствии хешера,
    // единственная забытая проводка превратила бы экран в список идентификаторов порталов.
    const s = summarizeBankHealth([row({ memberId: 'M1', hasRefresh: false })], NOW)
    expect(s.attentionPortals).toBeUndefined()
  })

  it('с хешером отдаёт метки, а не идентификаторы, и только по требующим человека', () => {
    const s = summarizeBankHealth([
      row({ memberId: 'DEAD-1', hasRefresh: false }),
      row({ memberId: 'DEAD-2', accountKey: 'B', connectedAt: NOW - BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 - HOUR }),
      row({ memberId: 'HEALTHY', accountKey: 'C' })
    ], NOW, m => `h(${m})`)
    expect(s.attentionPortals).toEqual(['h(DEAD-1)', 'h(DEAD-2)'])
    expect(JSON.stringify(s)).not.toContain('HEALTHY')
  })

  it('метки СОРТИРОВАНЫ — иначе одна и та же сводка «мигала» бы от порядка строк в БД', () => {
    const rows = [
      row({ memberId: 'zzz', hasRefresh: false }),
      row({ memberId: 'aaa', accountKey: 'B', hasRefresh: false })
    ]
    const straight = summarizeBankHealth(rows, NOW, m => m)
    const reversed = summarizeBankHealth([...rows].reverse(), NOW, m => m)
    expect(straight.attentionPortals).toEqual(['aaa', 'zzz'])
    expect(reversed.attentionPortals).toEqual(straight.attentionPortals)
  })

  it('число меток совпадает с needAttention — иначе экран противоречит сам себе', () => {
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A', hasRefresh: false }),
      row({ memberId: 'M1', accountKey: 'B', hasRefresh: false }),
      row({ memberId: 'M2', accountKey: 'C', hasRefresh: false })
    ], NOW, m => m)
    expect(s.attentionPortals).toHaveLength(s.needAttention)
  })
})

describe('превью-фикстура', () => {
  it('арифметика сходится — эталон скриншота не должен показывать невозможное состояние', () => {
    // На эту карточку потом смотрят как на образец; фикстура, где итог не равен сумме, учит
    // читателя неверной арифметике и прячет настоящее расхождение, когда оно появится.
    const buckets = Object.values(PREVIEW_BANK_HEALTH.byHealth)
    const sum = buckets.reduce((n, b) => n + b.connections, 0) + PREVIEW_BANK_HEALTH.pending.connections
    expect(sum).toBe(PREVIEW_BANK_HEALTH.total.connections)
  })

  it('needAttention не больше числа порталов и согласован с метками', () => {
    expect(PREVIEW_BANK_HEALTH.needAttention).toBeLessThanOrEqual(PREVIEW_BANK_HEALTH.total.portals)
    expect(PREVIEW_BANK_HEALTH.attentionPortals).toHaveLength(PREVIEW_BANK_HEALTH.needAttention)
  })

  it('показывает ИНТЕРЕСНЫЙ случай — иначе эталон не документирует смысл карточки', () => {
    expect(PREVIEW_BANK_HEALTH.needAttention).toBeGreaterThan(0)
    expect(PREVIEW_BANK_HEALTH.pending.connections).toBeGreaterThan(0)
  })
})

describe('#599 attentionConnections — поштучный список для ручного отключения', () => {
  const DAY = 86_400_000
  const ALFA_TTL = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000
  // ⚠ Фейковый хеш НЕ встраивает сырой member_id — иначе `not.toContain(member)` ловил бы его же
  // внутри `hash-<member>`. Реальный portalHash это SHA-256 и сырого id не содержит.
  const HASH: Record<string, string> = {
    'MEMBER-RAW-AAA': 'aaa000opaque', 'MEMBER-RAW-BBB': 'bbb111opaque', 'MEMBER-RAW-CCC': 'ccc222opaque',
    'A': 'aOpaque', 'B': 'bOpaque', 'C': 'cOpaque'
  }
  const hash = (m: string) => HASH[m] ?? 'zOpaque'

  it('нездоровые строки попадают в список с opaque id и меткой портала, БЕЗ счёта', () => {
    const rows = [
      row({ id: 5, memberId: 'MEMBER-RAW-AAA', accountKey: 'BY_SECRET_01', hasRefresh: false }), // no-refresh
      row({ id: 6, memberId: 'MEMBER-RAW-BBB', connectedAt: NOW - ALFA_TTL - 40 * DAY }), // expired
      row({ id: 7, memberId: 'MEMBER-RAW-CCC' }) // ok
    ]
    const o = summarizeBankHealth(rows, NOW, hash)
    expect(o.attentionConnections?.map(c => c.id).sort()).toEqual([5, 6])
    const json = JSON.stringify(o.attentionConnections)
    expect(json).not.toContain('BY_SECRET_01')
    // ⚠ Сырого member_id в выводе быть не должно — только его хеш.
    expect(json).not.toContain('MEMBER-RAW-AAA')
    expect(json).toContain('aaa000opaque')
  })

  it('deadDays датируется для измеренной смерти и null для no-refresh без согласия', () => {
    const rows = [
      row({ id: 6, memberId: 'B', connectedAt: NOW - ALFA_TTL - 30 * DAY }), // 30 дней мёртв
      row({ id: 5, memberId: 'A', hasRefresh: false }) // no-refresh, даты нет
    ]
    const o = summarizeBankHealth(rows, NOW, hash)
    const byId = new Map(o.attentionConnections!.map(c => [c.id, c.deadDays]))
    expect(byId.get(6)).toBe(30)
    expect(byId.get(5)).toBeNull()
  })

  it('БЕЗ хешера поля нет вовсе — та же граница приватности, что у attentionPortals', () => {
    const o = summarizeBankHealth([row({ hasRefresh: false })], NOW)
    expect(o.attentionConnections).toBeUndefined()
  })

  it('ожидающие (~pending:) в список не попадают', () => {
    const o = summarizeBankHealth([row({ accountKey: provisionalAccountKey('n1'), hasRefresh: false })], NOW, hash)
    expect(o.attentionConnections).toEqual([])
  })
})

describe('#599 bankAttentionRowViews — подписи строк', () => {
  it('банк, метка портала и «мёртво N дней»; без даты — состояние', async () => {
    const { bankAttentionRowViews } = await import('../app/utils/bankHealthOverview')
    const views = bankAttentionRowViews({
      ...PREVIEW_BANK_HEALTH,
      attentionConnections: [
        { id: 1, portalHash: 'abcd', provider: 'alfa-by', health: 'expired', deadDays: 42 },
        { id: 2, portalHash: 'ef01', provider: 'prior-by', health: 'no-refresh', deadDays: null }
      ]
    })
    expect(views[0]!.label).toContain('Альфа-Банк')
    expect(views[0]!.label).toContain('abcd')
    expect(views[0]!.label).toContain('42')
    expect(views[1]!.label).toContain('переподключить')
  })
})

describe('раздел «подписка не отвечает» (#614)', () => {
  const NOW_S = 1_800_000_000_000
  const DAY_S = 86_400_000

  function subRow(over: Partial<BankHealthRow> = {}): BankHealthRow {
    return {
      id: 1, memberId: 'M1', provider: 'alfa-by', accountKey: 'BY01',
      connectedAt: NOW_S - 60_000, expiresAt: NOW_S + 3_600_000, hasRefresh: true,
      lastAttemptAt: 0, consentExpiresAt: 0, pollPaused: false, grantId: '', ...over
    } as BankHealthRow
  }
  const hash = (m: string) => `h-${m}`

  it('живое банковское подключение попадает в раздел, если подписка мертва', () => {
    // Весь смысл раздела: с банком всё в порядке, сломана оплата Битрикса. Без этого случая
    // оператор увидел бы пустоту ровно там, где клиент не может помочь себе сам.
    const o = summarizeBankHealth([subRow()], NOW_S, hash, new Map([['M1', NOW_S - 3 * DAY_S]]))
    expect(o.subscriptionDead).toHaveLength(1)
    expect(o.subscriptionDead?.[0]).toMatchObject({ id: 1, deadDays: 3, health: 'ok' })
  })

  it('без метки подписки раздела НЕТ', () => {
    const o = summarizeBankHealth([subRow()], NOW_S, hash, new Map())
    expect(o.subscriptionDead).toBeUndefined()
  })

  it('без хешера раздела нет — сырой member_id наружу не уходит', () => {
    // Тот же fail-safe, что у соседей: забытая зависимость даёт экран без действий, а не утечку.
    const o = summarizeBankHealth([subRow()], NOW_S, undefined, new Map([['M1', NOW_S - 3 * DAY_S]]))
    expect(o.subscriptionDead).toBeUndefined()
    expect(JSON.stringify(o)).not.toContain('M1')
  })

  it('дольше молчащие идут первыми — у них ближе автоотключение', () => {
    const rows = [subRow({ id: 1, memberId: 'A' }), subRow({ id: 2, memberId: 'B' })]
    const o = summarizeBankHealth(rows, NOW_S, hash, new Map([['A', NOW_S - DAY_S], ['B', NOW_S - 3 * DAY_S]]))
    expect(o.subscriptionDead?.map(c => c.id)).toEqual([2, 1])
  })

  it('строка нерабочая И по банку, И по подписке — показывается ОДИН раз, в банковском разделе', () => {
    // ⚠ Разделы взаимоисключающи: у списков общий `confirmDisconnectId`, поэтому вторая копия не
    // просто дублировала бы строку — клик по одной переводил бы в подтверждение и другую.
    // ⚠ Приоритет банковский, тот же что на сервере: такую строку чинит владелец счёта входом в
    // интернет-банк, и подписка этого не отменяет.
    const dead = subRow({ hasRefresh: false }) // → health 'no-refresh', то есть «требует человека»
    const o = summarizeBankHealth([dead], NOW_S, hash, new Map([['M1', NOW_S - 3 * DAY_S]]))
    expect(o.subscriptionDead).toBeUndefined()
    expect(o.attentionConnections?.map(c => c.id)).toEqual([1])
  })

  it('подпись говорит и СКОЛЬКО молчит, и КОГДА отключим', () => {
    // Оператор должен видеть не только состояние, но и что произойдёт само и когда — иначе он либо
    // отключит раньше времени, либо решит, что висеть это может вечно.
    const o = summarizeBankHealth([subRow()], NOW_S, hash, new Map([['M1', NOW_S - 2 * DAY_S]]))
    const label = subscriptionRowViews(o)[0]!.label
    expect(label).toContain('не отвечает 2 дня')
    expect(label).toContain('отключим через 2 дня')
  })

  it('подпись НЕ говорит «мёртво» — причина не в банке', () => {
    // Одинаковая с банковской формулировка отправила бы оператора говорить клиенту не то.
    const o = summarizeBankHealth([subRow()], NOW_S, hash, new Map([['M1', NOW_S - 2 * DAY_S]]))
    expect(subscriptionRowViews(o)[0]!.label).not.toContain('мёртво')
  })

  it('когда срок вышел — так и написано, а не «через 0 дней»', () => {
    // ⚠ Ровно НА отсечке, а не «сильно позже»: только этот день отличает `left > 0` от `left >= 0`,
    // и первая редакция теста брала девятый день — мутация «>= 0» проходила зелёной (замерено).
    const due = new Map([['M1', NOW_S - SUBSCRIPTION_CUTOFF_DAYS * DAY_S]])
    expect(subscriptionRowViews(summarizeBankHealth([subRow()], NOW_S, hash, due))[0]!.label)
      .toContain('отключение уже наступило')
    const over = new Map([['M1', NOW_S - 9 * DAY_S]])
    expect(subscriptionRowViews(summarizeBankHealth([subRow()], NOW_S, hash, over))[0]!.label)
      .toContain('отключение уже наступило')
  })
})
