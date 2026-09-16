import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  ACTIVITY_BLOCKS_SET_METHOD, MAX_LAYOUT_BLOCKS, SOURCE_LABEL,
  buildActivityBlocks, buildActivityBlocksCall, sourceLabel
} from '../app/utils/activityBlocks'
import { buildActivityDescription } from '../app/utils/todoActivity'
import { counterpartyAccountOf } from '../app/utils/eraseActivities'
import { type PortalCurrencyFormats, applyFormatString, decodeEntities, formatAmountWithPortal } from '../app/utils/currencyFormat'

const ITEM: StatementItem = {
  account: 'BY00OURS',
  docId: 'op-1',
  docNum: '541',
  direction: 'credit',
  amount: 1840.5,
  currency: 'BYN',
  purpose: 'Оплата по счёту № 541 за услуги',
  counterparty: { name: 'ООО «Ромашка»', unp: '191234567', account: 'BY24PAYER', bank: 'Альфа-Банк' },
  acceptDate: '2026-09-10T00:00:00.000Z'
}

/** Подпись строки таблицы и её значение — блоки вложены на один уровень. */
function rows(blocks: ReturnType<typeof buildActivityBlocks>): [string, string][] {
  return blocks.map((b) => {
    const p = b.properties as Record<string, unknown>
    const inner = p.block as { properties: Record<string, unknown> }
    return [String(p.title), String(inner.properties.value)] as [string, string]
  })
}

describe('блоки карточки дела (#729)', () => {
  it('порядок полей — решение владельца, а не алфавит', () => {
    // Сверху то, по чему платёж узнают, ниже — по чему сверяют, в конце — откуда он взялся.
    expect(rows(buildActivityBlocks(ITEM, 'alfa-by')).map(([t]) => t))
      .toEqual(['Приход', 'Контрагент', 'УНП', 'Документ', 'Источник'])
  })

  it('расход назван расходом, а не приходом с минусом', () => {
    const [[title]] = rows(buildActivityBlocks({ ...ITEM, direction: 'debit' }, 'alfa-by'))
    expect(title).toBe('Расход')
  })

  it('НАЗНАЧЕНИЯ в блоках НЕТ — оно в комментарии', () => {
    // ⚠ Решение владельца: назначение читают абзацем, а не сверяют взглядом; в таблице реквизитов
    // оно ломало бы колонки. Вернуть его сюда «для полноты» — первое, что придёт в голову следующему.
    const all = JSON.stringify(buildActivityBlocks(ITEM, 'alfa-by'))
    expect(all).not.toContain(ITEM.purpose)
    expect(rows(buildActivityBlocks(ITEM, 'alfa-by')).map(([t]) => t)).not.toContain('Назначение')
  })

  it('СЧЁТ КОНТРАГЕНТА — в комментарии под назначением, а НЕ в таблице', () => {
    // Решение владельца 2026-09-16: счёт читается как основание платежа, следом за назначением.
    const description = buildActivityDescription(ITEM, undefined, 'slim')
    expect(description).toContain('[B]Счёт:[/B] BY24PAYER')
    expect(description.indexOf(ITEM.purpose)).toBeLessThan(description.indexOf('[B]Счёт:[/B]'))
    expect(rows(buildActivityBlocks(ITEM, 'alfa-by')).map(([t]) => t)).not.toContain('Счёт')
  })

  it('«Очистка» по счёту ПЛАТЕЛЬЩИКА снова находит его (#591)', () => {
    // ⚠ Несущий инвариант, а не украшение: фильтр стирания берёт счёт РАЗБОРОМ описания — в маркере
    // лежит НАШ счёт, а не плательщика. Пока счёт был только блоком, фильтр не находил НИ ОДНОГО
    // нового дела (блоки читаются лишь поштучным вызовом, пучком их не отобрать), то есть
    // необратимое действие молча стирало меньше, чем показывало. Унести счёт обратно в таблицу —
    // первое, что придёт в голову следующему, кто будет «наводить порядок» в карточке.
    const description = buildActivityDescription(ITEM, undefined, 'slim')
    expect(counterpartyAccountOf(description)).toBe('BY24PAYER')
  })

  it('счёт с пустым значением строки не рисует', () => {
    const bare = { ...ITEM, counterparty: { ...ITEM.counterparty, account: '' } }
    expect(buildActivityDescription(bare, undefined, 'slim')).not.toContain('Счёт')
  })

  it('комментарий в режиме slim — только причина и назначение', () => {
    const description = buildActivityDescription(ITEM, 'Клиент не определён', 'slim')
    expect(description).toContain('Клиент не определён')
    expect(description).toContain(ITEM.purpose)
    // Ни суммы, ни контрагента, ни УНП, ни документа — всё это показывает таблица блоков.
    // ⚠ Счёт в этом списке НЕ значится: он остаётся в тексте (см. соседний случай про #591).
    for (const gone of ['Контрагент', 'УНП', 'Документ', 'Приход']) {
      expect(description).not.toContain(gone)
    }
  })

  it('режим full не тронут — на нём держится запасной носитель', () => {
    // ⚠ Блоки на системное дело (#722) не ложатся, замерено. Урезать там описание значило бы
    // оставить старый портал с одним заголовком.
    const full = buildActivityDescription(ITEM, undefined, 'full')
    for (const kept of ['Приход', 'Контрагент', 'УНП', 'Счёт', 'Назначение']) {
      expect(full).toContain(kept)
    }
  })

  it('источник называет НАШ путь получения, а не банк плательщика', () => {
    expect(sourceLabel('alfa-by')).toBe(SOURCE_LABEL['alfa-by'])
    expect(sourceLabel('prior-by')).toContain('Приорбанк')
    expect(sourceLabel('manual')).toContain('Ручная')
    // Банк контрагента в источник не подставляется никогда — это разные вещи.
    expect(JSON.stringify(buildActivityBlocks(ITEM, 'manual'))).not.toContain('Альфа-Банк')
  })

  it('неизвестный провайдер описывается честно, а не первым из списка', () => {
    // Строка «Автозагрузка из Альфа-Банка» на операции из другого банка — ложь в карточке клиента.
    expect(sourceLabel(undefined)).toBe('Импорт выписки')
  })

  it('пустые поля плательщика не рисуются пустой строкой', () => {
    // У выписки Паритетбанка имени контрагента нет вовсе (#700) — «Контрагент: —» читалось бы как брак.
    const bare = { ...ITEM, counterparty: { name: '', unp: '', account: '' } }
    expect(rows(buildActivityBlocks(bare, 'manual')).map(([t]) => t)).toEqual(['Приход', 'Документ', 'Источник'])
  })

  it('поля плательщика нейтрализованы — ссылку в карточку не вписать', () => {
    const evil = { ...ITEM, counterparty: { ...ITEM.counterparty, name: '[url=http://evil]клик[/url]' } }
    expect(JSON.stringify(buildActivityBlocks(evil, 'alfa-by'))).not.toContain('[url=')
  })

  it('число блоков не превышает потолок портала', () => {
    expect(buildActivityBlocks(ITEM, 'alfa-by').length).toBeLessThanOrEqual(MAX_LAYOUT_BLOCKS)
  })

  it('вызов адресуется тройкой владелец+дело, иначе портал откажет', () => {
    const { method, params } = buildActivityBlocksCall('77', 4, 42, buildActivityBlocks(ITEM, 'alfa-by'))
    expect(method).toBe(ACTIVITY_BLOCKS_SET_METHOD)
    expect(params).toMatchObject({ entityTypeId: 4, entityId: 42, activityId: '77' })
  })
})

describe('сумма в формате ПОРТАЛА (#729)', () => {
  // Замерено на живом портале 2026-09-16 (`crm.currency.list`): подпись у BYN — «руб.», у RUB —
  // HTML-сущность, у USD символ стоит ПЕРЕД суммой.
  const PORTAL: PortalCurrencyFormats = {
    BYN: { formatString: '# руб.', decimals: 2 },
    RUB: { formatString: '# &#8381;', decimals: 2 },
    USD: { formatString: '$#', decimals: 2 },
    EUR: { formatString: '# &euro;', decimals: 2 }
  }

  it('BYN подписывается так, как её подписывает сам портал', () => {
    // ⚠ Ровно то, с чего всё началось: `Intl` печатал «1 840,50 BYN» рядом с «29,00 ₽», потому что
    // про белорусскую подпись «руб.» его справочник CLDR не знает.
    // ⚠ Разряды разделяет НЕРАЗРЫВНЫЙ пробел (U+00A0) — так отдаёт ru-RU, и это правильно:
    // обычный пробел позволил бы перенести «840,50 руб.» на следующую строку, оторвав от «1».
    expect(formatAmountWithPortal(1840.5, 'BYN', PORTAL)).toBe('1\u00A0840,50 руб.')
  })

  it('HTML-сущность раскрывается в символ', () => {
    expect(formatAmountWithPortal(29, 'RUB', PORTAL)).toBe('29,00 ₽')
    expect(formatAmountWithPortal(29, 'EUR', PORTAL)).toBe('29,00 €')
  })

  it('символ ПЕРЕД суммой, если так велит шаблон портала', () => {
    // «число, пробел, символ» верно не всегда — у доллара знак стоит слева.
    expect(formatAmountWithPortal(1840.5, 'USD', PORTAL)).toBe('$1\u00A0840,50')
  })

  it('решётка внутри сущности не принимается за плейсхолдер', () => {
    // ⚠ `&#36;` СОДЕРЖИТ `#`, и когда сущность стоит ПЕРЕД числом, наивный `replace` подставляет
    // число внутрь кода символа: замерено, `'&#36;#'.replace('#', '29,00')` → «&29,0036;#».
    // ⚠ Шаблон ИМЕННО такой, с сущностью впереди: первая редакция теста брала «# &#8381;», где
    // плейсхолдер и так первый, — мутация «убрать экранирование» её ПЕРЕЖИЛА, то есть гард
    // проверялся фиктивно.
    expect(applyFormatString('&#36;#', '29,00')).toBe('$29,00')
    expect(applyFormatString('# &#8381;', '29,00')).toBe('29,00 ₽')
    expect(decodeEntities('&#x20BD;')).toBe('₽')
  })

  it('группировка разрядов НАША, а не портальная', () => {
    // ⚠ Портал отдаёт THOUSANDS_SEP null и DEC_POINT «.», то есть по его настройкам вышло бы
    // «1840.50 руб.» — ровно то «нет форматирования», ради которого всё и переписано.
    expect(formatAmountWithPortal(1840.5, 'BYN', PORTAL)).toContain(',50')
    expect(formatAmountWithPortal(1840.5, 'BYN', PORTAL)).not.toContain('1840')
  })

  it('неизвестная валюта НЕ роняет запись — показываем кодом', () => {
    // ⚠ Ровно за падение отвергнут `CurrencyManager.format` из jssdk: он бросает на валюту, которой
    // на портале нет, а валюту мы берём из ВЫПИСКИ — рублёвый платёж уронил бы дело целиком.
    expect(() => formatAmountWithPortal(10, 'XYZ', PORTAL)).not.toThrow()
    expect(formatAmountWithPortal(10, 'XYZ', PORTAL)).toContain('XYZ')
  })

  it('недоступный справочник портала — запасной вид, а не отказ', () => {
    expect(formatAmountWithPortal(1840.5, 'BYN', {})).toContain('BYN')
    expect(formatAmountWithPortal(1840.5, 'BYN', undefined)).toContain('BYN')
  })

  it('пустая валюта и нефинитная сумма не печатают мусор в карточку', () => {
    expect(formatAmountWithPortal(10, '', PORTAL)).toBe('10,00')
    expect(formatAmountWithPortal(Number.NaN, 'BYN', PORTAL)).not.toContain('NaN')
  })

  it('шаблон без плейсхолдера не теряет СУММУ', () => {
    expect(applyFormatString('руб.', '1\u00A0840,50')).toContain('1\u00A0840,50')
  })
})
