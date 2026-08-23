import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ProvisionSpCard from '~/components/ProvisionSpCard.vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'

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
  // Настройки — синглтон: без сброса «уже настроено» из одного теста протекло бы в следующий.
  Object.assign(useChatSettings().settings, defaultPortalSettings())
})

/** Пометить смарт-процессы уже созданными — как это делает провижининг, записывая их id в настройки. */
function markProvisioned() {
  useChatSettings().settings.recognition.configFields = {
    'payment-sp': '1046',
    'payment-sp-id': '46',
    'distribution-sp': '1048',
    'distribution-sp-id': '48'
  }
}

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

  it('404 больше не значит «отключено» — маршрут есть всегда', async () => {
    // ⚠ Ветку «отключена» убрали вместе с env-гейтом (2026-08-23): смарт-процесс «Платежи» это
    // реестр, а не опция, и режим приложения всегда «включено». Оставить прежний текст значило бы
    // отправлять админа искать переключатель, которого больше нет, — а 404 теперь означает ровно
    // то, что означает обычно: маршрута не нашлось (кривой прокси, старая сборка).
    fetchMock.mockRejectedValueOnce({ statusCode: 404 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="provision-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const err = wrapper.find('[data-testid="provision-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).not.toContain('отключена')
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

// Уже настроенное состояние (#409 follow-up): предлагать действие, которое выполнено, — значит
// заставлять гадать, надо ли его нажимать. Голые id («платежи 1046») пользователю тоже ничего не
// говорят, поэтому вместо них — ссылки внутрь смарт-процессов.
describe('ProvisionSpCard — когда всё уже настроено', () => {
  it('кнопки настройки нет, есть подтверждение и ссылки на смарт-процессы', async () => {
    markProvisioned()
    const wrapper = await mountReady()

    expect(wrapper.find('[data-testid="provision-ready"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provision-button"]').exists()).toBe(false)

    const payment = wrapper.find('[data-testid="sp-link-Платежи"]')
    const distribution = wrapper.find('[data-testid="sp-link-Распределения"]')
    // ⚠ Адрес ПОРТАЛА, а не приложения: относительный путь браузер отрезолвил бы на
    // bank-import…/crm/type/… и увёл бы пользователя в 404 (живая находка владельца).
    expect(payment.attributes('href')).toBe('https://example.bitrix24.by/crm/type/1046/list/category/0/')
    expect(distribution.attributes('href')).toBe('https://example.bitrix24.by/crm/type/1048/list/category/0/')
  })

  it('пока не настроено — наоборот: кнопка есть, ссылок нет', async () => {
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="provision-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provision-ready"]').exists()).toBe(false)
  })
})
