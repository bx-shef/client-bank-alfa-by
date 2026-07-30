import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConnectedBankAccounts from '~/components/ConnectedBankAccounts.vue'
import { provisionalAccountKey } from '~/utils/bankAccountKey'

// Список подключений (#404) + привязка счёта к подключению, сделанному без него (#407).
// Проверяется проводка, которую чистые тесты не видят: что «висящее» подключение выглядит как
// требующее действия, а не как обычное, и что отправляется именно временный ключ.

const mockState = { inPortal: true }

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => (mockState.inPortal ? { token: 'T', domain: 'd.bitrix24.by' } : null),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

const listReply = { value: [] as Record<string, unknown>[] }
const fetchMock = vi.fn((url: string, _opts?: Record<string, unknown>) => {
  if (url === '/api/bank/accounts') return Promise.resolve({ accounts: listReply.value })
  return Promise.resolve({ ok: true })
})
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  fetchMock.mockClear()
  listReply.value = []
  mockState.inPortal = true
})

async function mountReady() {
  const wrapper = await mountSuspended(ConnectedBankAccounts)
  await flushPromises()
  await nextTick()
  return wrapper
}

const PENDING = provisionalAccountKey('nonce1')

describe('ConnectedBankAccounts', () => {
  it('пустой портал говорит об этом словами, а не пустотой', async () => {
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(true)
  })

  it('показывает подключённый счёт и банк', async () => {
    listReply.value = [{ provider: 'alfa-by', accountKey: 'BY01ALFA0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    expect(wrapper.text()).toContain('Альфа-Банк')
    expect(wrapper.text()).toContain('BY01ALFA0001')
  })

  it('подключение без счёта помечено и просит выбрать номер (#407)', async () => {
    listReply.value = [{ provider: 'alfa-by', accountKey: PENDING, connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    expect(wrapper.text()).toContain('счёт не выбран')
    expect(wrapper.find('[data-testid="pending-alfa-by"]').exists()).toBe(true)
    // Временный ключ служебный: его не должно быть НИ в тексте, НИ в атрибутах (aria-label
    // раньше подставлял его в подпись кнопки, и text() этого не ловил).
    expect(wrapper.html()).not.toContain(PENDING)
  })

  it('привязка отправляет ВРЕМЕННЫЙ ключ и новый номер, затем перечитывает список', async () => {
    listReply.value = [{ provider: 'alfa-by', accountKey: PENDING, connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="pending-alfa-by"] input').setValue('BY01ALFA0002')
    await wrapper.find('[data-testid="pending-alfa-by"] button').trigger('click')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => c[0] === '/api/bank/set-account')
    expect(call).toBeTruthy()
    expect((call![1] as { body: Record<string, string> }).body).toEqual({
      provider: 'alfa-by', pendingKey: PENDING, accountKey: 'BY01ALFA0002'
    })
    // Сервер — источник правды: после привязки список перечитывается, а не правится локально.
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/bank/accounts')).toHaveLength(2)
  })

  it('отключение требует подтверждения вторым кликом', async () => {
    listReply.value = [{ provider: 'alfa-by', accountKey: 'BY01ALFA0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1]!.trigger('click')
    await nextTick()
    // Первый клик только спрашивает — запроса на удаление ещё нет.
    expect(wrapper.text()).toContain('Отключить?')
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/bank/disconnect')).toBe(false)
  })
})
