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
// Состояние опроса читается живьём (#576, находка ревью): предупреждение обязано различать
// «опрос идёт» и «опрос стоит», иначе оно одинаково в опасном и безопасном случае.
const pollState = { pollEnabled: true, connectedAccounts: 1, pausedAccounts: 0 }
vi.mock('~/composables/useSetupStatus', () => ({
  useSetupStatus: () => ({
    status: { value: pollState },
    loadedOk: { value: true },
    load: async () => {}
  })
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
  Object.assign(pollState, { pollEnabled: true, connectedAccounts: 1, pausedAccounts: 0 })
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

  it('опрос ИДЁТ — предупреждаем громко', async () => {
    // ⚠ Маркер дедупа живёт на самом деле: стирание при работающем опросе вернёт операции обратно,
    // и человек решит, что кнопка не работает.
    expect((await mountReady()).text()).toContain('Опрос банка сейчас работает')
  })

  it('все подключения на паузе — говорим, что стирать безопасно', async () => {
    // ⚠ Прежняя версия показывала один и тот же текст в обоих случаях. Предупреждение, одинаковое
    // в опасном и безопасном случае, не предупреждает ни о чём — его перестают читать.
    Object.assign(pollState, { pollEnabled: true, connectedAccounts: 2, pausedAccounts: 2 })
    expect((await mountReady()).text()).toContain('стирать безопасно')
  })

  it('опрос выключен на сервере — тоже безопасно', async () => {
    Object.assign(pollState, { pollEnabled: false, connectedAccounts: 2, pausedAccounts: 0 })
    expect((await mountReady()).text()).toContain('стирать безопасно')
  })

  it('часть на паузе, часть работает — это ОПАСНЫЙ случай', async () => {
    Object.assign(pollState, { pollEnabled: true, connectedAccounts: 3, pausedAccounts: 2 })
    expect((await mountReady()).text()).toContain('Опрос банка сейчас работает')
  })

  it('счёт контрагента (#591) доезжает до запроса подсчёта', async () => {
    const w = await mountReady()
    const ta = w.find('textarea')
    expect(ta.exists()).toBe(true)
    await ta.setValue('BY99PAYER0001')
    await nextTick()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    // Запрос ушёл с параметром counterpartyAccounts именно этого счёта.
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/activities/erasable') as unknown as [string, { query: { counterpartyAccounts?: string[] } }] | undefined
    expect(call).toBeTruthy()
    expect(call![1].query.counterpartyAccounts).toEqual(['BY99PAYER0001'])
  })

  it('слишком длинный счёт контрагента блокирует «Посчитать» и объясняет ошибку (#591)', async () => {
    const w = await mountReady()
    await w.find('textarea').setValue('x'.repeat(65))
    await nextTick()
    expect(w.text()).toContain('Слишком длинный номер счёта')
    // Кнопка «Посчитать» отключена — кривой ввод не должен уходить на сервер.
    const countBtn = w.findAll('button').find(b => b.text().includes('Посчитать')) as unknown as { attributes: (a: string) => string | undefined }
    expect(countBtn.attributes('disabled')).toBeDefined()
  })

  it('правка счёта контрагента СНИМАЕТ подтверждение (#591)', async () => {
    const w = await mountReady()
    await btn(w, 'Посчитать')!.trigger('click')
    await flushPromises()
    expect(btn(w, 'Да, стереть')).toBeTruthy()
    await w.find('textarea').setValue('BY99PAYER0001')
    await nextTick()
    expect(btn(w, 'Да, стереть')).toBeUndefined()
  })

  it('прямо говорит, что элементы смарт-процесса НЕ стираются', async () => {
    // ⚠ Текст рядом перечисляет, чего мы не трогаем у клиента; молчание про наш же смарт-процесс
    // на этом фоне читалось бы как «его тоже стёрли». А выходит наоборот.
    expect((await mountReady()).text()).toContain('Элементы смарт-процесса')
  })
})
