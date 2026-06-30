import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'

// Mutable mock state, shared with the hoisted vi.mock factory below.
const replaceSpy = vi.hoisted(() => vi.fn())
const finishSpy = vi.hoisted(() => vi.fn(async () => {}))
const titleSpy = vi.hoisted(() => vi.fn(async () => {}))
const batchSpy = vi.hoisted(() => vi.fn(async () => ({ getData: () => ({ scope: ['crm'] }) })))
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
      batchMake: batchSpy
    })
  }
})

const InstallPage = await import('~/pages/install.vue').then(m => m.default)

beforeEach(() => {
  vi.useFakeTimers();
  [replaceSpy, finishSpy, titleSpy, batchSpy].forEach(s => s.mockClear())
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

  it('shows a retryable error when a batch call rejects', async () => {
    batchSpy.mockRejectedValueOnce(new Error('boom'))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Ошибка установки')
    expect(wrapper.text()).toContain('Повторить')
  })
})
