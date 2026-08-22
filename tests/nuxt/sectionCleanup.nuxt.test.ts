import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SectionCleanup from '~/components/settings/SectionCleanup.vue'

// Раздел «Очистка» (#576 п.4). Проверяется главное обещание: удалить можно ТОЛЬКО после того, как
// человеку назвали число, и любое изменение отбора это обещание снимает.

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => ({ token: 'T', domain: 'd.bitrix24.by' }),
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))
vi.mock('~/composables/useIsAdmin', () => ({
  useIsAdmin: () => ({ isAdmin: { value: true }, inPortal: { value: true }, check: () => {} })
}))

const counted = { value: { count: 7, capped: false } }
const fetchMock = vi.fn((url: string) => {
  if (url === '/api/bank/accounts') {
    return Promise.resolve({ accounts: [{ id: 1, provider: 'alfa-by', accountKey: 'BY01ALFA', connectedAt: 0, expiresAt: 0, hasRefresh: true, pollPaused: false }] })
  }
  if (url === '/api/activities/erasable') return Promise.resolve(counted.value)
  return Promise.resolve({ deleted: 7, remaining: 0 })
})
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  fetchMock.mockClear()
  counted.value = { count: 7, capped: false }
})

async function mountReady() {
  const w = await mountSuspended(SectionCleanup)
  await flushPromises()
  await nextTick()
  return w
}

const btn = (w: { findAll: (s: string) => { text: () => string, trigger: (e: string) => Promise<void> }[] }, label: string) =>
  w.findAll('button').find(b => b.text().includes(label))

describe('раздел «Очистка» (#576 п.4)', () => {
  it('кнопки стирания НЕТ, пока не посчитали', async () => {
    // ⚠ Главное обещание: необратимое действие недоступно, пока человеку не назвали число.
    const w = await mountReady()
    expect(btn(w, 'Да, стереть')).toBeUndefined()
    expect(btn(w, 'Посчитать')).toBeTruthy()
  })

  it('после подсчёта показывает число и только тогда даёт стереть', async () => {
    const w = await mountReady()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Под удаление попадёт дел: 7')
    expect(btn(w, 'Да, стереть')).toBeTruthy()
  })

  it('«ничего не нашлось» — это НЕ приглашение стереть', async () => {
    counted.value = { count: 0, capped: false }
    const w = await mountReady()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Стирать нечего')
    expect(btn(w, 'Да, стереть')).toBeUndefined()
  })

  it('смена отбора СНИМАЕТ подтверждение', async () => {
    // ⚠ Посчитанное число относилось к прежнему отбору. Оставить кнопку значило бы предложить
    // стереть не то, что обещано, — и это необратимо.
    const w = await mountReady()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    expect(btn(w, 'Да, стереть')).toBeTruthy()
    await btn(w, 'BY01ALFA')!.trigger('click') // выбрали счёт → отбор изменился
    await nextTick()
    expect(btn(w, 'Да, стереть')).toBeUndefined()
  })

  it('стирание уходит на СВОЙ маршрут, а подсчёт — на свой', async () => {
    // Два разных маршрута, а не флаг: подсчёт структурно не умеет удалять.
    const w = await mountReady()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    await btn(w, 'Да, стереть')!.trigger('click')
    await flushPromises()
    const urls = fetchMock.mock.calls.map(c => c[0])
    expect(urls).toContain('/api/activities/erasable')
    expect(urls).toContain('/api/activities/erase')
    expect(w.text()).toContain('Удалено дел: 7')
  })

  it('предупреждает, что сперва надо приостановить опрос', async () => {
    // ⚠ Маркер дедупа живёт на самом деле: стирание при работающем опросе вернёт операции обратно,
    // и человек решит, что кнопка не работает.
    expect((await mountReady()).text()).toContain('приостановите опрос')
  })
})
