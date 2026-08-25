import { describe, expect, it } from 'vitest'
import {
  MATRIX_ROW_ACTIONABLE, MATRIX_STATE_LABEL, bankSideIncomplete, buildAccountMatrix, matrixIsClean,
  matrixProblems, matrixStateLabel, normalizeForCompare, uncheckedNumbers, type MatrixRowState
} from '../app/utils/bankAccountMatrix'
import { normalizeAccount } from '../server/utils/companyLookup'

// Матрица существует, потому что номер счёта сейчас НАБИРАЮТ руками, а обе стороны программе
// известны: наша — в реквизитах компаний «моя», банковская — её отдаёт сам банк. Ошибка в одном
// символе при этом не даёт никакой ошибки: опрос идёт, операции приходят, компания не находится,
// платежи не приземляются. Ровно так выглядел первый боевой прогон (#494).

const crm = (number: string, companyId = '7') => ({ companyId, number })
const bank = (number: string) => ({ number })

describe('buildAccountMatrix', () => {
  it('побайтово совпало — «сопоставлено»', () => {
    const [row] = buildAccountMatrix({ crm: [crm('BY00BANK0001')], bank: [bank('BY00BANK0001')], connectedKeys: [], bankIncomplete: false })
    expect(row!.state).toBe('matched')
  })

  it('⚠ «похоже, но иначе» — ОТДЕЛЬНОЕ состояние, а не совпадение', () => {
    // Поиск в CRM сравнивает номер посимвольно. Свернув это в «сопоставлено», экран стал бы
    // зелёным при неработающем импорте — хуже, чем отсутствие экрана: неотвеченный вопрос
    // превращается в НЕВЕРНЫЙ ответ.
    const [row] = buildAccountMatrix({ crm: [crm('BY00 BANK 0001')], bank: [bank('BY00BANK0001')], connectedKeys: [], bankIncomplete: false })
    expect(row!.state).toBe('looks-same')
    expect(MATRIX_STATE_LABEL['looks-same'].hint).toContain('посимвольно')
  })

  it('регистр тоже ловится как «иначе», а не как совпадение', () => {
    const [row] = buildAccountMatrix({ crm: [crm('by00bank0001')], bank: [bank('BY00BANK0001')], connectedKeys: [], bankIncomplete: false })
    expect(row!.state).toBe('looks-same')
  })

  it('банк отдаёт, в реквизитах нет — самая дорогая строка', () => {
    // Операции по такому счёту приедут и не найдут компанию, то есть не приземлятся никуда.
    const [row] = buildAccountMatrix({ crm: [], bank: [bank('BY00BANK0002')], connectedKeys: [], bankIncomplete: false })
    expect(row!.state).toBe('bank-only')
    expect(MATRIX_STATE_LABEL['bank-only'].hint).toContain('не приземлятся')
  })

  it('в реквизитах есть, банк не отдаёт — не подключён либо другой банк', () => {
    const [row] = buildAccountMatrix({ crm: [crm('BY00BANK0003')], bank: [], connectedKeys: [], bankIncomplete: false })
    expect(row!.state).toBe('crm-only')
  })

  it('проблемы идут ПЕРВЫМИ — экран, начинающийся с «всё хорошо», хоронит нужную строку', () => {
    const rows = buildAccountMatrix({
      crm: [crm('BY00BANK0001'), crm('BY00 BANK 0004'), crm('BY00BANK0003')],
      bank: [bank('BY00BANK0001'), bank('BY00BANK0004'), bank('BY00BANK0002')],
      connectedKeys: [],
      bankIncomplete: false
    })
    expect(rows.map(r => r.state)).toEqual(['bank-only', 'looks-same', 'crm-only', 'matched'])
  })

  it('непроверенные стоят между проблемами и рабочими строками', () => {
    // Сначала то, что чинят, потом то, за что не ручаемся, и только затем рабочее.
    const rows = buildAccountMatrix({
      crm: [crm('BY00BANK0001'), crm('BY00BANK0009')],
      bank: [bank('BY00BANK0001'), bank('BY00BANK0002')],
      connectedKeys: [],
      bankIncomplete: true
    })
    expect(rows.map(r => r.state)).toEqual(['bank-only', 'unchecked', 'matched'])
  })

  it('признак подключения ставится по НОРМАЛИЗОВАННОМУ ключу', () => {
    // В `bank_tokens` номер лежит так, как его когда-то ввели; сверять посимвольно тут значило бы
    // показывать «не подключён» на работающем подключении.
    const [row] = buildAccountMatrix({
      crm: [crm('BY00BANK0001')], bank: [bank('BY00BANK0001')], connectedKeys: ['by00bank0001'], bankIncomplete: false
    })
    expect(row!.connected).toBe(true)
  })

  it('один и тот же банковский счёт не дублируется строкой bank-only', () => {
    const rows = buildAccountMatrix({ crm: [crm('BY00 BANK 0001')], bank: [bank('BY00BANK0001')], connectedKeys: [], bankIncomplete: false })
    expect(rows).toHaveLength(1)
  })

  it('matrixIsClean честен: одна проблемная строка — уже не чисто', () => {
    expect(matrixIsClean(buildAccountMatrix({ crm: [crm('A')], bank: [bank('A')], connectedKeys: [], bankIncomplete: false }))).toBe(true)
    expect(matrixIsClean(buildAccountMatrix({ crm: [], bank: [bank('A')], connectedKeys: [], bankIncomplete: false }))).toBe(false)
  })
})

describe('правило сравнения не должно разъехаться с серверным', () => {
  it('⚠ нормализация совпадает с той, что применяет поиск по выписке', () => {
    // `normalizeForCompare` продублирован в app-слое намеренно (модуль рендерится в браузере и не
    // может импортировать server/). Дубль без сторожа однажды разойдётся — и матрица начнёт
    // показывать «сопоставлено» там, где поиск не находит.
    for (const v of ['BY00 BANK 0001', ' BY00BANK0001 ', 'BY00\tBANK\n0001']) {
      expect(normalizeForCompare(v)).toBe(normalizeAccount(v).toUpperCase())
    }
  })
})

describe('пробел по краям реквизита — тоже ловушка (#494, ревью)', () => {
  it('реквизит с ведущим пробелом — «записан иначе», а НЕ «сопоставлено»', () => {
    // Ровно тот же класс ошибки, что внутренние пробелы: в CRM пробел сохраняется, а поиск
    // сравнивает посимвольно. Причесать края перед сравнением значило бы покрасить строку зелёным
    // на портале, где импорт не работает, — ложный ответ вместо неотвеченного вопроса.
    const rows = buildAccountMatrix({
      crm: [{ companyId: '7', number: ' BY00BANK0001' }],
      bank: [{ number: 'BY00BANK0001' }],
      connectedKeys: [],
      bankIncomplete: false
    })
    expect(rows[0]?.state).toBe('looks-same')
  })

  it('хвостовой пробел — так же', () => {
    const rows = buildAccountMatrix({
      crm: [{ companyId: '7', number: 'BY00BANK0001 ' }],
      bank: [{ number: 'BY00BANK0001' }],
      connectedKeys: [],
      bankIncomplete: false
    })
    expect(rows[0]?.state).toBe('looks-same')
  })

  it('банк отдал номер с краевым пробелом — это транспортный шум, строку он не ломает', () => {
    // Сторона банка обрезается по краям при извлечении (`extractAlfaAccounts`): у банка это
    // форматирование ответа, а не то, что лежит у кого-то в реквизитах.
    const rows = buildAccountMatrix({
      crm: [{ companyId: '7', number: 'BY00BANK0001' }],
      bank: [{ number: 'BY00BANK0001' }],
      connectedKeys: [],
      bankIncomplete: false
    })
    expect(rows[0]?.state).toBe('matched')
  })
})

describe('банк не ответил — «не знаем» вместо «банк его не отдаёт» (хвост #539)', () => {
  // ⚠ Пока держится лок продления токена, `listBankSideAccounts` отдаёт по провайдеру `error` и
  // ПУСТОЙ список счетов. Матрица про error не знала, поэтому КАЖДЫЙ счёт «моей компании» падал в
  // `crm-only` — «банк его не отдаёт», с инструкцией подключить банк, — при том что алерт прямо
  // над строками говорил противоположное: «список счетов этого банка сейчас неизвестен».
  // Исправному порталу предлагалось чинить целое, в экране, который заведён ровно от этого.

  it('счёт из CRM без ответа банка — «проверить не удалось», а не «банк его не отдаёт»', () => {
    const [row] = buildAccountMatrix({
      crm: [crm('BY00BANK0003')], bank: [], connectedKeys: [], bankIncomplete: true
    })
    expect(row!.state).toBe('unchecked')
  })

  it('тот же вход при отвечающем банке остаётся `crm-only` — состояние не подменяет прежнее', () => {
    // Мутационная страховка: сделай классификацию безусловной — и `crm-only` исчезнет вовсе,
    // то есть настоящий «банк о нём не знает» перестанет быть виден.
    const [row] = buildAccountMatrix({
      crm: [crm('BY00BANK0003')], bank: [], connectedKeys: [], bankIncomplete: false
    })
    expect(row!.state).toBe('crm-only')
  })

  it('⚠ положительное знание молчащий банк НЕ портит', () => {
    // `bank-only`, `matched` и `looks-same` держатся на том, что банк счёт НАЗВАЛ. Один банк молчит,
    // второй ответил — его строки остаются утверждениями, а не догадками.
    const rows = buildAccountMatrix({
      crm: [crm('BY00BANK0001'), crm('BY00 BANK 0004')],
      bank: [bank('BY00BANK0001'), bank('BY00BANK0004'), bank('BY00BANK0002')],
      connectedKeys: [],
      bankIncomplete: true
    })
    const byState = new Map(rows.map(r => [r.state, r]))
    expect(byState.get('matched')?.crm?.number).toBe('BY00BANK0001')
    expect(byState.get('looks-same')?.crm?.number).toBe('BY00 BANK 0004')
    expect(byState.get('bank-only')?.bank?.number).toBe('BY00BANK0002')
    expect(byState.has('unchecked')).toBe(false)
  })

  it('«проверить не удалось» — НЕ повод что-то чинить', () => {
    // Строка без инструкции не должна попасть в список проблем: иначе админ идёт править реквизит,
    // с которым всё в порядке.
    const rows = buildAccountMatrix({
      crm: [crm('BY00BANK0003')], bank: [], connectedKeys: [], bankIncomplete: true
    })
    expect(matrixProblems(rows)).toEqual([])
    expect(MATRIX_ROW_ACTIONABLE['unchecked']).toBe(false)
  })

  it('⚠ но и «всё сходится» о ней сказать нельзя', () => {
    // Ручаться за строку, которую никто не проверял, — та же ошибка, только с другого конца:
    // блок схлопнулся бы в зелёную надпись рядом с алертом «банк не ответил».
    const rows = buildAccountMatrix({
      crm: [crm('BY00BANK0003')], bank: [], connectedKeys: [], bankIncomplete: true
    })
    expect(matrixIsClean(rows)).toBe(false)
  })

  it('подпись говорит про НЕЗНАНИЕ и не отправляет подключать банк', () => {
    const label = MATRIX_STATE_LABEL['unchecked']
    expect(label.title).not.toContain('не отдаёт')
    expect(label.hint).toContain('сверить их сейчас не с чем')
    expect(label.hint).toContain('повторите сверку')
    // ⚠ Ровно та инструкция, которая и была вредной: чинить нечего, банк просто молчит.
    expect(label.hint).not.toContain('подключите')
  })

  it('actionable-таблица покрывает ВСЕ состояния — новое не проскочит молча', () => {
    // Компилятор требует полноты `Record`, но `as` рядом с новым состоянием её обойдёт. Здесь
    // проверяется, что каждое состояние из настоящих строк имеет решение.
    const states: MatrixRowState[] = ['matched', 'looks-same', 'crm-only', 'bank-only', 'unchecked']
    for (const s of states) expect(typeof MATRIX_ROW_ACTIONABLE[s]).toBe('boolean')
    expect(Object.keys(MATRIX_ROW_ACTIONABLE).sort()).toEqual([...states].sort())
  })

  it('⚠ и ЗНАЧЕНИЯ таблицы закреплены поимённо, а не только тип', () => {
    // Находка ревью: проверка `typeof … === 'boolean'` — тавтология, её проходит и НЕВЕРНОЕ
    // значение. Замерено рассуждением: `'crm-only': false` (например при мерже комментарий
    // «чинить нечего» переехал строкой выше) молча выключил бы показ самого частого содержательного
    // состояния экрана — «счёт есть в реквизитах, банк его не назвал», — и ни один тест не упал бы.
    expect(MATRIX_ROW_ACTIONABLE).toEqual({
      'bank-only': true,
      'looks-same': true,
      'crm-only': true,
      'unchecked': false,
      'matched': false
    })
  })

  it('подпись неизвестного состояния не роняет рендер (скос выката)', () => {
    // Статика и backend выкатываются разными образами: несколько минут один может быть новее
    // другого, и прямая индексация дала бы `undefined.title` — ПУСТОЙ экран настроек вместо одной
    // незнакомой строки.
    expect(matrixStateLabel('unchecked').title).toBe(MATRIX_STATE_LABEL['unchecked'].title)
    expect(matrixStateLabel('who-knows' as MatrixRowState).title).toBeTruthy()
    expect(matrixStateLabel('who-knows' as MatrixRowState).hint).toBe('')
  })
})

describe('предикат «сторона банка неполна» — ОДИН на сервер и интерфейс', () => {
  it('ошибка хотя бы у одного провайдера', () => {
    expect(bankSideIncomplete([{ error: null }, { error: 'банк не ответил' }])).toBe(true)
  })

  it('ответили все — полна', () => {
    expect(bankSideIncomplete([{ error: null }, {}])).toBe(false)
  })

  it('пустая строка ошибки — НЕ отказ', () => {
    // Иначе неаккуратный транспорт затуманил бы каждую строку на исправном портале.
    expect(bankSideIncomplete([{ error: '' }])).toBe(false)
  })

  it('провайдеров нет вовсе — спрашивать было некого', () => {
    expect(bankSideIncomplete([])).toBe(false)
  })
})

describe('⚠ непроверенный счёт НЕ должен исчезнуть с экрана (находка ревью)', () => {
  // Отказ банка бывает ПОСТОЯННЫМ — мёртвый грант, «банк не настроен на этом сервере», — и тогда
  // `bankIncomplete` истинно НА КАЖДОМ прогоне. Первая редакция сворачивала такие строки в голое
  // число, то есть счёт пропадал с экрана НАВСЕГДА: ровно так спрятался бы реквизит с опечаткой,
  // ради которого экран и написан. Тот же дефект, вывернутый наизнанку.

  const rows = () => buildAccountMatrix({
    crm: [crm('BY00BANK0003'), crm('BY00BANK0005')],
    bank: [],
    connectedKeys: [],
    bankIncomplete: true
  })

  it('номера непроверенных счетов доступны для показа', () => {
    expect(uncheckedNumbers(rows()).shown).toEqual(['BY00BANK0003', 'BY00BANK0005'])
    expect(uncheckedNumbers(rows()).more).toBe(0)
  })

  it('длинный список капится, но остаток НАЗЫВАЕТСЯ числом, а не отбрасывается', () => {
    const many = buildAccountMatrix({
      crm: ['A1', 'A2', 'A3', 'A4', 'A5'].map(n => crm(n)),
      bank: [],
      connectedKeys: [],
      bankIncomplete: true
    })
    const got = uncheckedNumbers(many, 2)
    expect(got.shown).toEqual(['A1', 'A2'])
    expect(got.more).toBe(3)
  })

  it('строки других состояний в список номеров не подмешиваются', () => {
    const mixed = buildAccountMatrix({
      crm: [crm('BY00BANK0001'), crm('BY00BANK0003')],
      bank: [bank('BY00BANK0001'), bank('BY00BANK0002')],
      connectedKeys: [],
      bankIncomplete: true
    })
    expect(uncheckedNumbers(mixed).shown).toEqual(['BY00BANK0003'])
  })

  it('⚠ подпись НЕ обещает, что дело не в реквизитах', () => {
    // Прежний текст говорил «Это НЕ проблема реквизита» и «повторите через несколько секунд» —
    // оба утверждения ложны при постоянном отказе банка: реквизит с опечаткой выглядит так же.
    const hint = MATRIX_STATE_LABEL['unchecked'].hint
    expect(hint).not.toContain('не проблема')
    expect(hint).not.toContain('через несколько секунд')
    expect(hint, 'должна отправлять к предупреждению, если повторяется').toContain('повторяется')
    expect(hint).toContain('непроверенными')
  })
})
