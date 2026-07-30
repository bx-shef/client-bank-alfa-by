import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SetupReadinessCard from '~/components/SetupReadinessCard.vue'

// Wiring for the setup-readiness card (#409/#405). The pure checklist is covered in
// tests/setupReadiness.test.ts; what matters HERE is the plumbing that a pure test cannot see:
// that the card does not re-load chat settings behind the form's back (that clobbered edits), that
// it stays a preview outside the portal, and that it re-reads after a connect.

const mockState = { inPortal: true }

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => (mockState.inPortal ? { token: 'T', domain: 'd.bitrix24.by' } : null),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

const setupReply = { value: {} as Record<string, unknown> }
const fetchMock = vi.fn((url: string, _opts?: Record<string, unknown>) => {
  if (url === '/api/setup-status') return Promise.resolve(setupReply.value)
  // Any OTHER call is a bug in this component — see the chat-settings test below.
  return Promise.resolve({})
})
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  fetchMock.mockClear()
  setupReply.value = {}
  mockState.inPortal = true
})

async function mountReady() {
  const wrapper = await mountSuspended(SetupReadinessCard)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('SetupReadinessCard', () => {
  it('shows every unmet line for a fresh portal and counts what is left', async () => {
    setupReply.value = { connectedAccounts: 0, pollEnabled: false, pollIntervalMin: 5, lastRunMs: null }
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="readiness-bank"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="readiness-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="readiness-smart-process"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="readiness-poll"]').exists()).toBe(true)
    // Строк стало шесть (#421 добавил чат ошибок и карту распознавания) — счётчик считает ВСЕ
    // незакрытые, иначе он обещал бы готовность раньше, чем она наступит.
    expect(wrapper.find('[data-testid="readiness-badge"]').text()).toContain('6')
  })

  it('never re-loads chat settings — that would overwrite the admin\'s unsaved edits', async () => {
    // useChatSettings.load() is NOT idempotent: it ends in Object.assign(settings, serverCopy). The
    // parent form has already loaded them, so a second load here would silently discard whatever
    // the admin typed in the meantime.
    setupReply.value = { connectedAccounts: 1, pollEnabled: true, pollIntervalMin: 5, lastRunMs: null }
    await mountReady()
    const urls = fetchMock.mock.calls.map(c => c[0])
    expect(urls).toEqual(['/api/setup-status'])
  })

  it('outside the portal it is an explicit preview, not a confident «осталось: 4»', async () => {
    mockState.inPortal = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="readiness-preview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="readiness-badge"]').exists()).toBe(false)
  })

  it('re-reads on window focus, so a just-connected account stops reading «нет подключений»', async () => {
    setupReply.value = { connectedAccounts: 0, pollEnabled: true, pollIntervalMin: 5, lastRunMs: null }
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="readiness-bank"]').text()).toContain('нет подключений')

    // The bank tab is top-level and never notifies us; coming back to this tab is the only signal.
    setupReply.value = { connectedAccounts: 1, pollEnabled: true, pollIntervalMin: 5, lastRunMs: null }
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="readiness-bank"]').text()).toContain('1 счёт')
  })

  it('states the period instead of predicting a next-poll moment it cannot know', async () => {
    setupReply.value = { connectedAccounts: 1, pollEnabled: true, pollIntervalMin: 7, lastRunMs: null }
    const wrapper = await mountReady()
    const text = wrapper.text()
    expect(text).toContain('каждые 7 мин')
    // The cron is anchored to process boot, not to the last import — any «следующий в …» would be
    // a guess dressed as a fact.
    expect(text).not.toContain('Следующий')
  })

  it('calls a stamped run «импорт», not «опрос» (a manual upload stamps it too)', async () => {
    setupReply.value = { connectedAccounts: 0, pollEnabled: true, pollIntervalMin: 5, lastRunMs: Date.now() - 120_000 }
    const wrapper = await mountReady()
    expect(wrapper.text()).toContain('Последний импорт')
    expect(wrapper.text()).not.toContain('Последний опрос')
  })
})
