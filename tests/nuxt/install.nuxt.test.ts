import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'

// Mutable mock state, shared with the hoisted vi.mock factory below.
const replaceSpy = vi.hoisted(() => vi.fn())
const finishSpy = vi.hoisted(() => vi.fn(async () => {}))
const titleSpy = vi.hoisted(() => vi.fn(async () => {}))
const callSpy = vi.hoisted(() => vi.fn(async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ result: true }),
  getErrorMessages: () => [] as string[]
})))
const batchSpy = vi.hoisted(() => vi.fn(async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
  getErrorMessages: () => [] as string[]
})))
const state = vi.hoisted(() => ({ inFrame: false }))

vi.mock('vue-router', async (orig) => {
  const actual = await orig<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ replace: replaceSpy }) }
})

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return {
    useB24: () => makeMockB24({
      isInit: () => state.inFrame,
      installFinish: finishSpy,
      setTitle: titleSpy,
      batchMake: batchSpy,
      callMake: callSpy
    })
  }
})

const InstallPage = await import('~/pages/install.vue').then(m => m.default)

const defaultBatch = async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
  getErrorMessages: () => [] as string[]
})

beforeEach(() => {
  vi.useFakeTimers();
  [replaceSpy, finishSpy, titleSpy, batchSpy, callSpy].forEach(s => s.mockClear())
  // mockClear keeps implementations, so restore the default (a test may have
  // installed a failure-aware mockImplementation).
  batchSpy.mockImplementation(defaultBatch)
  callSpy.mockImplementation(async () => ({ isSuccess: true, getData: () => ({ result: true }), getErrorMessages: () => [] as string[] }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('install.vue — standalone (no B24 frame)', () => {
  beforeEach(() => {
    state.inFrame = false
  })

  it('runs the mock progress and redirects to /', async () => {
    await mountSuspended(InstallPage)
    // waitForB24 polls ~10s, then ~1.5s mock delay before router.replace('/').
    await vi.advanceTimersByTimeAsync(13000)
    expect(replaceSpy).toHaveBeenCalledWith('/')
    expect(finishSpy).not.toHaveBeenCalled()
  })
})

describe('install.vue — inside a B24 frame', () => {
  beforeEach(() => {
    state.inFrame = true
  })

  it('sets the title and calls installFinish (no redirect)', async () => {
    await mountSuspended(InstallPage)
    // isInit() is true immediately, so waitForB24 returns at once; then setTitle,
    // batch.make, an ~800ms delay, installFinish.
    await vi.advanceTimersByTimeAsync(2000)
    expect(titleSpy).toHaveBeenCalled()
    expect(finishSpy).toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('binds ONAPPINSTALL/ONAPPUNINSTALL to the backend endpoint before finishing', async () => {
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // Find the batch call (and its call index) that carries the event.bind calls.
    type BatchArg = { calls?: { method: string, params: Record<string, unknown> }[] }
    const bindIndex = batchSpy.mock.calls.findIndex((call) => {
      const arg = (call as unknown[])[0] as BatchArg
      return Array.isArray(arg.calls) && arg.calls.some(c => c.method === 'event.bind')
    })
    expect(bindIndex).toBeGreaterThanOrEqual(0)
    const bindArg = (batchSpy.mock.calls[bindIndex]![0]) as BatchArg
    const bound = bindArg.calls!.filter(c => c.method === 'event.bind')
    expect(bound.map(c => c.params.event)).toEqual(['ONAPPINSTALL', 'ONAPPUNINSTALL'])
    // Handler must be ABSOLUTE (the guard's whole point) — a relative path would
    // register a dead binding. `.+//` before the path enforces scheme+host.
    for (const c of bound) expect(String(c.params.handler)).toMatch(/^https?:\/\/.+\/api\/b24\/events$/)
    // Ordering is load-bearing: bind must run BEFORE installFinish so the current
    // install's ONAPPINSTALL reaches the freshly-bound handler.
    expect(finishSpy).toHaveBeenCalled()
    const bindOrder = batchSpy.mock.invocationCallOrder[bindIndex]!
    const finishOrder = finishSpy.mock.invocationCallOrder[0]!
    expect(bindOrder).toBeLessThan(finishOrder)
  })

  it('registers the app automation trigger (crm.automation.trigger.add) before finishing (#79)', async () => {
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // A single call.make with the trigger registration was issued.
    type CallArg = { method: string, params: Record<string, unknown> }
    const regIndex = callSpy.mock.calls.findIndex((call) => {
      const arg = (call as unknown[])[0] as CallArg
      return arg?.method === 'crm.automation.trigger.add'
    })
    expect(regIndex).toBeGreaterThanOrEqual(0)
    const regArg = (callSpy.mock.calls[regIndex]![0]) as CallArg
    expect(regArg.params.CODE).toBe('cba_payment_received')
    expect(String(regArg.params.NAME)).not.toHaveLength(0)
    // Runs in application context before installFinish.
    expect(finishSpy).toHaveBeenCalled()
    const regOrder = callSpy.mock.invocationCallOrder[regIndex]!
    expect(regOrder).toBeLessThan(finishSpy.mock.invocationCallOrder[0]!)
  })

  it('trigger registration is BEST-EFFORT: a rejected promise does not block the install', async () => {
    // Non-admin installer / non-commercial plan → the API rejects trigger.add. The
    // install must still finish (the token-delivering event.bind already succeeded).
    callSpy.mockRejectedValue(new Error('Access denied! Admin permissions required'))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).toHaveBeenCalled() // install NOT blocked
    expect(wrapper.text()).not.toContain('Ошибка установки')
  })

  it('trigger registration is BEST-EFFORT: a resolved FAILED Result does not block the install (realistic B24 failure)', async () => {
    // B24 usually returns a failed Result rather than throwing — registerTrigger reads
    // res.isSuccess=false and records the error string, never rethrows. Install still finishes.
    callSpy.mockImplementation(async () => ({
      isSuccess: false,
      getData: () => ({ result: false }),
      getErrorMessages: () => ['Access denied! Application context required']
    }))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // The call WAS made and returned a failed Result (not a throw); install still finishes.
    const madeReg = callSpy.mock.calls.some((c) => {
      const arg = (c as unknown[])[0] as { method?: string }
      return arg?.method === 'crm.automation.trigger.add'
    })
    expect(madeReg).toBe(true)
    expect(finishSpy).toHaveBeenCalled() // install NOT blocked by the failed Result
    expect(wrapper.text()).not.toContain('Ошибка установки')
  })

  it('surfaces a retryable error and does NOT finish when event.bind fails', async () => {
    // Init batch (app.info/scope/event.get) succeeds; the bind batch resolves as
    // a failed Result — install must not finish with events unbound.
    batchSpy.mockImplementation(async (arg?: unknown) => {
      const calls = (arg as { calls?: { method: string }[] }).calls
      const isBind = Array.isArray(calls) && calls.some(c => c.method === 'event.bind')
      return {
        isSuccess: !isBind,
        getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
        getErrorMessages: () => (isBind ? ['bind refused'] : [])
      }
    })
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Ошибка установки')
    expect(wrapper.text()).toContain('Повторить')
  })

  it('shows a retryable error when a batch call rejects', async () => {
    batchSpy.mockRejectedValueOnce(new Error('boom'))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Ошибка установки')
    expect(wrapper.text()).toContain('Повторить')
  })
})
