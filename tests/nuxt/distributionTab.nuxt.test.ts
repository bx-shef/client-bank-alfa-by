import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import DistributionTab from '~/components/DistributionTab.vue'

// Admin gate + render + load for the «Распределение» tab (#109 §9.3 #4). Mirrors provisionSpCard.
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
  const wrapper = await mountSuspended(DistributionTab)
  await flushPromises()
  await nextTick()
  await flushPromises()
  return wrapper
}

const card = { id: '1', total: 100, currency: 'BYN', requiresRedistribution: true, rows: [{ targetKind: 'invoice', targetId: '39', amount: 60, currency: 'BYN', source: 'auto', status: 'active' }] }

describe('DistributionTab admin gate', () => {
  it('in portal + NOT admin → nothing shown, no fetch', async () => {
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="distribution-tab"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('standalone → preview note, no fetch', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    fetchMock.mockResolvedValue({ provisioned: true, cards: [] })
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="ledger-preview-note"]').exists()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DistributionTab load', () => {
  it('admin in portal → fetches and renders cards', async () => {
    fetchMock.mockResolvedValueOnce({ provisioned: true, cards: [card] })
    const wrapper = await mountReady()
    expect(fetchMock).toHaveBeenCalledWith('/api/distribution/ledger', expect.objectContaining({ headers: expect.anything() }))
    expect(wrapper.find('[data-testid="ledger-cards"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('смарт-счёт #39')
    expect(wrapper.find('[data-testid="ledger-requires"]').exists()).toBe(true) // requiresRedistribution badge
  })

  it('not provisioned → setup prompt, no cards', async () => {
    fetchMock.mockResolvedValueOnce({ provisioned: false, cards: [] })
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="ledger-unprovisioned"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ledger-cards"]').exists()).toBe(false)
  })

  it('empty ledger → «пока нет» message', async () => {
    fetchMock.mockResolvedValueOnce({ provisioned: true, cards: [] })
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="ledger-empty"]').exists()).toBe(true)
  })

  it('403 → friendly admin error', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 403 })
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="ledger-error"]').text()).toContain('администратор')
  })

  it('«Пересчитать» → POSTs recompute then reloads, shows the count', async () => {
    fetchMock.mockResolvedValueOnce({ provisioned: true, cards: [card] }) // initial load
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="ledger-recompute"]').exists()).toBe(true)
    fetchMock.mockResolvedValueOnce({ ok: true, recomputed: 3 }) // recompute POST
    fetchMock.mockResolvedValueOnce({ provisioned: true, cards: [card] }) // reload
    await wrapper.find('[data-testid="ledger-recompute"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledWith('/api/distribution/recompute', expect.objectContaining({ method: 'POST' }))
    expect(wrapper.find('[data-testid="ledger-recompute-msg"]').text()).toContain('3')
  })
})
