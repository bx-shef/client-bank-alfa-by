#!/usr/bin/env node
// Генератор ТЕСТОВОЙ выписки клиент-банка под засеянные компании (dev-only).
//
//   pnpm seed:companies        # сначала компании (их счета — ключ поиска в CRM)
//   pnpm make:statement        # затем файл: .tmp/test-statement.txt
//
// Формат — `***** ^Type=4^` «выписка за период», CP1251 + CRLF: ровно то, что отдаёт
// Альфа-Банк (сверено с реальной выгрузкой владельца). Номера счетов берутся ИЗ ТОГО ЖЕ
// модуля, что и посев компаний, поэтому разъехаться не могут: если счёт в выписке не
// совпадёт с `RQ_ACC_NUM` в реквизитах, приложение не найдёт компанию и весь смысл
// проверки пропадёт.
//
// Данные синтетические: УНП и номера счетов вымышленные, назначения платежа написаны так,
// чтобы дать распознаванию по матрицам за что зацепиться (номера счетов-фактур/заказов).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { C, head, log, ok } from './lib/cli.mjs'
import { CLIENTS, CONTRACTORS, MY_COMPANIES } from './seed-companies-b24.mjs'

const OUT = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '.tmp/test-statement.txt'

/** Наш счёт, по которому выписка (первая «моя компания»). */
const MY = MY_COMPANIES[0]
const MY_NAME = 'ООО ТЕСТОВАЯ КОМПАНИЯ РАЗ'
const MY_UNP = MY.unp

const DATE_BEGIN = '01.07.2026'
const DATE_END = '19.07.2026'

/** Одна операция выписки. `credit` — приход к нам, `debit` — списание. */
function op({ num, date, corr, amount, direction, purpose, opId }) {
  const isCredit = direction === 'credit'
  return [
    `^DocDate=${date}^`,
    `^Num=${num}^`,
    '^Opr=1^',
    '^PaymCode=^',
    `^Code=${corr.bic}^`,
    `^Acc=${corr.account}^`,
    `^OperationID=${opId}^`,
    `^Db=${isCredit ? '0.00' : amount}^`,
    `^Credit=${isCredit ? amount : '0.00'}^`,
    `^KorUNP=${corr.unp}^`,
    `^KorName=${corr.title.replace('[TEST] ', '').toUpperCase()}^`,
    `^Nazn=${purpose}^`,
    '^Nazn2=^',
    `^OpDate=${date}^`,
    '^DateTime=12:00:00^'
  ]
}

// Приходы от клиентов — то, ради чего всё и делается: платёж должен найти компанию по
// счёту, распознать номер в назначении и лечь в смарт-процесс распределения.
const CREDITS = CLIENTS.map((c, i) => op({
  num: String(3001 + i),
  date: `0${i + 2}.07.2026`,
  corr: c,
  amount: [1200.00, 850.50, 3400.00, 275.00, 15600.75][i].toFixed(2),
  direction: 'credit',
  opId: `TESTOP0000${i + 1}`,
  purpose: [
    'OTHR 010101 ОПЛАТА ПО СЧЕТУ СЧ-1001 ОТ 01.07.2026 БЕЗ НДС',
    'OTHR 010101 ОПЛАТА ПО СЧЕТУ СЧ-1002 ОТ 02.07.2026 БЕЗ НДС',
    'OTHR 010101 ОПЛАТА ПО ЗАКАЗУ 2001/1 ЗА УСЛУГИ БЕЗ НДС',
    'OTHR 010101 ЧАСТИЧНАЯ ОПЛАТА ПО СЧЕТУ СЧ-1003 БЕЗ НДС',
    'OTHR 010101 ОПЛАТА ПО ДОГОВОРУ БЕЗ УКАЗАНИЯ НОМЕРА БЕЗ НДС'
  ][i]
}))

// Списания подрядчикам — проверяют вторую ветку: расход не должен разноситься как оплата,
// но дело в карточке контрагента появиться обязано.
const DEBITS = CONTRACTORS.map((c, i) => op({
  num: String(4001 + i),
  date: `1${i}.07.2026`,
  corr: c,
  amount: [980.00, 2400.00, 560.40, 7300.00, 145.99][i].toFixed(2),
  direction: 'debit',
  opId: `TESTOP1000${i + 1}`,
  purpose: [
    'OTHR 020202 ОПЛАТА ЗА МОНТАЖНЫЕ РАБОТЫ ПО АКТУ 55 БЕЗ НДС',
    'OTHR 020202 ОПЛАТА ЗА ЭЛЕКТРОМОНТАЖ ПО СЧЕТУ 778 БЕЗ НДС',
    'OTHR 020202 ТРАНСПОРТНЫЕ УСЛУГИ ИЮЛЬ 2026 БЕЗ НДС',
    'OTHR 020202 РЕМОНТ ОБОРУДОВАНИЯ ПО ДОГОВОРУ 12-Р БЕЗ НДС',
    'OTHR 020202 КАНЦТОВАРЫ ПО НАКЛАДНОЙ 9012 БЕЗ НДС'
  ][i]
}))

// Перемешиваем приходы и расходы по датам — как в реальной выгрузке, а не блоками:
// иначе тест не покажет, что порядок строк на разбор не влияет.
const OPERATIONS = [...CREDITS, ...DEBITS]

const lines = [
  `***** ^Type=4^ ^Acc=${MY.account}^  -  Выписка по счету за период`,
  '[IN_PARAM]',
  `^DateBegin=${DATE_BEGIN}^`,
  `^DateEnd=${DATE_END}^`,
  '^DontSendEmpty=^',
  '^DontSendPaymTarget=0^',
  '^_Address=БЕЛАРУСЬ, Г. МИНСК, ТЕСТОВЫЙ АДРЕС^',
  '^_Face1=ТЕСТОВЫЙ ДИРЕКТОР^',
  '^_Face2=^',
  '^_AppFace1=Директор^',
  `^_AccSettl=${MY.account}^`,
  '^_CBU=^',
  '^_CBUAddress=^',
  '^_City=^',
  `^Name=${MY_NAME}^`,
  `^UNN=${MY_UNP}^`,
  '^Version=1^',
  '[OUT_PARAM]',
  `^Time=${DATE_END}, 13.43^`,
  `^Header1=${MY.account}^`,
  '^Header2=00001^',
  `^Header3=${DATE_BEGIN}^`,
  `^Header4=${MY.account}^`,
  `^Header5=${MY_NAME}^`,
  `^DateBegin=${DATE_BEGIN}^`,
  `^DateEnd=${DATE_END}^`,
  `^DateIn=${DATE_BEGIN}^`,
  '^RestIn=10000.00^',
  '^AcPa=АКТИВ^',
  '^AcPa1=АКТИВ^',
  ...OPERATIONS.flat()
]

// CP1251 + CRLF — как отдаёт банк. Node не умеет кодировать cp1251 «из коробки»,
// поэтому таблица строится обратным преобразованием через decoder: так не нужен
// внешний пакет, а соответствие гарантировано тем же декодером, которым парсер читает.
function encodeCp1251(text) {
  const decoder = new TextDecoder('windows-1251')
  const map = new Map()
  for (let b = 0; b < 256; b++) map.set(decoder.decode(new Uint8Array([b])), b)
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = map.get(text[i])
    if (code === undefined) throw new Error(`символ вне CP1251: ${JSON.stringify(text[i])} (позиция ${i})`)
    out[i] = code
  }
  return Buffer.from(out)
}

head('Тестовая выписка клиент-банка')
const text = lines.join('\r\n') + '\r\n'
const path = resolve(OUT)
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, encodeCp1251(text))

ok(`Файл: ${path}`)
log(`  наш счёт:   ${MY.account} (${MY_NAME})`)
log(`  приходов:   ${CREDITS.length} (от клиентов)`)
log(`  списаний:   ${DEBITS.length} (подрядчикам)`)
log(`${C.dim}  Загрузи его на /import → «Записать в CRM».${C.reset}`)
