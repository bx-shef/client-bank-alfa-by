import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isParitetText,
  parseParitetText,
  paritetDirection,
  paritetDocId,
  normalizeParitet,
  normalizeParitetRows
} from '../app/utils/paritetStatement'
import { detectStatementEncoding } from '../app/utils/statementEncoding'
import { decodeUploadText } from '../app/utils/importUpload'
import { detectManualFormat, normalizeManualStatement } from '../app/utils/manualImport'
import { buildActivityTitle } from '../app/utils/activity'

// Звёздочный формат выписки (Паритетбанк, #700). Фикстуры — РЕАЛЬНЫЕ выгрузки банка, у которых
// обезличены счета, УНП, название компании и номера договоров; структура, кодировка CP866, суммы,
// даты, повторы номеров документов и строки переоценки оставлены как есть — на них и держится
// всё, что здесь проверяется.
// ⚠ Обезличивание обязательно: репозиторий ПУБЛИЧНЫЙ, а выписка — финансовые ПДн клиента.

const DIR = join(import.meta.dirname, 'fixtures', 'paritet')
const FILES = [
  'deposit-rub.txt', 'settlement-rub.txt', 'settlement-byn.txt',
  'deposit-byn.txt', 'deposit-byn-2.txt'
] as const

function bytes(name: string): Buffer {
  return readFileSync(join(DIR, name))
}
function text(name: string): string {
  return decodeUploadText(bytes(name))
}

// ⚠ ГАРД ПРИВАТНОСТИ, и он написан по СЛУЧИВШЕМУСЯ промаху: обезличивание было заявлено, а
// название организации заменено «по памяти» — и настоящее осталось во всех пяти файлах, 72
// вхождения. Поймалось не проверкой, а тем, что выписку прогнали через браузер и прочитали
// глазами. Отсюда форма: гард ПЕРЕЧИСЛЯЕТ содержимое фикстур и требует, чтобы в нём не было
// ничего, кроме ожидаемого, — а НЕ ищет заранее известные строки. Искать то, что помнишь, и есть
// ровно тот способ, которым промахнулись.
describe('приватность фикстур', () => {
  const all = FILES.map(f => text(f)).join('\n')

  // Название организации в выписке — CamelCase («ТехноСервис», «БелАгроТорг»): строчные буквы
  // МЕЖДУ заглавными. Обычные слова назначения так не выглядят — ни «ВКЛАД», ни «депозитному».
  // ⚠ Настоящего названия клиента тут нет и быть не может — оно и есть то, что мы прячем.
  // ⚠ Без `\b`: в JS граница слова определена по ASCII, и перед кириллической буквой её нет —
  // маска с ней не находила НИЧЕГО, то есть гард проходил бы зелёным на утёкшем названии.
  it('не осталось названий организаций', () => {
    const proper = [...new Set(all.match(/[А-ЯЁ][а-яё]+[А-ЯЁ][А-Яа-яЁё]*/g) ?? [])]
    expect(proper).toEqual(['ДемоКлиент'])
  })

  it('счета и УНП — из демо-диапазона', () => {
    const accounts = [...new Set(all.match(/BY\d{2}[A-Z]{4}\d{20}/g) ?? [])]
    expect(accounts.length).toBeGreaterThan(0)
    for (const a of accounts) expect(a, a).toMatch(/0{9}/)
    const unps = [...new Set(all.match(/\*(\d{9})\*/g) ?? [])].map(x => x.slice(1, -1))
    expect(unps.length).toBeGreaterThan(0)
    for (const u of unps) expect(u, u).toMatch(/^\d9\d{7}$/)
  })

  it('номера договоров обезличены', () => {
    const contracts = [...new Set(all.match(/O\d{5}-\d{8}/g) ?? [])]
    expect(contracts).toEqual(['O00000-01012026'])
  })
})

describe('кодировка', () => {
  // ⚠ Главная опасность формата: прочитанный как windows-1251, он разбирается СТРУКТУРНО ВЕРНО
  // (звёздочки, цифры и номера счетов — ASCII), и ломается только кириллица. То есть ошибка даёт
  // не отказ, а мусор в назначении платежа, уехавший в CRM клиента.
  it('все фикстуры опознаются как CP866', () => {
    for (const f of FILES) expect(detectStatementEncoding(bytes(f))).toBe('cp866')
  })

  it('наши прежние фикстуры остаются windows-1251', () => {
    const old = join(import.meta.dirname, 'fixtures', 'client-bank', 'demo-prior-byn.txt')
    expect(detectStatementEncoding(readFileSync(old))).toBe('windows-1251')
    const oneC = join(import.meta.dirname, 'fixtures', '1c-exchange', 'demo-1c.txt')
    expect(detectStatementEncoding(readFileSync(oneC))).toBe('windows-1251')
  })

  // ⚠ UTF-8 — самый вероятный «чужой» файл: «Блокнот» Windows сохраняет в него по умолчанию.
  // Статистикой он НЕ различается (ведущий байт в одном диапазоне, продолжение в другом —
  // счётчики почти равны), поэтому проверяется структурно.
  it('UTF-8 опознаётся — и с BOM, и без', () => {
    const utf8 = new TextEncoder().encode('*1*260601*BY10*933*Оплата по счёту СЧ-1001*')
    expect(detectStatementEncoding(utf8)).toBe('utf-8')
    const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8])
    expect(detectStatementEncoding(withBom)).toBe('utf-8')
  })

  it('наши фикстуры, пересохранённые в UTF-8, опознаются как UTF-8 и читаются верно', () => {
    for (const f of FILES) {
      const asUtf8 = new TextEncoder().encode(text(f))
      expect(detectStatementEncoding(asUtf8), f).toBe('utf-8')
      expect(decodeUploadText(asUtf8), f).toBe(text(f))
    }
  })

  // ⚠ Однобайтовые кириллические кодировки НЕ должны попадать в UTF-8: там старшие байты идут
  // подряд и структуре UTF-8 не удовлетворяют.
  it('CP866 и CP1251 не принимаются за UTF-8', () => {
    for (const f of FILES) expect(detectStatementEncoding(bytes(f)), f).toBe('cp866')
    const cb = readFileSync(join(import.meta.dirname, 'fixtures', 'client-bank', 'demo-prior-byn.txt'))
    expect(detectStatementEncoding(cb)).toBe('windows-1251')
  })

  it('чистый ASCII читается как windows-1251 — для ASCII кодировки совпадают', () => {
    expect(detectStatementEncoding(new TextEncoder().encode('*0*260519*BY10*933*1*0,00*0,00*')))
      .toBe('windows-1251')
  })

  // Доказываем, что различение не косметическое: неверная кодировка портит именно текст.
  it('декод верной кодировкой даёт читаемую кириллицу, неверной — нет', () => {
    const right = text('settlement-byn.txt')
    expect(right).toContain('Комиссионное вознаграждение')
    const wrong = new TextDecoder('windows-1251').decode(bytes('settlement-byn.txt'))
    expect(wrong).not.toContain('Комиссионное вознаграждение')
  })
})

describe('определение формата', () => {
  it('звёздочный формат опознаётся', () => {
    for (const f of FILES) expect(detectManualFormat(text(f))).toBe('paritet-text')
  })

  /**
   * ⚠ ПОРЯДОК проверок в `detectManualFormat` проверяется СТРУКТУРНО, и это написано по промаху:
   * комментарии в двух местах утверждали «порядок закреплён тестом», а перестановка звёздочной
   * проверки вперёд проходила зелёной — поведенческие тесты её не видят, потому что маркеры и так
   * не пересекаются. Обещание защиты, которой нет, опаснее её отсутствия: на него ссылаются,
   * объясняя, почему проверка не нужна где-то ещё.
   */
  it('звёздочная проверка стоит ПОСЛЕ 1С и client-bank', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'app', 'utils', 'manualImport.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function detectManualFormat'))
    const order = ['isOneCExchange(', 'CLIENT_BANK_MARKER', 'isParitetText(']
      .map(m => body.indexOf(m))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  // ⚠ Маркер client-bank САМ начинается со звёздочек — поэтому порядок и несущий.
  it('не перехватывает client-bank и 1С', () => {
    const cb = readFileSync(join(import.meta.dirname, 'fixtures', 'client-bank', 'demo-prior-byn.txt'))
    expect(detectManualFormat(decodeUploadText(cb))).toBe('client-bank-text')
    const oneC = readFileSync(join(import.meta.dirname, 'fixtures', '1c-exchange', 'demo-1c.txt'))
    expect(detectManualFormat(decodeUploadText(oneC))).toBe('1c-exchange')
    expect(isParitetText('***** ^Type=4')).toBe(false)
  })

  it('чужой текст не опознаётся', () => {
    expect(detectManualFormat('какой-то текст')).toBe('unknown')
    expect(isParitetText('')).toBe(false)
    expect(isParitetText('*9*что-то*')).toBe(false)
  })
})

describe('направление', () => {
  // ⚠ Карта выведена СВЕДЕНИЕМ САЛЬДО, а не из документации: «входящее + Σ(4) − Σ(1)» сходится с
  // исходящим сальдо, обратная гипотеза расходится на миллионы. Тест ниже это и воспроизводит.
  it('4 — приход, 1 — расход, прочее — не гадаем', () => {
    expect(paritetDirection('4')).toBe('credit')
    expect(paritetDirection('1')).toBe('debit')
    expect(paritetDirection('7')).toBeNull()
    expect(paritetDirection('')).toBeNull()
  })

  it.each(['settlement-rub.txt', 'settlement-byn.txt', 'deposit-rub.txt'])(
    'сальдо сходится с нашей картой направлений (%s)',
    (name) => {
      const raw = text(name).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const num = (s: string) => Number(s.replace(',', '.'))
      const head = raw[0]!.split('*')
      const foot = raw.find(l => l.startsWith('*2*'))!.split('*')
      const opening = num(head[6]!)
      const closing = num(foot[6]!)

      const parsed = parseParitetText(text(name))
      let credits = 0
      let debits = 0
      for (const r of parsed.rows) {
        const a = num(r.amount)
        if (paritetDirection(r.directionCode) === 'credit') credits += a
        else debits += a
      }
      expect(opening + credits - debits).toBeCloseTo(closing, 2)
      // ⚠ И обратная гипотеза обязана НЕ сходиться — иначе файл ничего не доказывает (два файла из
      // пяти симметрично-нулевые, и на них «сходится» и то, и другое).
      expect(opening + debits - credits).not.toBeCloseTo(closing, 2)
    }
  )
})

describe('разбор', () => {
  it('читает шапку и все строки операций', () => {
    const p = parseParitetText(text('settlement-byn.txt'))
    expect(p.account).toBe('BY16POIS34120000000000006001')
    expect(p.currencyCode).toBe('933')
    expect(p.rows).toHaveLength(2)
    const r = p.rows[0]!
    expect(r).toMatchObject({
      date: '2026-08-04',
      account: 'BY16POIS34120000000000006001',
      currencyCode: '933',
      bic: 'POISBY2X',
      counterpartyAccount: 'BY13POIS30120000000000003000',
      docNum: '4504691',
      unp: '190000000',
      directionCode: '1',
      amount: '18,28'
    })
    expect(r.purpose).toContain('Комиссионное вознаграждение')
  })

  // ⚠ Подвал `*3*N*` — единственная бесплатная проверка целостности: обрезанная выгрузка остаётся
  // синтаксически корректной, и без сверки приложение импортировало бы ЧАСТЬ выписки молча.
  it('число строк сверяется с подвалом', () => {
    const t = text('settlement-byn.txt')
    expect(parseParitetText(t).rows).toHaveLength(2)
    const truncated = t.split(/\r?\n/).filter(l => !l.startsWith('*1*260716')).join('\n')
    expect(() => parseParitetText(truncated)).toThrow(/неполная/i)
  })

  it('чужой файл отвергается', () => {
    expect(() => parseParitetText('какой-то текст')).toThrow()
    expect(() => parseParitetText('')).toThrow()
  })

  // ⚠ Подвал ОБЯЗАТЕЛЕН. Сверка «если он есть» защищала не от того случая, который названа
  // защищать: при обрыве закачки теряется ХВОСТ файла, то есть сам подвал, и гард выключался бы
  // ровно тогда, когда нужен.
  it('файл без завершающей строки отвергается — обрыв закачки уносит именно её', () => {
    const t = text('settlement-byn.txt')
    const noFooter = t.split(/\r?\n/).filter(l => !l.startsWith('*3*')).join('\n')
    expect(() => parseParitetText(noFooter)).toThrow(/завершающей строки/i)
  })

  it('нечисловой счётчик в подвале не выключает проверку молча', () => {
    const t = text('settlement-byn.txt')
    expect(() => parseParitetText(t.replace(/\*3\*\d+\*/, '*3*abc*'))).toThrow()
    expect(() => parseParitetText(t.replace(/\*3\*\d+\*/, '*3**'))).toThrow()
  })
})

describe('ключ дедупа', () => {
  // ⚠ ЗАМЕРЕНО: голый номер документа повторяется 44 раза на 251 операции — банк нумерует свои
  // комиссии сквозным счётчиком, который повторяется в разные дни. Ключ приложения —
  // `<счёт>|<docId>`, поэтому голый номер молча схлопнул бы 44 операции из 251.
  it('дата в ключе обязательна — голый номер документа не уникален', () => {
    const perFile = FILES.map(f => parseParitetText(text(f)).rows)
    const bare = new Set<string>()
    const withDate = new Set<string>()
    let rows = 0
    for (const list of perFile) {
      for (const r of list) {
        rows += 1
        bare.add(`${r.account}|${r.docNum}`)
        withDate.add(`${r.account}|${paritetDocId(r)}`)
      }
    }
    expect(rows).toBe(251)
    expect(bare.size).toBeLessThan(rows) // голый номер теряет строки
    expect(rows - bare.size).toBe(44) // ровно столько молча схлопнулось бы
    expect(withDate.size).toBe(rows) // с датой — ни одной потери
  })

  it('docId несёт дату и номер', () => {
    const r = parseParitetText(text('settlement-byn.txt')).rows[0]!
    expect(paritetDocId(r)).toBe('2026-08-04|4504691')
  })
})

describe('нормализация', () => {
  it('разворачивает операцию во все поля StatementItem', () => {
    const items = normalizeManualStatement(text('settlement-byn.txt'), { account: '' })
    expect(items).toHaveLength(2)
    const it0 = items[0]!
    expect(it0).toMatchObject({
      account: 'BY16POIS34120000000000006001',
      docId: '2026-08-04|4504691',
      docNum: '4504691',
      direction: 'debit',
      amount: 18.28,
      currency: 'BYN',
      acceptDate: '2026-08-04'
    })
    expect(it0.counterparty).toMatchObject({
      unp: '190000000',
      account: 'BY13POIS30120000000000003000',
      bic: 'POISBY2X'
    })
    // ⚠ Имени контрагента в формате НЕТ — оставляем пустым, а не подставляем счёт/УНП: в карточке
    // компании номер читался бы как её название, то есть догадка выдавалась бы за факт.
    expect(it0.counterparty.name).toBe('')
  })

  it('валютный счёт даёт свою валюту, а не BYN', () => {
    const items = normalizeManualStatement(text('settlement-rub.txt'), { account: '' })
    expect(items.every(i => i.currency === 'RUB')).toBe(true)
  })

  // ⚠ Сумма берётся В ВАЛЮТЕ СЧЁТА (поле 17), а не BYN-эквивалент (поле 19): эквивалент банк
  // считает по своему курсу на свою дату, и в CRM он спорил бы с суммой выставленного счёта.
  it('сумма — в валюте счёта, а не рублёвый эквивалент', () => {
    const parsed = parseParitetText(text('settlement-rub.txt'))
    const row = parsed.rows.find(r => r.amount !== r.amountByn && Number(r.amount.replace(',', '.')) > 0)!
    const items = normalizeParitet(parsed, { account: '' })
    const mapped = items.find(i => i.docId === paritetDocId(row))!
    expect(mapped.amount).toBeCloseTo(Number(row.amount.replace(',', '.')), 2)
    expect(mapped.amount).not.toBeCloseTo(Number(row.amountByn.replace(',', '.')), 2)
  })

  // ⚠ Переоценка валютного остатка — не платёж: денег по счёту не двигалось, направления у такой
  // записи нет по смыслу, к счёту/сделке её не привязать (разнесение сверяет СУММУ). В CRM это
  // были бы десятки дел, которые бухгалтеру нужно закрывать руками.
  it('строки переоценки (нулевая сумма по счёту) не становятся операциями, но считаются', () => {
    let items = 0
    let nonPayment = 0
    let unreadable = 0
    for (const f of FILES) {
      const r = normalizeParitetRows(parseParitetText(text(f)), { account: '' })
      items += r.items.length
      nonPayment += r.nonPayment
      unreadable += r.unreadable
    }
    expect(items + nonPayment + unreadable).toBe(251) // ни одна строка не потерялась бесследно
    expect(nonPayment).toBe(65)
    expect(unreadable).toBe(0) // боевые файлы читаются полностью
    expect(items).toBe(186)
  })

  /**
   * ⚠ Числа выше ХАРАКТЕРИЗУЮТ корпус, но НЕ доказывают, по какому признаку строка отсеяна.
   * Замерено: подмена проверки «сумма равна нулю» на «в назначении есть слово Переоценка» держала
   * те же 65 и проходила зелёной — то есть тест пропускал переход к ТЕКСТОВОЙ ЭВРИСТИКЕ по
   * назначению платежа, которую дом репозитория запрещает прямо (назначение пишет плательщик).
   * Поэтому признак проверяется отдельно: отсеяны ровно нулевые по сумме, и все они — переоценка.
   */
  it('отсев идёт по НУЛЕВОЙ СУММЕ, а не по тексту назначения', () => {
    let zero = 0
    let zeroAndRevaluation = 0
    let nonPayment = 0
    for (const f of FILES) {
      const parsed = parseParitetText(text(f))
      nonPayment += normalizeParitetRows(parsed, { account: '' }).nonPayment
      for (const r of parsed.rows) {
        if (Number(r.amount.replace(',', '.')) !== 0) continue
        zero += 1
        if (r.purpose.includes('Переоценк')) zeroAndRevaluation += 1
      }
    }
    expect(zero).toBe(nonPayment) // отсеяли РОВНО нулевые по сумме
    expect(zeroAndRevaluation).toBe(zero) // и фактура из комментария верна: все они — переоценка
  })

  // ⚠ `money()` отдаёт NaN на мусоре, а `NaN <= 0` — это `false`: соседний гард такую строку НЕ
  // ловит, и без `isFinite` она уехала бы в CRM суммой `NaN`.
  it('нечитаемая сумма не проходит как NaN', () => {
    const t = text('settlement-byn.txt').replace('*1*18,28*', '*1*не-число*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items.every(i => Number.isFinite(i.amount))).toBe(true)
    expect(r.unreadable).toBe(1)
  })

  // ⚠ Строк БОЛЬШЕ объявленного — симметрично опасный случай (склеенные выгрузки, дублированный
  // хвост), и проверка `!==` обязана ловить обе стороны, а не только недостачу.
  it('строк больше объявленного — тоже отказ', () => {
    const lines = text('settlement-byn.txt').split(/\r?\n/).filter(Boolean)
    const extra = lines[1]!
    expect(() => parseParitetText([...lines.slice(0, 2), extra, ...lines.slice(2)].join('\n')))
      .toThrow(/неполная/i)
  })

  // ⚠ Потолок ввода — DoS-гард (#19). Без теста его снятие проходит молча.
  it('потолок ввода режет файл, а не разбирает его целиком', () => {
    const t = text('settlement-byn.txt')
    expect(() => parseParitetText(t, 80)).toThrow()
  })

  // ⚠ Причины разведены намеренно: «банк прислал служебную запись» — норма, «мы не поняли строку»
  // — повод сообщить нам. Сведи их в одно число, и вторая навсегда спрячется за первой.
  it('нечитаемая строка считается ОТДЕЛЬНО от служебных записей банка', () => {
    const t = text('settlement-byn.txt').replace('*0*1*18,28*', '*0*7*18,28*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items).toHaveLength(1)
    expect(r.unreadable).toBe(1)
    expect(r.nonPayment).toBe(0)
  })

  // ⚠ Та же доктрина, что у направления: пустая валюта доехала бы до заголовка дела
  // («Приход 4 800,00 ») и до разнесения, которое сверяет валюту и не нашло бы цель НИКОГДА.
  it('неизвестный код валюты отбрасывает строку, а не пишет пустую валюту', () => {
    const t = text('settlement-byn.txt').replaceAll('*933*', '*111*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items).toHaveLength(0)
    expect(r.unreadable).toBe(2)
  })

  // ⚠ Сумма меньше копейки округляется в ноль — и это НЕ операция: иначе в CRM появилось бы дело
  // «Приход 0,00 BYN», которое бухгалтеру нужно закрывать руками.
  it('сумма меньше копейки не становится делом на 0,00', () => {
    const t = text('settlement-byn.txt').replace('*1*18,28*1,0000*18,28*', '*1*0,004*1,0000*0,004*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items.every(i => i.amount > 0)).toBe(true)
    expect(r.items).toHaveLength(1)
  })

  // ⚠ Голый номер документа может прийти пустым. Ключ вида «дата|» формально НЕ пуст, поэтому
  // хеш-фолбэк `dedupKey` (#430 C1) не включился бы, и ВСЕ операции дня схлопнулись бы в одну.
  it('пустой номер документа даёт пустой docId — чтобы включился хеш-фолбэк дедупа', () => {
    const t = text('settlement-byn.txt').replace('*4504691*', '**')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items[0]!.docId).toBe('')
  })

  // ⚠ Разделитель формата — `*`, а назначение пишет ПЛАТЕЛЬЩИК. Лишняя звёздочка сдвинула бы поля,
  // и в CRM уехало бы ОБРЕЗАННОЕ назначение — та его часть, по которой работает распознавание
  // номеров. Строка при этом осталась бы строкой типа 1, и сверка с подвалом её не поймала бы.
  it('звёздочка внутри назначения не даёт молча обрезанного назначения', () => {
    const t = text('settlement-byn.txt').replace('Комиссионное', 'Комис*сионное')
    expect(() => parseParitetText(t)).toThrow(/числом полей|неполная/i)
  })

  it('ctx.account перекрывает счёт из файла', () => {
    const items = normalizeManualStatement(text('settlement-byn.txt'), { account: 'BY99OVERRIDE' })
    expect(items.every(i => i.account === 'BY99OVERRIDE')).toBe(true)
  })

  it('все фикстуры разбираются целиком и дают положительные суммы', () => {
    for (const f of FILES) {
      const items = normalizeManualStatement(text(f), { account: '' })
      expect(items.length).toBeGreaterThan(0)
      for (const i of items) {
        expect(i.amount).toBeGreaterThan(0)
        expect(i.currency).toMatch(/^[A-Z]{3}$/)
        expect(i.acceptDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(i.counterparty.account).not.toBe('')
      }
    }
  })
})

// ── Заголовок дела без имени контрагента ────────────────────────────────────────────────────────
describe('заголовок дела', () => {
  // ⚠ Имени в формате нет ВОВСЕ, поэтому висящий предлог был бы не редкой строкой, а КАЖДОЙ
  // операцией такой выписки: «Приход 4 800,00 BYN от» читается как обрезанная строка, то есть как
  // поломка приложения.
  it('без имени контрагента предлог не ставится', () => {
    const [income] = normalizeManualStatement(text('settlement-byn.txt'), { account: '' })
    expect(buildActivityTitle(income!)).toBe('Расход 18,28 BYN')
    expect(buildActivityTitle(income!)).not.toMatch(/\s(от|на)$/)
  })

  // ⚠ Имя ИЗ ОДНИХ ПРОБЕЛОВ — тот же случай, что пустое: банк присылает поле заполненным пробелами
  // чаще, чем отсутствующим. Без `.trim()` предлог вернулся бы, и мутация проходила зелёной.
  it('имя из одних пробелов считается отсутствующим', () => {
    const [op] = normalizeManualStatement(text('settlement-byn.txt'), { account: '' })
    const blank = { ...op!, counterparty: { ...op!.counterparty, name: '   ' } }
    expect(buildActivityTitle(blank)).toBe('Расход 18,28 BYN')
  })

  it('с именем предлог на месте — старое поведение не тронуто', () => {
    const [op] = normalizeManualStatement(text('settlement-byn.txt'), { account: '' })
    const named = { ...op!, counterparty: { ...op!.counterparty, name: 'ООО «Ромашка»' } }
    expect(buildActivityTitle(named)).toBe('Расход 18,28 BYN на ООО «Ромашка»')
    expect(buildActivityTitle({ ...named, direction: 'credit' as const })).toContain(' от ООО «Ромашка»')
  })
})

// ── Разбор суммы ────────────────────────────────────────────────────────────────────────────────
describe('чтение суммы', () => {
  /**
   * ⚠ Маска СТРОГАЯ, а не `parseFloat`. `parseFloat` читает «сколько получится» и молча
   * отбрасывает хвост: у записи с разделителем тысяч `1.054.89` он вернёт `1.054` — сумма
   * уменьшится в тысячу раз, а строка при этом пройдёт все проверки и запишется в CRM
   * достоверно выглядящим числом. Это хуже отказа, поэтому нераспознанная запись — `unreadable`.
   */
  it('запись с разделителем тысяч не превращается в усечённое число', () => {
    const t = text('settlement-byn.txt').replace('*1*18,28*', '*1*1,054,89*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items.map(i => i.amount)).not.toContain(1.054)
    expect(r.unreadable).toBe(1)
  })

  it('экспонента и мусор тоже отвергаются, а не читаются частично', () => {
    for (const bad of ['1e3', '18,28abc', '--18,28', '18..28']) {
      const t = text('settlement-byn.txt').replace('*1*18,28*', `*1*${bad}*`)
      const r = normalizeParitetRows(parseParitetText(t), { account: '' })
      expect(r.unreadable, bad).toBe(1)
    }
  })

  it('обычная банковская запись читается', () => {
    const t = text('settlement-byn.txt').replace('*1*18,28*', '*1*1054,89*')
    const r = normalizeParitetRows(parseParitetText(t), { account: '' })
    expect(r.items.some(i => i.amount === 1054.89)).toBe(true)
  })
})
