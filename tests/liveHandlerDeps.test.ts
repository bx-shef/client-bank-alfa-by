import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StatementItem } from '../app/types/statement'
import type { HandlerDeps } from '../server/queue/handlers'
import { DEMO_ACCOUNT_PREFIX } from '../server/queue/cron'

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
    counterparty: { name: 'X', account: 'BY00X' },
    acceptDate: '2026-07-16',
    ...over
  }
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
  it('recordAllocation(demo) → false, no store write', async () => {
    expect(await deps.recordAllocation(demoItem(), decision.target, 'MEMBER-1')).toBe(false)
  })
  it('hasAllocationFact(demo) → false, no store read', async () => {
    expect(await deps.hasAllocationFact(demoItem(), decision.target, 'MEMBER-1')).toBe(false)
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
  it('onRecognized / onResolved / onAllocationDecision are side-effect-free logs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const it0 = demoItem()
    expect(() => deps.onRecognized(it0, [], 'M')).not.toThrow()
    expect(() => deps.onResolved(it0, [], 'M')).not.toThrow()
    expect(() => deps.onAllocationDecision(it0, decision, 0, 'M')).not.toThrow()
  })
})

describe('liveHandlerDeps — parseFile (manual-import parse authority)', () => {
  it('decodes+parses a real client-bank fixture → statement items', async () => {
    const bytes = readFileSync(fileURLToPath(new URL('./fixtures/client-bank/demo-type4-alfa.txt', import.meta.url)))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const items = await deps.parseFile({
      memberId: 'M', account: 'ACC', contentBase64: bytes.toString('base64'), fileName: 'выписка.txt'
    } as Parameters<HandlerDeps['parseFile']>[0])
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]).toHaveProperty('account')
    expect(items[0]).toHaveProperty('amount')
  })
})
