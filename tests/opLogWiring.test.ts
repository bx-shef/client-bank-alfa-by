import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Архитектурный гард проводки построчного лога (#498), той же формы, что
// `priorResourceHeadersChokePoint` (#461) и `bankRefreshLock` (#509).
//
// Политика (`app/utils/opLogPolicy.ts`) покрыта юнит-тестами и мутационно проверена. Но политика
// без проводки — просто чистая функция: ПРОВЕРЕНО МУТАЦИЕЙ, что удаление гейта из `onOperation` и
// удаление строки итога из воркера оставляют весь остальной набор зелёным. То есть регрессия
// объёма лога («история сжалась до четырёх часов») вернулась бы молча, а безусловная запись уровня
// прогона исчезла бы вовсе — и заметить это можно было бы только замером на проде.
//
// Юнит-тестом воркера это не закрыть: `startThroughputWorkers`/`liveHandlerDeps` — живые
// транспорты (Redis, B24 REST, банк), их не поднять в node-проекте. Поэтому сверяем исходник.

const ROOT = join(import.meta.dirname, '..')
const WORKER = readFileSync(join(ROOT, 'server/queue/worker.ts'), 'utf8')

describe('проводка построчного лога операций (#498)', () => {
  it('исходник читается и всё ещё содержит обе точки', () => {
    // Без этого «нарушителей нет» достигалось бы переименованием — тест выглядел бы зелёным.
    expect(WORKER).toContain('onOperation:')
    expect(WORKER).toContain('buildOpLogLine(')
  })

  it('воркер САМ гейт не реализует — решение живёт в тестируемом билдере', () => {
    // ⚠ Форма проверки сменилась по находке ревью. Раньше требовалось лишь, чтобы подстрока
    // `shouldLogOperation` стояла перед `[op] portal`, — и мутация
    // `if (false && !shouldLogOperation(…)) return` оставляла тест зелёным при полностью мёртвом
    // гейте, то есть возвращала регрессию #498 целиком. Текстовая проверка такое не ловит
    // принципиально: она не знает, что значит `false &&`.
    //
    // Поэтому и гейт, и текст переехали в `buildOpLogLine` (чистая функция, исполняемый тест
    // `tests/opLogLine.test.ts`), а здесь проверяется ровно одно: воркер не начал строить строку
    // сам в обход билдера. Обезвредить гейт, не уронив исполняемый тест, теперь нельзя.
    const start = WORKER.indexOf('onOperation:')
    expect(start).toBeGreaterThan(-1)
    const body = WORKER.slice(start, WORKER.indexOf('\n    },', start))
    expect(body).toContain('buildOpLogLine(')
    // Сам текст строки в воркере больше не собирается — иначе рядом с билдером завёлся бы второй
    // путь, и санитизация/гейт на нём никем бы не проверялись.
    // ⚠ Маркер переехал в КАНАЛ (#529): в воркере его быть не должно ни в каком виде.
    expect(body).not.toContain('[op] portal')
    expect(body).not.toContain('logSafe(')
  })

  it('итог прогона печатается БЕЗУСЛОВНО — сразу за блоком catch, без единого условия между', () => {
    // ⚠ Проверка ужесточена по находке ревью. Сравнения отступа с `persistImportResult` было мало:
    // guard clause `if (OP_LOG_MODE === 'off') return`, вставленный СТРОКОЙ ВЫШЕ с тем же
    // отступом, саму строку не трогает — отступ и порядок остаются прежними, тест зелёный, а
    // «безусловная» запись перестаёт печататься именно в аварийном режиме, где нужнее всего.
    //
    // Поэтому требуется структурная смежность: между закрывающей скобкой `catch` и строкой итога
    // не должно быть НИЧЕГО, кроме комментариев. Любой вставленный оператор ломает тест.
    const lines = WORKER.split('\n')
    const at = lines.findIndex(l => l.includes('crmLog.info(runSummaryLine('))
    expect(at).toBeGreaterThan(-1)
    let i = at - 1
    while (i >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[i]!)) i--
    // Предыдущий НЕ-комментарий обязан быть закрытием catch-блока — то есть между ним и печатью
    // итога нет ни `if`, ни `return`, ни любого другого оператора.
    expect(lines[i]!.trim()).toBe('}')
    expect(lines.slice(0, at).join('\n')).toContain('} catch (e) {')

    // И прежняя проверка на месте: тот же уровень вложенности, что у заведомо безусловной записи
    // результата в БД, и порядок «сначала лог, потом БД».
    const summary = WORKER.match(/^(\s*)crmLog\.info\(runSummaryLine\(/m)
    const persist = WORKER.match(/^(\s*)await persistImportResult\(/m)
    expect(summary![1]).toBe(persist![1])
    expect(WORKER.indexOf('runSummaryLine(')).toBeLessThan(WORKER.indexOf('await persistImportResult('))
  })
})
