import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import PollNowButton from '~/components/PollNowButton.vue'

// Admin gate + render + poll interaction for the manual «Опросить сейчас» button (#54). Driven
// through a mocked useB24 + useFrameAuth, mirroring bankConnectCard.nuxt.test.ts. Gate is
// default-CLOSED — the card is withheld until the onMounted admin-check.
const mockState = { isInit: true, isAdmin: true }

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => mockState.isInit, isAdmin: mockState.isAdmin }) }
})

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => (mockState.isInit ? { token: 'T', domain: 'd.bitrix24.by' } : null),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

const fetchMock = vi.fn()
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  fetchMock.mockReset()
  mockState.isInit = true
  mockState.isAdmin = true
})

async function mountReady() {
  const wrapper = await mountSuspended(PollNowButton)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('PollNowButton admin gate', () => {
  it('in portal + admin → card with button', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="poll-now"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-preview-note"]').exists()).toBe(false)
  })

  it('in portal + NOT admin → nothing shown', async () => {
    mockState.isInit = true
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="poll-now"]').exists()).toBe(false)
  })

  it('standalone → preview card with preview note', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="poll-now"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-preview-note"]').exists()).toBe(true)
  })
})

describe('PollNowButton poll interaction', () => {
  it('clicking → posts and shows the success message', async () => {
    fetchMock.mockResolvedValueOnce({ enqueued: 2, accounts: 2, cooldownSec: 60 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledWith('/api/poll-now', expect.objectContaining({ method: 'POST' }))
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-error"]').exists()).toBe(false)
  })

  it('cooldown (429) → friendly error, no success', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 429 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="poll-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(false)
  })

  it('disabled (503) → friendly "отключён" error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 503 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const err = wrapper.find('[data-testid="poll-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('отключён')
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(false)
  })

  it('not admin (403) → friendly "администратор" error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 403 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="poll-error"]').text()).toContain('администратор')
  })

  it('no connected accounts → prompts to connect first', async () => {
    fetchMock.mockResolvedValueOnce({ enqueued: 0, accounts: 0 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const msg = wrapper.find('[data-testid="poll-message"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('подключите счёт')
  })
})
