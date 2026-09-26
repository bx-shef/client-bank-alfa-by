import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SectionDistribution from '~/components/settings/SectionDistribution.vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'

// Раздел «Смарт-процессы» (#19): после провижининга журнал распределения обязан перечитаться сам.
// Живая находка владельца 2026-09-26: смарт-процессы созданы, карточка над журналом говорит
// «настроены», а журнал — «ещё не настроены», и так до перезагрузки страницы.
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
  Object.assign(useChatSettings().settings, defaultPortalSettings())
})

describe('SectionDistribution', () => {
  it('после успешного провижининга журнал перечитывается и перестаёт говорить «не настроены»', async () => {
    let provisioned = false
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/distribution/provision') {
        provisioned = true
        return { ok: true, paymentSpEtid: 1042, distributionSpEtid: 1044, created: true }
      }
      if (url === '/api/distribution/ledger') return { provisioned, cards: [] }
      return {}
    })
    const wrapper = await mountSuspended(SectionDistribution)
    await flushPromises()
    await nextTick()
    await flushPromises()
    expect(wrapper.find('[data-testid="ledger-unprovisioned"]').exists()).toBe(true)

    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    const ledgerReads = fetchMock.mock.calls.filter(c => c[0] === '/api/distribution/ledger')
    expect(ledgerReads).toHaveLength(2)
    expect(wrapper.find('[data-testid="ledger-unprovisioned"]').exists()).toBe(false)
  })
})
