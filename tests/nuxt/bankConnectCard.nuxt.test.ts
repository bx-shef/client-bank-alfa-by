import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import BankConnectCard from '~/components/BankConnectCard.vue'

// Admin gate + render + connect interaction for the bank connect card (A7c). Drive it through a
// mocked useB24 (real SDK can't load in tests) and a mocked useFrameAuth (so `enabled` reflects
// in-portal). The gate is default-CLOSED — the card is withheld until the onMounted admin-check.
const mockState = { isInit: true, isAdmin: true }

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => mockState.isInit, isAdmin: mockState.isAdmin }) }
})

// In-portal ⇒ a frame token exists (enabled=true, no preview note); standalone ⇒ null.
vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => (mockState.isInit ? { token: 'T', domain: 'd.bitrix24.by' } : null),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

// The card now also loads the connected-accounts list on mount (#404), so the $fetch mock must
// route BY URL rather than by call order — an order-based mock would hand the accounts request the
// connect response (and vice versa) depending on which fired first.
const connectReply = { value: {} as Record<string, unknown> }
const fetchMock = vi.fn((url: string) => {
  if (url === '/api/bank/accounts') return Promise.resolve({ accounts: [] })
  return Promise.resolve(connectReply.value)
})
vi.stubGlobal('$fetch', fetchMock)

/** The reply /api/bank/connect should give for this test. */
function replyConnect(reply: Record<string, unknown>) {
  connectReply.value = reply
}

/** Calls the component made to /api/bank/connect (ignoring the accounts load). */
function connectCalls() {
  return fetchMock.mock.calls.filter(c => c[0] === '/api/bank/connect')
}

afterEach(() => {
  fetchMock.mockClear()
  connectReply.value = {}
  mockState.isInit = true
  mockState.isAdmin = true
})

async function mountReady() {
  const wrapper = await mountSuspended(BankConnectCard)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('BankConnectCard admin gate', () => {
  it('in portal + NOT admin → warning, card hidden', async () => {
    mockState.isInit = true
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bank-connect"]').exists()).toBe(false)
  })

  it('in portal + admin → card with input + button, no warning, no preview note', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bank-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connect-button"]').exists()).toBe(true)
    // In a real portal frame there IS a token → no "preview only" note.
    expect(wrapper.find('[data-testid="preview-note"]').exists()).toBe(false)
  })

  it('outside the portal (standalone) → card shown as preview (no token → preview note)', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bank-connect"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="preview-note"]').exists()).toBe(true)
  })
})

describe('BankConnectCard connect interaction', () => {
  it('clicking connect opens the bank tab synchronously and points it at the authorize URL', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    replyConnect({ authorizeUrl: 'https://alfa/authorize?s=1' })
    // Fake window the component navigates after the fetch resolves.
    const fakeWin = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const openSpy = vi.fn(() => fakeWin as unknown as Window)
    vi.stubGlobal('open', openSpy)

    const wrapper = await mountReady()
    await wrapper.find('[data-testid="account-input"]').setValue('BY13ALFA')
    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    // Opened synchronously as a blank tab (popup-blocker safe), then navigated to the URL.
    expect(openSpy).toHaveBeenCalledWith('', '_blank')
    expect(fakeWin.location.href).toBe('https://alfa/authorize?s=1')
    expect(fakeWin.opener).toBeNull() // opener severed (anti-tabnabbing)
    expect(wrapper.find('[data-testid="connect-started"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connect-error"]').exists()).toBe(false)
    vi.unstubAllGlobals()
  })

  it('shows an error and closes the blank tab when the backend rejects', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    replyConnect({ error: 'provider not available' })
    const fakeWin = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => fakeWin as unknown as Window))

    const wrapper = await mountReady()
    await wrapper.find('[data-testid="account-input"]').setValue('BY13ALFA')
    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="connect-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connect-started"]').exists()).toBe(false)
    expect(fakeWin.close).toHaveBeenCalled() // blank tab dropped on failure
    vi.unstubAllGlobals()
  })

  it('offers both banks and sends the SELECTED provider (Prior) to the backend', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    replyConnect({ authorizeUrl: 'https://prior/authorize?s=1' })
    const fakeWin = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => fakeWin as unknown as Window))
    vi.stubGlobal('$fetch', fetchMock) // earlier tests unstubAllGlobals(), which drops the $fetch stub

    const wrapper = await mountReady()
    // Both online-connectable banks are offered; the button follows the choice.
    expect(wrapper.find('[data-testid="provider-picker"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Приорбанк')
    expect(wrapper.find('[data-testid="connect-button"]').text()).toContain('Альфа-Банк') // default

    // Pick Prior (b24ui RadioGroup renders reka-ui role=radio controls, one per item).
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios).toHaveLength(2)
    await radios[1]!.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="connect-button"]').text()).toContain('Приорбанк')

    await wrapper.find('[data-testid="account-input"]').setValue('BY13PJCB')
    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    // The backend got prior-by (not the alfa-by default).
    const body = (connectCalls()[0]![1] as { body: { provider: string, accountKey: string } }).body
    expect(body.provider).toBe('prior-by')
    expect(body.accountKey).toBe('BY13PJCB')
    vi.unstubAllGlobals()
  })
})
