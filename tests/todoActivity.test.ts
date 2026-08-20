import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  ACTIVITY_ORIGINATOR_ID, DESCRIPTION_TYPE_BB, MAX_TITLE_CHARS, TODO_COLOR_CREDIT, TODO_COLOR_DEBIT,
  activityOriginId, buildActivityDescription, buildActivityMarkerUpdate, buildTodoActivity
} from '../app/utils/todoActivity'
import { formatMoney } from '../app/utils/activity'

// Носитель операции сменился с настраиваемого дела на универсальное (#495): прежнее ломало
// карточку компании и не умело сказать глазом три вещи — цвет, срок и «не сделано».
// Здесь закреплено то, что легко потерять при переносе: маркер (на нём держится дедуп),
// нейтрализация BB (описание теперь РАЗМЕЧЕННОЕ, а не текстовые блоки) и цвет по направлению.

function item(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY00OUR0000000000000000000',
    docId: 'D-1',
    direction: 'credit',
    amount: 1234.5,
    currency: 'BYN',
    purpose: 'оплата по счёту',
    counterparty: { name: 'ООО Ромашка', unp: '191234567', account: 'BY00THEM000000000000000000' },
    acceptDate: '2026-08-15T00:00:00.000Z',
    ...over
  }
}

describe('buildTodoActivity', () => {
  it('приход зелёный, расход красный — цвет по НАПРАВЛЕНИЮ', () => {
    expect(buildTodoActivity(item(), { id: 7 }).colorId).toBe(TODO_COLOR_CREDIT)
    expect(buildTodoActivity(item({ direction: 'debit' }), { id: 7 }).colorId).toBe(TODO_COLOR_DEBIT)
  })

  it('цвет передаётся ВСЕГДА — «не задан» и «жёлтый» на портале неотличимы', () => {
    // У жёлтого нет номера: его получают, НЕ передав colorId. Забытый параметр читался бы
    // как осознанный выбор, поэтому отсутствия ключа быть не должно ни в одной ветке.
    for (const d of ['credit', 'debit'] as const) {
      expect(buildTodoActivity(item({ direction: d }), { id: 1 })).toHaveProperty('colorId')
    }
  })

  it('дело НЕ закрывается — закрытое читается как «сделано, смотреть незачем»', () => {
    // Платёж это то, с чем человек ещё должен что-то сделать. Отсутствие флага здесь —
    // решение, а не недосмотр, и невидимо без этого теста.
    const p = buildTodoActivity(item(), { id: 1 }) as unknown as Record<string, unknown>
    expect(p.completed).toBeUndefined()
    expect(p.COMPLETED).toBeUndefined()
  })

  it('владелец — компания, ответственный ставится только когда он есть', () => {
    expect(buildTodoActivity(item(), { id: 42 })).toMatchObject({ ownerTypeId: 4, ownerId: 42 })
    expect(buildTodoActivity(item(), { id: 42 }).responsibleId).toBeUndefined()
    expect(buildTodoActivity(item(), { id: 42, assignedById: 9 }).responsibleId).toBe(9)
  })

  it('срок штампуется таймзоной портала, а не голым UTC', () => {
    expect(buildTodoActivity(item(), { id: 1 }).deadline).toContain('+03:00')
  })

  it('заголовок капится и нейтрализуется — он тоже строится из внешних полей', () => {
    const long = buildTodoActivity(item({ counterparty: { name: 'Я'.repeat(400), unp: '', account: '' } }), { id: 1 })
    expect(long.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
    const evil = buildTodoActivity(item({ counterparty: { name: '[URL=http://evil]клик[/URL]', unp: '', account: '' } }), { id: 1 })
    expect(evil.title).not.toContain('[URL=')
  })
})

describe('buildActivityDescription', () => {
  it('BB-скобки из назначения обезврежены — описание теперь РАЗМЕЧЕННОЕ', () => {
    // На прежнем носителе блок был текстовым и разметку не разбирал. Здесь `[URL=…]` из
    // платёжки стал бы настоящей ссылкой в карточке клиента.
    const d = buildActivityDescription(item({ purpose: '[URL=http://evil.test]выплата[/URL]' }))
    expect(d).not.toContain('[URL=http://evil.test]')
    expect(d).toContain('выплата')
  })

  it('пустые поля не рисуются пустой строкой', () => {
    // Физлицо без УНП, комиссия без назначения. «УНП:» без значения читается как баг у нас,
    // а не как отсутствие данных у банка.
    const d = buildActivityDescription(item({ purpose: '', counterparty: { name: 'Иванов', unp: '', account: '' } }))
    expect(d).not.toContain('УНП')
    expect(d).not.toContain('Назначение')
    expect(d).not.toContain('Счёт:')
    expect(d).toContain('Иванов')
  })

  it('причина (#91) идёт ПЕРВОЙ — это первый вопрос читателя', () => {
    const d = buildActivityDescription(item(), 'Клиент не определён: счёт не найден в CRM.')
    expect(d.startsWith('Клиент не определён')).toBe(true)
  })

  it('суммы и направление на месте, приход и расход подписаны по-разному', () => {
    // Сумму берём у самого форматтера: он ставит НЕРАЗРЫВНЫЙ пробел, и литерал в тесте
    // сравнивался бы с похожей, но другой строкой.
    expect(buildActivityDescription(item())).toContain(`[B]Приход:[/B] ${formatMoney(1234.5)} BYN`)
    expect(buildActivityDescription(item({ direction: 'debit' }))).toContain('[B]Расход:[/B]')
  })
})

describe('маркер дедупа', () => {
  it('ORIGINATOR_ID тот же, что был у прежнего носителя', () => {
    // ⚠ Переименование сделало бы уже записанные дела чужими: повторный опрос завёл бы второе
    // дело на каждую импортированную операцию. Значение закреплено намеренно.
    expect(ACTIVITY_ORIGINATOR_ID).toBe('ShefClientBankAlfaBy')
  })

  it('ORIGIN_ID = ключ операции', () => {
    expect(activityOriginId(item())).toBe('BY00OUR0000000000000000000|D-1')
  })

  it('update несёт И маркер, И тип описания — двух вызовов быть не должно', () => {
    // Два отдельных update стоили бы лишнего обращения к порталу на КАЖДУЮ операцию.
    const f = buildActivityMarkerUpdate(item())
    expect(f).toEqual({
      DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB,
      ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID,
      ORIGIN_ID: 'BY00OUR0000000000000000000|D-1'
    })
  })

  it('тип описания = 3 (BB), иначе разметка покажется исходником', () => {
    // Дефолт у портала — 2 (HTML), и тогда человек читает «[B]Контрагент:[/B]» буквально.
    expect(DESCRIPTION_TYPE_BB).toBe(3)
  })
})
