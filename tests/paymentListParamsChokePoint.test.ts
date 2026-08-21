import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Архитектурный гард той же формы, что `priorResourceHeadersChokePoint` (#461).
//
// `crm.item.payment.list` требует ЧИСЛОВОЙ `entityId`, но транспорт объявлен как
// `call(method: string, params: Record<string, unknown>)` — то есть тип этого параметра компилятору
// не виден В ПРИНЦИПЕ, каким бы строгим ни был проход typecheck. Это не гипотеза: когда #542 сменил
// `resolveDealId()` с числа на строку, `scripts/mutate-payment-live.ts` молча начал слать
// `entityId:"123"` вместо `123`, и все четыре прохода остались зелёными. Замерено в обе стороны:
// ручной литерал со строкой → `exit 0`, `paymentListParams(<строка>)` → `TS2345`.
//
// Отсюда правило: параметры собирает только хелпер, объявляющий `dealId: number`. Тогда ошибка
// становится ошибкой СБОРКИ, а не тихим запросом. Цена промаха несимметрична — у
// `mutate-payment-live` это сверка ПОСЛЕ мутации живого портала, и ложное «не проведено» толкает
// оператора повторить `--apply` по уже проведённому платежу.
//
// ⚠ `.mjs` держим в том же правиле, хотя хелпер там ДРУГОЙ (`scripts/lib/b24-seed-utils.mjs`, зеркало
// с `Number()` внутри): импортировать `.ts` оттуда нельзя — модуль грузится обычным node без
// strip-types. Исключить `.mjs` было бы хуже всего: их тела не проверяет ни typecheck (`checkJs`
// выключен), ни ESLint (здесь он не type-aware). Два таких вызова гард и нашёл в `seed-test-b24.mjs`;
// grep по `scripts/*.ts` их не видел.
//
// ⚠ ЧЕГО ЭТОТ ГАРД НЕ ЛОВИТ, и это надо знать, а не выяснять потом:
//   • тело самого хелпера — он смотрит на ФОРМУ ВЫЗОВА. Что `.mjs`-хелпер правда коэрсит `entityId`,
//     проверяет `tests/b24SeedUtils.test.ts`, и без того теста эта половина не проверена ничем;
//   • имя метода в переменной (`const M = 'crm.item.payment.list'; call(M, …)`) — ищется литерал.
//     Сегодня таких вызовов нет; батч для этого метода Bitrix отклоняет (`ERROR_BATCH_METHOD_NOT_ALLOWED`),
//     так что и этот маршрут закрыт не нами. То же принятое ограничение, что у `priorResourceHeadersChokePoint`.

const ROOT = join(import.meta.dirname, '..')
const HELPER = 'paymentListParams('
const METHOD = /['"]crm\.item\.payment\.list['"]\s*,\s*(.*)$/

/**
 * Сколько вызовов метода в репозитории СЕЙЧАС. Число ТОЧНОЕ, а не «не меньше», и это принципиально:
 * при пороге `>= 4` исчезновение ОДНОГО вызова из поля зрения регулярки оставляло гард зелёным —
 * замерено мутацией (переименование метода в `mutate-payment-live.ts` в `crm.item.payment.LIST`
 * прятало ровно тот вызов, ради которого гард и написан, и обе проверки замолкали разом).
 * Легитимно добавили или убрали вызов — осознанно поправьте число здесь.
 */
const EXPECTED_CALL_SITES = 5

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === '.output') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|mjs|vue)$/.test(entry)) out.push(full)
  }
  return out
}

const isComment = (l: string) => l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')

/**
 * Второй аргумент каждого ВЫЗОВА метода.
 *
 * ⚠ Строки комментариев отбрасываются, и это не предосторожность «на всякий случай»: JSDoc в
 * `scripts/lib/b24-seed-utils.mjs` пишет `@param … `rest('crm.item.payment.list', …)` returned` —
 * имя метода В КАВЫЧКАХ и с запятой за ним, ровно то, что ищет регулярка. Первая редакция гарда
 * на нём и покраснела.
 *
 * ⚠ Пустой захват — это НЕ нарушитель, а перенос аргумента на следующую строку: валидное
 * форматирование, которое даёт любой автоперенос длинной строки. Первая редакция считала его
 * нарушителем, то есть краснела на правильном коде — а это хуже пропуска: разработчик, получив
 * непонятное падение на очевидно верном коде, ослабит регулярку, и гард перестанет стеречь вообще.
 */
export function callSites(src: string): string[] {
  const lines = src.split('\n').map(l => l.trim())
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (isComment(line)) continue
    const m = METHOD.exec(line)
    if (!m) continue
    let args = (m[1] ?? '').trim()
    for (let j = i + 1; j < lines.length && args === ''; j++) {
      const next = lines[j] ?? ''
      if (next === '' || isComment(next)) continue
      args = next
    }
    out.push(args)
  }
  return out
}

describe('crm.item.payment.list ходит только через paymentListParams (#542)', () => {
  const files = [
    ...sourceFiles(join(ROOT, 'app')),
    ...sourceFiles(join(ROOT, 'server')),
    ...sourceFiles(join(ROOT, 'scripts'))
  ]

  const sites = files.flatMap((f) => {
    const rel = f.slice(ROOT.length + 1)
    return callSites(readFileSync(f, 'utf8')).map(args => ({ rel, args }))
  })

  it(`вызовов ровно ${EXPECTED_CALL_SITES} — иначе гард частично ослеп`, () => {
    expect(sites.length).toBe(EXPECTED_CALL_SITES)
  })

  it('ни один вызов не собирает параметры руками', () => {
    const offenders = sites
      .filter(s => !s.args.startsWith(HELPER))
      .map(s => `${s.rel}: ${s.args}`)

    // Собранный руками `{ entityId, entityTypeId }` компилятор не проверяет — значение уходит в
    // `unknown`. Через хелпер та же ошибка становится ошибкой сборки.
    expect(offenders).toEqual([])
  })

  // Разбор проверяется ВЫЗОВОМ на синтетике, а не только на живом дереве: живое дерево сегодня
  // содержит лишь однострочные вызовы, поэтому регресс разбора («опять краснеем на переносе»)
  // прошёл бы незамеченным до первого автоформатирования.
  describe('разбор вызова', () => {
    const one = (src: string) => callSites(src)

    it('находит однострочный вызов', () => {
      expect(one(`await call('crm.item.payment.list', paymentListParams(Number(X)))`)).toEqual(['paymentListParams(Number(X)))'])
    })

    it('НЕ считает нарушителем перенос аргумента на следующую строку', () => {
      const src = `await call('crm.item.payment.list',\n  paymentListParams(Number(X)))`
      expect(one(src)[0]?.startsWith(HELPER)).toBe(true)
    })

    it('переносу не мешают пустая строка и комментарий между', () => {
      const src = `await call('crm.item.payment.list',\n\n  // почему так\n  paymentListParams(X))`
      expect(one(src)[0]?.startsWith(HELPER)).toBe(true)
    })

    it('ловит ручной литерал и на переносе тоже', () => {
      const src = `await call('crm.item.payment.list',\n  { entityId: X, entityTypeId: 2 })`
      expect(one(src)[0]?.startsWith(HELPER)).toBe(false)
    })

    it('упоминание метода в JSDoc вызовом не считается', () => {
      expect(one(' * @param result  the value `rest(\'crm.item.payment.list\', …)` returned')).toEqual([])
    })
  })
})
