import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ProvisionSpCard from '~/components/ProvisionSpCard.vue'

// Admin gate + render + provision interaction for the «Настроить смарт-процессы» button (#109 §9.1).
// Mirrors pollNowButton.nuxt.test.ts. Gate is default-CLOSED — withheld until the onMounted check.
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
  const wrapper = await mountSuspended(ProvisionSpCard)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('ProvisionSpCard admin gate', () => {
  it('in portal + admin → card with button', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="provision-sp"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provision-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provision-preview-note"]').exists()).toBe(false)
  })

  it('in portal + NOT admin → nothing shown', async () => {
    mockState.isInit = true
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="provision-sp"]').exists()).toBe(false)
  })

  it('standalone → preview card with preview note', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="provision-sp"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provision-preview-note"]').exists()).toBe(true)
  })
})

describe('ProvisionSpCard interaction', () => {
  it('clicking → posts and shows a created success message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, paymentSpEtid: 1044, distributionSpEtid: 1046, created: true, addedFields: 8, storedChanged: true })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledWith('/api/distribution/provision', expect.objectContaining({ method: 'POST' }))
    const msg = wrapper.find('[data-testid="provision-message"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('созданы')
    expect(wrapper.find('[data-testid="provision-error"]').exists()).toBe(false)
  })

  it('already provisioned (created:false) → "на месте" message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, paymentSpEtid: 1044, distributionSpEtid: 1046, created: false, addedFields: 0, storedChanged: false })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="provision-message"]').text()).toContain('на месте')
  })

  it('disabled (404) → friendly "отключена" error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 404 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const err = wrapper.find('[data-testid="provision-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('отключена')
    expect(wrapper.find('[data-testid="provision-message"]').exists()).toBe(false)
  })

  it('not admin (403) → friendly "администратор" error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 403 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="provision-error"]').text()).toContain('администратор')
  })

  it('not installed (409) → friendly "не установлено" error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 409 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="provision-error"]').text()).toContain('не установлено')
  })
})
