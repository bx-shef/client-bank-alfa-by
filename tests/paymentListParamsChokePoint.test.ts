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
// выключен), ни ESLint (здесь он не type-aware), то есть гард — единственное, что их вообще смотрит.
// Оба таких вызова этот гард и нашёл — grep по `scripts/*.ts` их не видел.

const ROOT = join(import.meta.dirname, '..')
const HELPER = 'paymentListParams('
const METHOD = /['"]crm\.item\.payment\.list['"]\s*,\s*(.*)$/

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

/**
 * Второй аргумент каждого ВЫЗОВА метода.
 *
 * ⚠ Строки комментариев отбрасываются, и это не предосторожность «на всякий случай»: JSDoc в
 * `scripts/lib/b24-seed-utils.mjs` пишет `@param … `rest('crm.item.payment.list', …)` returned` —
 * то есть имя метода В КАВЫЧКАХ и с запятой за ним, ровно то, что ищет регулярка. Первая редакция
 * гарда на нём и покраснела. Отбрасываем по началу строки (`//`, `*`, `/*`), потому что нас
 * интересует вызов, а не упоминание.
 */
function callSites(src: string): string[] {
  const out: string[] = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    const m = METHOD.exec(line)
    if (m) out.push((m[1] ?? '').trim())
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

  it('вызовы вообще находятся — иначе гард вакуумный', () => {
    // ⚠ Без этой проверки достаточно переименовать метод или перенести аргумент на свою строку,
    // чтобы гард молча перестал что-либо стеречь и остался зелёным навсегда. Пустой результат —
    // красный. Сейчас вызовов четыре: два продовых и два в seed-скрипте.
    expect(sites.length).toBeGreaterThanOrEqual(4)
  })

  it('ни один вызов не собирает параметры руками', () => {
    const offenders = sites
      .filter(s => !s.args.startsWith(HELPER))
      .map(s => `${s.rel}: ${s.args}`)

    // Собранный руками `{ entityId, entityTypeId }` компилятор не проверяет — значение уходит в
    // `unknown`. Через хелпер та же ошибка становится ошибкой сборки.
    expect(offenders).toEqual([])
  })
})
