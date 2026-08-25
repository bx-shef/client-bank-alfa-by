import { describe, expect, it } from 'vitest'
import {
  isAccountConfirmed, pickAccountPollers, portalsNeedingConfirm, sharedAccountKey, statementRecipients,
  sharedAccountsLogLine, type SharedAccountRow
} from '../app/utils/accountSharing'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'

// Один счёт из нескольких порталов (#615).
//
// ⚠ Главное, что здесь проверяется, — НЕ «сворачивается ли опрос», а «не уедет ли чужая выписка».
// Первая редакция сопоставляла порталы по ВВЕДЁННОМУ номеру счёта и была утечкой между клиентами:
// номер вписывается руками и у банка не проверяется, поэтому админ портала X мог вписать чужой
// IBAN и получить выписку портала Y себе в CRM.

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function row(over: Partial<SharedAccountRow> = {}): SharedAccountRow {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY09ALFA1',
    accountConfirmedAt: NOW - HOUR,
    connectedAt: NOW - HOUR,
    hasRefresh: true,
    consentExpiresAt: 0,
    ...over
  }
}

describe('кому отдаём выписку', () => {
  it('ОПРАШИВАВШИЙ портал получает свою выписку ВСЕГДА, без подтверждения', () => {
    // ⚠ Главный сценарий продукта, и первая редакция его ЛОМАЛА. Подтверждение спрашивается только
    // про спорные счета, поэтому у портала с уникальным счётом его не будет никогда — выписка
    // забиралась бы из банка успешно и не доходила бы до CRM ни до кого. Ни ошибки, ни строки в
    // логе, только тишина в CRM при живом [fetch]. Он сходил в банк СВОИМ грантом, и банк отдал
    // ему эту выписку — сильнее доказательства владения не бывает.
    const rows = [row({ memberId: 'A', accountConfirmedAt: 0 })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A'])
  })

  it('строки в базе нет вовсе — опрашивавший всё равно получает своё', () => {
    // Счёт отключили, пока задача летела. Выписку он уже забрал своим грантом.
    expect(statementRecipients([], 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A'])
  })

  it('сосед с ПОДТВЕРЖДЁННЫМ счётом получает тоже', () => {
    const rows = [row({ memberId: 'A' }), row({ memberId: 'B' })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A', 'B'])
  })

  it('сосед БЕЗ подтверждения не получает — это и есть утечка', () => {
    // Ровно тот сценарий, который убил первую редакцию: X вписал чужой IBAN руками.
    const rows = [row({ memberId: 'A' }), row({ memberId: 'X', accountConfirmedAt: 0 })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A'])
  })

  it('банк — часть ключа: тот же номер в другом банке это ДРУГОЙ счёт', () => {
    const rows = [row({ memberId: 'A' }), row({ memberId: 'B', provider: 'prior-by' })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A'])
    expect(sharedAccountKey('alfa-by', 'X')).not.toBe(sharedAccountKey('prior-by', 'X'))
  })

  it('мёртвый банковский грант НЕ лишает соседа СВОИХ операций', () => {
    // Доступ он доказал; мёртвый токен мешает ходить в банк, а не получать уже принесённое.
    // Иначе починка «переподключите банк» не отличалась бы от «мы вас отключили».
    const rows = [row({ memberId: 'A' }), row({ memberId: 'B', hasRefresh: false })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A', 'B'])
  })

  it('порядок детерминированный и без повторов', () => {
    const rows = [row({ memberId: 'B' }), row({ memberId: 'A' }), row({ memberId: 'B' })]
    expect(statementRecipients(rows, 'alfa-by', 'BY09ALFA1', 'A')).toEqual(['A', 'B'])
  })

  it('подтверждением считается только положительная метка', () => {
    expect(isAccountConfirmed({ accountConfirmedAt: 0 })).toBe(false)
    expect(isAccountConfirmed({ accountConfirmedAt: -1 })).toBe(false)
    expect(isAccountConfirmed({ accountConfirmedAt: Number.NaN })).toBe(false)
    expect(isAccountConfirmed({ accountConfirmedAt: 1 })).toBe(true)
  })
})

describe('выбор поллера', () => {
  it('два подтверждённых портала — остаётся ОДНА задача вместо двух', () => {
    const rows = [row({ memberId: 'A' }), row({ memberId: 'B' })]
    expect(pickAccountPollers(rows, NOW)).toHaveLength(1)
  })

  it('НЕподтверждённая строка не сворачивается и не пропадает', () => {
    // ⚠ Отбрось её — и портал, чей счёт банк ещё не подтвердил, молча перестал бы получать выписку
    // вовсе. Объедини с чужой — вернулась бы утечка. Значит она живёт сама по себе, как раньше.
    const rows = [row({ memberId: 'A' }), row({ memberId: 'X', accountConfirmedAt: 0 })]
    const got = pickAccountPollers(rows, NOW)
    expect(got).toHaveLength(2)
    expect(got.map(r => r.memberId).sort()).toEqual(['A', 'X'])
  })

  it('живое подключение важнее свежего', () => {
    // Поллер с мёртвым грантом уронил бы задачу и оставил без выписки ВСЕХ.
    const dead = row({ memberId: 'A', hasRefresh: false, connectedAt: NOW })
    const alive = row({ memberId: 'B', connectedAt: NOW - 5 * HOUR })
    expect(pickAccountPollers([dead, alive], NOW)[0]?.memberId).toBe('B')
  })

  it('среди живых берём самое свежее подключение', () => {
    const old = row({ memberId: 'A', connectedAt: NOW - 5 * HOUR })
    const fresh = row({ memberId: 'B', connectedAt: NOW - HOUR })
    expect(pickAccountPollers([old, fresh], NOW)[0]?.memberId).toBe('B')
  })

  it('ничья разрывается детерминированно — иначе гонка возвращается по очереди', () => {
    // ⚠ Порядок строк из Postgres при равных значениях не определён. Без явного разрыва поллер
    // дрейфовал бы от тика к тику, и подключения по очереди ротировали бы refresh.
    const a = row({ memberId: 'A' })
    const b = row({ memberId: 'B' })
    expect(pickAccountPollers([a, b], NOW)[0]?.memberId).toBe('A')
    expect(pickAccountPollers([b, a], NOW)[0]?.memberId).toBe('A')
  })

  it('живых нет вовсе — счёт всё равно опрашивается, а не пропадает молча', () => {
    // Один падающий запрос честнее тишины: он виден в логе и в состоянии подключения, а молча
    // пропущенный счёт неотличим от «операций не было».
    const ttl = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000
    const rows = [
      row({ memberId: 'A', connectedAt: NOW - ttl - HOUR }),
      row({ memberId: 'B', connectedAt: NOW - ttl - 2 * HOUR })
    ]
    expect(pickAccountPollers(rows, NOW)).toHaveLength(1)
  })

  it('разные счета не схлопываются между собой', () => {
    const rows = [row({ accountKey: 'BY01' }), row({ accountKey: 'BY02' })]
    expect(pickAccountPollers(rows, NOW)).toHaveLength(2)
  })
})

describe('строка лога', () => {
  it('сворачивать было нечего — молчим', () => {
    expect(sharedAccountsLogLine(3, 3)).toBeNull()
  })

  it('свернули — говорим числами, без номеров счетов', () => {
    const line = sharedAccountsLogLine(4, 2) ?? ''
    expect(line).toContain('с 4 задач до 2')
    expect(line).toContain('ПОДТВЕРДИЛ')
  })
})

describe('кого переспрашивать у банка', () => {
  it('счёт заявлен двумя порталами и не подтверждён — спрашиваем', () => {
    const rows = [
      row({ memberId: 'A', accountConfirmedAt: 0 }),
      row({ memberId: 'B', accountConfirmedAt: 0 })
    ]
    expect(portalsNeedingConfirm(rows)).toEqual(['A', 'B'])
  })

  it('счёт у портала уникален — НЕ спрашиваем, раздавать некому', () => {
    // ⚠ На обычном флоте (у каждого свой счёт) проход не делает ни одного обращения к банку.
    const rows = [
      row({ memberId: 'A', accountKey: 'BY01', accountConfirmedAt: 0 }),
      row({ memberId: 'B', accountKey: 'BY02', accountConfirmedAt: 0 })
    ]
    expect(portalsNeedingConfirm(rows)).toEqual([])
  })

  it('уже подтверждённый повторно не спрашивается, но повод для соседа даёт', () => {
    const rows = [row({ memberId: 'A' }), row({ memberId: 'B', accountConfirmedAt: 0 })]
    expect(portalsNeedingConfirm(rows)).toEqual(['B'])
  })

  it('тот же номер в разных банках спором НЕ считается', () => {
    const rows = [
      row({ memberId: 'A', accountConfirmedAt: 0 }),
      row({ memberId: 'B', provider: 'prior-by', accountConfirmedAt: 0 })
    ]
    expect(portalsNeedingConfirm(rows)).toEqual([])
  })

  it('один портал держит счёт дважды — это не спор с самим собой', () => {
    const rows = [
      row({ memberId: 'A', accountConfirmedAt: 0 }),
      row({ memberId: 'A', accountConfirmedAt: 0 })
    ]
    expect(portalsNeedingConfirm(rows)).toEqual([])
  })
})
