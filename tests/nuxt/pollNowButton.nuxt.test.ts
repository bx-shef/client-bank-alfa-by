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

/**
 * Ответ на POST /api/poll-now; чтение метки прогона (`/api/import/status`) обслуживается отдельно.
 *
 * ⚠ Мок по АДРЕСУ, а не по порядку вызовов: после того как кнопка научилась дожидаться исхода,
 * первым уходит чтение статуса, и очередь `mockResolvedValueOnce` доставалась не тому запросу —
 * тесты краснели на исправном коде и молчали бы о настоящей поломке.
 */
function answerPoll(reply: unknown, opts: { reject?: boolean } = {}): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/import/status')) return { lastSyncAt: null }
    if (opts.reject) throw reply
    return reply
  })
}

afterEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({})
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
    answerPoll({ enqueued: 2, accounts: 2, cooldownSec: 60 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledWith('/api/poll-now', expect.objectContaining({ method: 'POST' }))
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-error"]').exists()).toBe(false)
  })

  it('cooldown (429) → friendly error, no success', async () => {
    answerPoll({ statusCode: 429 }, { reject: true })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="poll-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(false)
  })

  it('503 → говорит про ВРЕМЕННУЮ недоступность, а не про «выключено»', async () => {
    // ⚠ Своего выключателя у ручного опроса больше нет (снят 2026-08-23): 503 теперь значит
    // «очередь недоступна» — сбой на нашей стороне, который сам пройдёт. Прежний текст «опрос
    // отключён» отправлял бы админа искать несуществующую настройку.
    answerPoll({ statusCode: 503 }, { reject: true })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const err = wrapper.find('[data-testid="poll-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toMatch(/недоступ/i)
    expect(err.text(), 'снова говорим про выключатель, которого нет').not.toMatch(/отключ/i)
    expect(wrapper.find('[data-testid="poll-message"]').exists()).toBe(false)
  })

  it('not admin (403) → friendly "администратор" error', async () => {
    answerPoll({ statusCode: 403 }, { reject: true })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="poll-error"]').text()).toContain('администратор')
  })

  it('no connected accounts → prompts to connect first', async () => {
    answerPoll({ enqueued: 0, accounts: 0 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const msg = wrapper.find('[data-testid="poll-message"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('подключите счёт')
  })
})

describe('забор за выбранный день (#592)', () => {
  it('без выбранного дня кнопка «Забрать» заблокирована — дата обязательна', async () => {
    // ⚠ Не «заберём за сегодня по умолчанию»: молчаливая подстановка дня означала бы, что человек
    // нажал кнопку, не выбрав то, ради чего она заведена, и получил не тот день.
    const wrapper = await mountReady()
    const btn = wrapper.find('[data-testid="poll-day-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('выбранный день уходит в запрос', async () => {
    answerPoll({ enqueued: 2, accounts: 2, day: '2026-07-10' })
    const wrapper = await mountReady()
    // Календарь — сторонний компонент; выбор дня выставляем через модель поля.
    const field = wrapper.findComponent({ name: 'DayField' })
    field.vm.$emit('update:modelValue', '2026-07-10')
    await nextTick()
    await wrapper.find('[data-testid="poll-day-button"]').trigger('click')
    await flushPromises()
    // ⚠ Ищем ИМЕННО вызов забора: рядом идут чтения `/api/import/status` (метка прогона до старта
    // и ожидание исхода), и привязка к порядку вызовов ломалась бы от любой правки этой логики.
    const post = fetchMock.mock.calls.find(c => c[0] === '/api/poll-now')
    expect(post, 'запрос на забор не ушёл вовсе').toBeTruthy()
    expect(post![1]).toMatchObject({ body: { day: '2026-07-10' } })
    expect(wrapper.find('[data-testid="poll-message"]').text()).toContain('2026-07-10')
  })

  it('обычный опрос по-прежнему идёт без дня', async () => {
    answerPoll({ enqueued: 1, accounts: 1 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    const post = fetchMock.mock.calls.find(c => c[0] === '/api/poll-now')
    expect(post, 'обычный опрос не ушёл').toBeTruthy()
    expect(post![1]).toMatchObject({ body: {} })
  })
})

describe('исход забора виден в портале (#592)', () => {
  /** Ответ статуса меняется после запуска — так выглядит завершившийся прогон. */
  function answerWithRun(run: { lastSyncAt: string, operations: number, activitiesCreated: number }): void {
    let started = false
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/import/status')) {
        return started ? run : { lastSyncAt: null }
      }
      started = true
      return { enqueued: 1, accounts: 1, day: '2026-07-10' }
    })
  }

  it('пустой ответ банка назван прямо, а не выдан за неработающую кнопку', async () => {
    // ⚠ Это и есть то, на чём застряла живая проверка: кнопка отвечала «опрос запущен» и молчала,
    // и «банк вернул ноль» снаружи неотличимо от «кнопка не работает». Пустой забор теперь пишет
    // след (worker), а интерфейс его читает.
    vi.useFakeTimers()
    try {
      answerWithRun({ lastSyncAt: '2026-07-10T10:00:00.000Z', operations: 0, activitiesCreated: 0 })
      const wrapper = await mountReady()
      const field = wrapper.findComponent({ name: 'DayField' })
      field.vm.$emit('update:modelValue', '2026-07-10')
      await nextTick()
      await wrapper.find('[data-testid="poll-day-button"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()
      await nextTick()
      const out = wrapper.find('[data-testid="poll-outcome"]')
      expect(out.exists(), 'исход не показан — кнопка снова молчит').toBe(true)
      expect(out.text()).toMatch(/операций.*нет/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ПРЕЖНИЙ прогон портала не выдаётся за исход этого забора', async () => {
    // ⚠ У портала почти всегда уже есть результат от планового опроса. Без сверки с меткой ДО
    // запуска интерфейс мгновенно показал бы ЕГО как итог нажатия — «пришло 40 операций» о том,
    // чего эта кнопка не делала. Мутация «не сверять метку» проходила зелёной, пока не было
    // этого теста.
    vi.useFakeTimers()
    try {
      const old = { lastSyncAt: '2026-07-01T08:00:00.000Z', operations: 40, activitiesCreated: 40 }
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).startsWith('/api/import/status')) return old
        return { enqueued: 1, accounts: 1, day: '2026-07-10' }
      })
      const wrapper = await mountReady()
      const field = wrapper.findComponent({ name: 'DayField' })
      field.vm.$emit('update:modelValue', '2026-07-10')
      await nextTick()
      await wrapper.find('[data-testid="poll-day-button"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      await nextTick()
      const out = wrapper.find('[data-testid="poll-outcome"]')
      const text = out.exists() ? out.text() : ''
      expect(text, 'показали чужой прогон как свой').not.toContain('40')
    } finally {
      vi.useRealTimers()
    }
  })

  it('пришедшие операции названы числом', async () => {
    vi.useFakeTimers()
    try {
      answerWithRun({ lastSyncAt: '2026-07-10T10:00:00.000Z', operations: 12, activitiesCreated: 9 })
      const wrapper = await mountReady()
      const field = wrapper.findComponent({ name: 'DayField' })
      field.vm.$emit('update:modelValue', '2026-07-10')
      await nextTick()
      await wrapper.find('[data-testid="poll-day-button"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()
      await nextTick()
      expect(wrapper.find('[data-testid="poll-outcome"]').text()).toContain('12')
    } finally {
      vi.useRealTimers()
    }
  })
})
