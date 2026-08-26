import { describe, expect, it } from 'vitest'
import { isPollableAccount, pollSkipReason } from '../server/queue/cron'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'
import type { BankAccountRef } from '../server/utils/bankTokenStore'

// Правило «почему опрашивать нечего» (#488). Живёт отдельным файлом, потому что отвечает не на
// вопрос «сколько влезет в тик» (`pollCapacity`) и не на «что кладём в очередь» (`queuePhase2`),
// а на единственный вопрос оператора, глядящего в пустой лог: сломано или просто нечего делать.

describe('ПОЧЕМУ опрашивать нечего — молчание тут неотличимо от поломки (#488)', () => {
  // ⚠ Заведено по факту потерянных дней. Крон-тик при пустом отборе возвращался МОЛЧА, и на боевом
  // стенде вышла картина, в которой не работало решительно ничего: пустые `[fetch]`, `[crm-sync]`,
  // `[op]`, ни падений, ни ретраев — и ни строки о причине. Причин ТРИ, чинятся они в разных
  // местах, а выглядели одинаково.

  const ref = (over: Partial<BankAccountRef> = {}): BankAccountRef => ({
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY00ALFA0001',
    pollPaused: false,
    ...over
  })

  it('есть хоть один опрашиваемый счёт — молчим, объяснять нечего', () => {
    expect(pollSkipReason([ref()])).toBeNull()
    expect(pollSkipReason([ref({ accountKey: provisionalAccountKey('n1') }), ref()])).toBeNull()
  })

  it('подключений нет вовсе — это НЕ поломка опроса', () => {
    const why = pollSkipReason([])
    expect(why).toContain('нет ни одного')
    // ⚠ Не должно читаться как сбой: чинится это подключением банка, а не сервером.
    expect(why).not.toContain('ошибк')
  })

  it('счёт не выбран — называем это прямо, вместе с числом', () => {
    const why = pollSkipReason([ref({ accountKey: provisionalAccountKey('n1') })])
    expect(why).toContain('без выбранного счёта')
    expect(why).toContain('из 1')
  })

  it('пауза — отдельная причина, не сваливается в «счёт не выбран»', () => {
    const why = pollSkipReason([ref({ pollPaused: true })])!
    expect(why).toContain('1 на паузе')
    // ⚠ Именно РАЗДЕЛЕНИЕ и важно: снять паузу и выбрать счёт — разные действия в разных местах
    // экрана. Замерено мутацией: пока паузы не было в наборе, «pending считается как paused»
    // проходило зелёным.
    expect(why).not.toContain('без выбранного счёта')
  })

  it('пауза и невыбранный счёт вместе — оба названы своими числами', () => {
    const why = pollSkipReason([
      ref({ pollPaused: true }),
      ref({ accountKey: provisionalAccountKey('n1') })
    ])!
    expect(why).toContain('1 без выбранного счёта')
    expect(why).toContain('1 на паузе')
  })

  it('⚠ причины НЕ смешиваются: каждая со своим числом', () => {
    // Иначе «из 3 подключений что-то не так» отправляет проверять всё подряд.
    const rows = [
      ref({ accountKey: provisionalAccountKey('n1') }),
      ref({ accountKey: provisionalAccountKey('n2') }),
      ref({ provider: 'manual', accountKey: 'M' })
    ]
    const why = pollSkipReason(rows)!
    expect(why).toContain('2 без выбранного счёта')
    expect(why).toContain('1 не опрашиваются по типу')
    expect(why).toContain('из 3')
  })

  it('в строку не попадают ни номер счёта, ни портал', () => {
    // Лог живёт до вытеснения по объёму (#617) — номеров там быть не должно.
    const why = pollSkipReason([ref({ accountKey: provisionalAccountKey('secret') })])!
    expect(why).not.toContain('secret')
    expect(why).not.toContain('M1')
    expect(why).not.toContain('BY00')
  })

  it('⚠ КАЖДАЯ причина отказа `isPollableAccount` названа — иначе строка соврёт про «паузу»', () => {
    // ⚠ Замечание ревью: `pollSkipReason` перечисляет условия ВРУЧНУЮ, а всё, что не подошло под
    // первые три, молча зачисляет в «на паузе». Появись у `isPollableAccount` пятое условие — оно
    // приземлилось бы туда же, и оператор пошёл бы снимать паузу, которой никто не ставил.
    // Скомпилировать сверку нельзя (условия — тело функции), поэтому проверяем ИСХОДОМ: для
    // каждого известного отказа строка обязана назвать СВОЮ формулировку, а совпадение двух
    // формулировок означало бы ровно ту склейку.
    const cases: Array<{ row: BankAccountRef, needle: string }> = [
      { row: ref({ provider: 'manual', accountKey: 'M' }), needle: 'не опрашиваются по типу' },
      { row: ref({ accountKey: provisionalAccountKey('n1') }), needle: 'без выбранного счёта' },
      { row: ref({ pollPaused: true }), needle: 'на паузе' }
    ]
    const seen = new Set<string>()
    for (const c of cases) {
      expect(isPollableAccount(c.row), 'фикстура перестала быть отказом — тест проверяет не то').toBe(false)
      const why = pollSkipReason([c.row])!
      expect(why, `причина «${c.needle}» не названа`).toContain(c.needle)
      seen.add(c.needle)
    }
    expect(seen.size, 'две причины склеились в одну формулировку').toBe(cases.length)
  })
})
