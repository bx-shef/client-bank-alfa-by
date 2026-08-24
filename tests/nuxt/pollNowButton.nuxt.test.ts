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
    if (String(url).startsWith('/api/import/status')) return { lastFetchAt: null }
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

  it('503 говорит про недоступность обработки — и не обещает, что пройдёт само', async () => {
    // ⚠ Своего выключателя у ручного опроса больше нет (снят 2026-08-23): 503 значит «очередь
    // недоступна». Прежний текст «опрос отключён» отправлял админа искать несуществующую
    // настройку; обещание «повторите через пару минут» тоже неверно — Redis может быть не
    // настроен на этом контуре вовсе, и тогда ждать бессмысленно (находка ревью).
    answerPoll({ statusCode: 503 }, { reject: true })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    await nextTick()
    const err = wrapper.find('[data-testid="poll-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toMatch(/недоступ/i)
    expect(err.text(), 'снова говорим про выключатель, которого нет').not.toMatch(/отключ/i)
    expect(err.text(), 'обещаем, что пройдёт само — а может и не пройти').not.toMatch(/через пару минут/i)
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

describe('#19 забора за день здесь БОЛЬШЕ НЕТ — он переехал в строку подключения', () => {
  it('обычный опрос по-прежнему идёт без дня', async () => {
    answerPoll({ enqueued: 1, accounts: 1 })
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="poll-button"]').trigger('click')
    await flushPromises()
    const post = fetchMock.mock.calls.find(c => c[0] === '/api/poll-now')
    expect(post, 'обычный опрос не ушёл').toBeTruthy()
    expect(post![1]).toMatchObject({ body: {} })
  })

  it('поля дня в карточке ручного опроса нет', async () => {
    // ⚠ Инвариант, а не описание текущего вида. Здесь у забора не было АДРЕСА: он ставил задачу на
    // КАЖДЫЙ подключённый счёт портала, тогда как человек смотрел на конкретную строку и про неё
    // спрашивал — а лимит запросов тратился на счета, о которых не спрашивали. Вернуть поле сюда
    // «чтобы было под рукой» — значит вернуть безадресность.
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="poll-day-button"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'DayField' }).exists()).toBe(false)
  })
})

describe('исход не выдумывается (находки ревью #596)', () => {
  it('базовую отметку прочитать не удалось — исход НЕ показываем', async () => {
    // ⚠ Без базовой отметки любое существующее значение сойдёт за наш исход: человеку покажут
    // чужой прогон как итог его нажатия. Молчание тут честнее выдумки.
    vi.useFakeTimers()
    try {
      let asked = 0
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).startsWith('/api/import/status')) {
          asked++
          if (asked === 1) throw new Error('нет связи')
          return { lastFetchAt: '2026-07-01T08:00:00.000Z', lastFetchOps: 40 }
        }
        return { enqueued: 1, accounts: 1, day: '2026-07-10' }
      })
      // Проверяется логика ИСХОДА, а не выбор дня: она общая для обеих кнопок, и здесь дешевле
      // нажать обычный опрос — забор за день с #19 живёт в строке подключения.
      const wrapper = await mountReady()
      await wrapper.find('[data-testid="poll-button"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()
      await nextTick()
      expect(wrapper.find('[data-testid="poll-outcome"]').exists(), 'показали чужой прогон').toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('кнопки заблокированы, пока идёт ожидание исхода', async () => {
    // ⚠ `polling` гаснет сразу после ответа сервера, а ожидание живёт ещё до 90 с. Без блокировки
    // второе нажатие запускало бы второй цикл поверх первого, и они писали бы в один и тот же
    // текст — с чужим днём.
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).startsWith('/api/import/status')) return { lastFetchAt: null }
        return { enqueued: 1, accounts: 1 }
      })
      const wrapper = await mountReady()
      await wrapper.find('[data-testid="poll-button"]').trigger('click')
      await flushPromises()
      await nextTick()
      expect(wrapper.find('[data-testid="poll-button"]').attributes('disabled')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('несколько счетов — исход не выдумывается (ревью кода #596)', () => {
  it('при двух счетах итог НЕ объявляется: отметка одна на портал, а задач две', async () => {
    // ⚠ Отметка обращения к банку одна на портал, а задача ставится НА КАЖДЫЙ счёт. Пустой ответ
    // по первому счёту приходит раньше и был бы предъявлен как исход — «операций нет» о заборе,
    // который по второму счёту принёс сорок. Соврать про деньги хуже, чем промолчать.
    vi.useFakeTimers()
    try {
      let started = false
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).startsWith('/api/import/status')) {
          return started ? { lastFetchAt: '2026-07-10T10:00:00.000Z', lastFetchOps: 0 } : { lastFetchAt: null }
        }
        started = true
        return { enqueued: 2, accounts: 2, day: '2026-07-10' }
      })
      // Проверяется логика ИСХОДА, а не выбор дня: она общая для обеих кнопок, и здесь дешевле
      // нажать обычный опрос — забор за день с #19 живёт в строке подключения.
      const wrapper = await mountReady()
      await wrapper.find('[data-testid="poll-button"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()
      await nextTick()
      expect(wrapper.find('[data-testid="poll-outcome"]').exists(), 'объявили исход по одному из счетов').toBe(false)
      expect(wrapper.find('[data-testid="poll-message"]').exists(), 'молчим совсем — человек не знает, что задача ушла').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
