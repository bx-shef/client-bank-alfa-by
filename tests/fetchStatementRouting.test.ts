import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HandlerDeps } from '../server/queue/handlers'
import type { FetchJob } from '../server/queue/topology'
import { DEMO_ACCOUNT_PREFIX, demoItems } from '../server/queue/cron'

// Routing test for liveHandlerDeps().fetchStatement (server/queue/worker.ts, A9): the thin branch
// that typecheck alone can't guard. Two safety-critical behaviours:
//   1. a DEMO- job returns the synthetic batch and NEVER reaches the live bank transport;
//   2. a real job is routed to fetchBankStatement with the fields mapped EXACTLY —
//      FetchJob.providerId → BankFetchQuery.provider, and account/dateFrom/dateTo NOT transposed
//      (all four are `string`, so a swap compiles clean — only an assertion catches it).
// The live transport is module-mocked, so this touches no DB/network. Kept in its own spec because
// the file-wide vi.mock must not leak into the DB-free liveHandlerDeps.test.ts.

vi.mock('../server/utils/bankFetch', () => ({
  fetchBankStatement: vi.fn(async () => [])
}))

// worker.ts reads DEMO_DELAY_MS at module load — zero it so the demo pause is instant.
process.env.DEMO_DELAY_MS = '0'

let deps: HandlerDeps
let fetchBankStatement: ReturnType<typeof vi.fn>
beforeAll(async () => {
  const bank = await import('../server/utils/bankFetch')
  fetchBankStatement = bank.fetchBankStatement as unknown as ReturnType<typeof vi.fn>
  const mod = await import('../server/queue/worker')
  deps = mod.liveHandlerDeps()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('liveHandlerDeps().fetchStatement routing (A9)', () => {
  it('DEMO- account → synthetic demoItems, never the live transport', async () => {
    const job: FetchJob = {
      memberId: 'M', providerId: 'manual', account: `${DEMO_ACCOUNT_PREFIX}1`,
      dateFrom: '2026-07-01', dateTo: '2026-07-31'
    }
    const items = await deps.fetchStatement(job)
    expect(items).toEqual(demoItems(job))
    expect(fetchBankStatement).not.toHaveBeenCalled()
  })

  it('real account → fetchBankStatement with providerId→provider and the exact window', async () => {
    const job: FetchJob = {
      memberId: 'M7', providerId: 'alfa-by', account: 'BY13ALFA',
      dateFrom: '2026-06-01', dateTo: '2026-06-30'
    }
    await deps.fetchStatement(job)
    expect(fetchBankStatement).toHaveBeenCalledTimes(1)
    // Exact object → catches a dropped field OR an account/dateFrom/dateTo transposition
    // that typecheck can't see (every field is a string).
    expect(fetchBankStatement).toHaveBeenCalledWith({
      memberId: 'M7',
      provider: 'alfa-by',
      account: 'BY13ALFA',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30'
    })
  })
})
