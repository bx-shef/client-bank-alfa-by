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
    expect(WORKER).toContain('[op] portal')
  })

  it('строка `[op]` печатается ТОЛЬКО за гейтом политики', () => {
    // Иначе возвращается ровно тот объём, ради снижения которого всё и сделано: 221 байт × каждая
    // операция ⇒ вся история логов около четырёх часов на целевом масштабе.
    const start = WORKER.indexOf('onOperation:')
    const opLine = WORKER.indexOf('[op] portal', start)
    const gate = WORKER.indexOf('shouldLogOperation', start)
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(opLine)
  })

  it('итог прогона печатается БЕЗУСЛОВНО — на одном уровне с записью результата в БД', () => {
    // `persistImportResult` заведомо безусловна (её вызывает каждый успешный прогон). Требуем от
    // строки итога тот же отступ: спрятанная под `if` она перестала бы быть тем, чем заведена —
    // записью, которая есть всегда и переживает ротацию.
    const summary = WORKER.match(/^(\s*)console\.log\(runSummaryLine\(/m)
    const persist = WORKER.match(/^(\s*)await persistImportResult\(/m)
    expect(summary?.[1]).toBeTypeOf('string')
    expect(persist?.[1]).toBeTypeOf('string')
    expect(summary![1]).toBe(persist![1])
    expect(WORKER.indexOf('runSummaryLine(')).toBeLessThan(WORKER.indexOf('await persistImportResult('))
  })
})
