import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StatementItem } from '../app/types/statement'
import type { HandlerDeps } from '../server/queue/handlers'
import { DEMO_ACCOUNT_PREFIX } from '../server/queue/cron'

/** Перехват того, что РЕАЛЬНО уходит в лог. После #529 строка идёт не в `console.log`, а в
 *  `process.stdout` через обработчик логгера — то есть проверять надо поток, иначе тест зеленеет
 *  на молчащем шпионе. Замерено: запись синхронна, поэтому ассерт сразу после вызова видит её. */
function captureLog() {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c))
    return true
  })
  return () => chunks.join('\n')
}

// Wiring test for `liveHandlerDeps` (server/queue/worker.ts) — the ONE runtime module the
// pure-handler tests (queuePhase2) don't cover. We verify the two safety-critical glue behaviours
// that hold WITHOUT a DB/portal:
//   1. DEMO-account gating — a demo op (load generator) must NEVER touch the real portal's REST or
//      the persistent store: every item-scoped transport short-circuits on `isDemoAccount`.
//   2. `parseFile` — the manual-import parse transport decodes+parses a real fixture (server is the
//      single parse authority).
// Non-demo branches need a live token/DB and are exercised by the live dev scripts (verify:109 /
// activity:test), not here.

// Zero the demo processing delay BEFORE importing worker.ts (it reads DEMO_DELAY_MS at module load),
// so the demo-gated calls resolve instantly instead of waiting the ~600ms load-demo pause.
process.env.DEMO_DELAY_MS = '0'

let deps: HandlerDeps
beforeAll(async () => {
  const mod = await import('../server/queue/worker')
  deps = mod.liveHandlerDeps()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function demoItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: `${DEMO_ACCOUNT_PREFIX}1`,
    docId: 'D1',
    direction: 'credit',
    amount: 100,
    currency: 'BYN',
    purpose: 'тест',
    counterparty: { name: 'X', unp: '', account: 'BY00X' },
    acceptDate: '2026-07-16',
    ...over
  }
}

/** Обычная (не демо) операция — для проверок, которые обязаны дойти до транспорта. */
function realItem(): StatementItem {
  return demoItem({ account: 'BY00REAL0000000000000000001' })
}

const target = { kind: 'deal-payment' as const, id: '5' }
const decision = { action: 'allocate' as const, target: { ...target, amount: 100, currency: 'BYN' }, ambiguous: false, alternatives: [] }

describe('liveHandlerDeps — DEMO-account gating (never touches a real portal)', () => {
  it('findCompany(demo) → null, no REST', async () => {
    expect(await deps.findCompany(demoItem(), 'MEMBER-1')).toBeNull()
  })
  it('writeActivity(demo) → null, no REST', async () => {
    expect(await deps.writeActivity(demoItem(), 'C-7', 'MEMBER-1')).toBeNull()
  })
  it('writeLedger(demo) → false, no REST (§9.3 #6 — durable record is the SP row)', async () => {
    expect(await deps.writeLedger!(demoItem(), decision.target, 'C-7', 'MEMBER-1', { paymentSp: { entityTypeId: 1044, id: 144 }, distributionSp: { entityTypeId: 1046, id: 146 } })).toBe(false)
  })
  it('hasTriggerFact(demo) → false, no store read (§9.3 #6)', async () => {
    expect(await deps.hasTriggerFact!(demoItem(), decision.target, 'MEMBER-1', { paymentSp: { entityTypeId: 1044, id: 144 }, distributionSp: { entityTypeId: 1046, id: 146 } })).toBe(false)
  })
  it('writeTriggerFact(demo) → false, no REST (§9.3 #6)', async () => {
    expect(await deps.writeTriggerFact!(demoItem(), decision.target, 'C-7', 'MEMBER-1', { paymentSp: { entityTypeId: 1044, id: 144 }, distributionSp: { entityTypeId: 1046, id: 146 } })).toBe(false)
  })
  it('writePaymentRegistry(demo) → null, no REST (#575)', async () => {
    expect(await deps.writePaymentRegistry!(demoItem(), 'C-7', 'MEMBER-1', 'alfa-by', { entityTypeId: 1044, id: 144 })).toBeNull()
  })
  it('writePaymentRegistry БЕЗ токена портала БРОСАЕТ, а не отдаёт null (#575)', async () => {
    // ⚠ Не косметика. `null` не доходит до `catch` в обработчике, поэтому счётчик `registryFailed`
    // остался бы нулём: портал, чей токен умер посреди пачки, не получил бы НИ ОДНОГО элемента
    // реестра, а строка итога печатала бы «реестр работает штатно». Ровно этот выбор делают четыре
    // соседние зависимости (`writeLedger`/`applyAllocation`/`hasTriggerFact`/`writeTriggerFact`).
    await expect(deps.writePaymentRegistry!(realItem(), 'C-7', 'MEMBER-NO-TOKEN', 'alfa-by', { entityTypeId: 1044, id: 144 }))
      .rejects.toThrow()
  })
  it('bindActivity БЕЗ токена портала не бросает, а отдаёт «все не поставлены» (#579)', async () => {
    // ⚠ Противоположно соседнему `writePaymentRegistry`, и это не непоследовательность. Реестр
    // пишется ДО дела, поэтому его бросок означает чистый повтор джобы. Привязки ставятся ПОСЛЕ
    // маркера дела: повтор до них уже не дойдёт (операция отсеется на дедуп-гейте), так что бросок
    // не починил бы ничего — он лишь отменил бы обработку всех оставшихся операций пачки.
    // Мутационный прогон показал, что этот контракт не защищал НИ ОДИН тест.
    await expect(deps.bindActivity!('2087', [{ entityTypeId: 4, entityId: 9 }], 'MEMBER-NO-TOKEN'))
      .resolves.toEqual({ bound: 0, failed: 1 })
  })
  it('bindActivity без ссылок не ходит в портал вовсе (#579)', async () => {
    // Пустой список — штатный исход (клиент не опознан, реестра нет, цель не найдена), а не сбой:
    // резолвить токен ради нуля вызовов значит платить за ничто на каждой такой операции.
    await expect(deps.bindActivity!('2087', [], 'MEMBER-NO-TOKEN')).resolves.toEqual({ bound: 0, failed: 0 })
  })
  it('isTargetApplied(demo) → false, no REST state read (Фаза A)', async () => {
    expect(await deps.isTargetApplied(demoItem(), decision.target, 'MEMBER-1', {})).toBe(false)
  })
  it('applyAllocation(demo) → false, no mutation', async () => {
    expect(await deps.applyAllocation(demoItem(), decision.target, 'MEMBER-1', {})).toBe(false)
  })
  // notifyChat/notifyError swallow ALL errors in a try/catch and resolve `undefined`, so a bare
  // `resolves.toBeUndefined()` would pass even if the isDemoAccount guard were removed (the
  // fall-through `resolvePortalCall` would throw on the absent DB and be swallowed) — a vacuous
  // assertion. Instead assert `console.error` was NOT called: the demo guard returns BEFORE the
  // try block, so no error is logged; remove the guard and the swallowed throw logs
  // "chat notify failed"/"alloc error notify failed" → this test then fails. Non-vacuous.
  it('notifyChat(demo) short-circuits before the try block (no error logged, no REST)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(deps.notifyChat(demoItem(), 'chat1', 'MEMBER-1')).resolves.toBeUndefined()
    expect(err).not.toHaveBeenCalled()
  })
  it('notifyError(demo) short-circuits before the try block (no error logged, no REST)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(deps.notifyError(demoItem(), decision, 'chat1', 'MEMBER-1')).resolves.toBeUndefined()
    expect(err).not.toHaveBeenCalled()
  })
})

describe('liveHandlerDeps — log-only observers never throw', () => {
  it('onRecognized / onResolved / onAllocationDecision / onOperation are side-effect-free logs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const it0 = demoItem()
    expect(() => deps.onRecognized(it0, [], 'M')).not.toThrow()
    expect(() => deps.onResolved(it0, [], 'M')).not.toThrow()
    expect(() => deps.onAllocationDecision(it0, decision, 0, 'M')).not.toThrow()
    expect(() => deps.onOperation?.(it0, { owner: 'none', recognized: 0, activityId: null }, 'M')).not.toThrow()
  })
})

describe('liveHandlerDeps — `[op]` не раскрывает назначение платежа без флага', () => {
  // Это приватность, а не косметика: назначение — текст плательщика, самое широкое неконтролируемое
  // поле, которое мы держим, и docs/PRIVACY.md §Логи держит его вне лога по умолчанию. Гейт —
  // одна тернарная ветка в живой строке; вернуть её «упрощением» ничего не стоит, а заметить
  // отсутствующий регресс можно только на чужом сервере, где лог уже написан.
  // `STATEMENT_DEBUG_LOG` читается при загрузке модуля и в тестах не задан ⇒ проверяем дефолт.
  const SECRET = 'ОПЛАТА ПО СЧЁТУ 1545874-B24 ЗА ЦЕМЕНТ'

  it('без флага в строке нет ни назначения, ни номеров счетов обеих сторон (#617)', () => {
    const read = captureLog()
    deps.onOperation?.(demoItem({ account: 'BY55OUR', purpose: SECRET, counterparty: { name: 'X', unp: '', account: 'BY77TEST' } }), { owner: 'none', recognized: 0, activityId: null }, 'M')
    const line = read()
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('ЦЕМЕНТ') // и фрагментом тоже не протекает
    // ⚠ #617: номера счетов обеих сторон — финансовые ПДн с многолетней ретенцией — по умолчанию
    // вне строки; диагностику «какой счёт не нашёлся» несёт сообщение в чат ошибок клиента.
    expect(line).not.toContain('BY77TEST')
    expect(line).not.toContain('BY55OUR')
    // Диагностика без ПДн осталась: исход операции виден.
    expect(line).toContain('NO OWNER')
  })

  it('суммы в строке нет — граница PRIVACY.md §Логи проходит здесь же', () => {
    const read = captureLog()
    deps.onOperation?.(demoItem({ amount: 987654.32 }), { owner: 'none', recognized: 0, activityId: null }, 'M')
    const line = read()
    expect(line).not.toContain('987654')
    expect(line).not.toContain('987 654')
  })
})

describe('liveHandlerDeps — `[op]` раскрывает назначение при включённом флаге', () => {
  // Вторая половина обязательна: сама по себе проверка «назначения нет» осталась бы зелёной и
  // если бы гейт перестал работать вовсе (например, поле выкинули из строки). Флаг читается при
  // загрузке модуля — как DEMO_DELAY_MS выше, — поэтому единственный способ его проверить —
  // пересобрать модуль с другим окружением.
  const SECRET = 'ОПЛАТА ПО СЧЁТУ 1545874-B24 ЗА ЦЕМЕНТ'
  const saved = process.env.STATEMENT_DEBUG_LOG

  afterEach(() => {
    vi.resetModules()
    if (saved === undefined) delete process.env.STATEMENT_DEBUG_LOG
    else process.env.STATEMENT_DEBUG_LOG = saved
  })

  it('включённый флаг реально печатает назначение (обрезанное по капу)', async () => {
    process.env.STATEMENT_DEBUG_LOG = '1'
    vi.resetModules()
    const { liveHandlerDeps } = await import('../server/queue/worker')
    const read = captureLog()
    liveHandlerDeps().onOperation?.(demoItem({ account: 'BY55OUR', purpose: `${SECRET} ${'х'.repeat(500)}`, counterparty: { name: 'X', unp: '', account: 'BY77TEST' } }), { owner: 'none', recognized: 0, activityId: null }, 'M')
    const line = read()
    expect(line).toContain(SECRET)
    // Кап держит: одно поле не может залить строку целиком.
    expect(line).not.toContain('х'.repeat(400))
    // ⚠ #617: тот же флаг раскрывает и номера счетов обеих сторон — для отладки на нашей стороне.
    expect(line).toContain('BY77TEST')
    expect(line).toContain('BY55OUR')
  })
})

describe('liveHandlerDeps — parseFile (manual-import parse authority)', () => {
  it('decodes+parses a real client-bank fixture → statement items', async () => {
    const bytes = readFileSync(fileURLToPath(new URL('./fixtures/client-bank/demo-type4-alfa.txt', import.meta.url)))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const items = await deps.parseFile({
      // ⚠ Полный ParseJob: у него нет `account`, зато есть providerId/fileHash. Прежний
      // литерал был формой из прошлой версии задачи и держался только на `as` — тип его не смотрел.
      memberId: 'M', providerId: 'manual', fileHash: 'h1',
      contentBase64: bytes.toString('base64'), fileName: 'выписка.txt'
    })
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]).toHaveProperty('account')
    expect(items[0]).toHaveProperty('amount')
  })
})
