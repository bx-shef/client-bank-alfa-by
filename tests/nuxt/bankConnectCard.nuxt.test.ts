import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import BankConnectCard from '~/components/BankConnectCard.vue'

// Admin gate + render + connect interaction for the bank connect card (A7c). Drive it through a
// mocked useB24 (real SDK can't load in tests) and a mocked useFrameAuth (so `enabled` reflects
// in-portal). The gate is default-CLOSED — the card is withheld until the onMounted admin-check.
const mockState = { isInit: true, isAdmin: true }

// ⚠ `?preview=1` подставляет синтетическую сверку (`PREVIEW_BANK_MATRIX`). Компонент читает флаг из
// РОУТЕРА, а не из `window.location` (#555), поэтому мокаем именно роут. По умолчанию — пусто, то
// есть все прежние тесты идут прежним путём.
// ⚠ РЕАКТИВНЫЙ: гонка проверяется переключением флага ПОСЛЕ монтирования, а на голом объекте
// `computed` не пересчитался бы — тест «проверял» бы кэш и был бы зелёным при любом поведении.
const routeQuery = reactive<{ preview?: string }>({})
vi.mock('vue-router', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  useRoute: () => ({ query: routeQuery })
}))

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
// Сверка счетов (#494) грузится тем же монтированием и ходит В БАНК, поэтому у неё свой ответ:
// иначе composable молча получал бы connect-ответ и тест был бы зелёным при любом поведении.
const matrixReply = { value: { rows: [] as unknown[], providers: [] as unknown[] } }
/**
 * Реализация мока ПО УМОЛЧАНИЮ, вынесенная в именованную функцию.
 *
 * ⚠ Несколько тестов ниже зовут `fetchMock.mockImplementation(...)` — а он подменяет реализацию
 * НАСОВСЕМ, не только на свой тест. Дальше происходило ровно то, о чём предупреждает комментарий
 * у самого мока: вызовы записывались, а отвечал на них чужой сценарий. Возвращать умолчание в
 * `beforeEach` можно только тогда, когда оно вообще существует отдельно от `vi.fn(...)`.
 */
const defaultFetchImpl = (url: string, _opts?: Record<string, unknown>) => {
  if (url === '/api/bank/accounts') return Promise.resolve({ accounts: [] })
  if (url === '/api/bank/matrix') return Promise.resolve(matrixReply.value)
  if (url === '/api/setup-status') return Promise.resolve({ alfaClientId: 'CID-FOR-CABINET' })
  // ⚠ Маршрутов самостоятельного подключения больше нет (решение владельца 2026-09-17), поэтому
  // умолчание пустое: любой неучтённый адрес — это запрос, которого карточка делать не должна.
  return Promise.resolve({})
}
const fetchMock = vi.fn(defaultFetchImpl)
vi.stubGlobal('$fetch', fetchMock)

// ⚠ ФАЙЛОВЫЙ, а не точечный. Часть тестов зовёт `vi.unstubAllGlobals()` (им нужен свой `window.open`),
// и вместе с ним отваливается стаб `$fetch`. Дальше происходило худшее, что может сделать тест: он
// оставался ЗЕЛЁНЫМ, но проверял не то. Компонент ловил любую ошибку и рисовал ОБЩЕЕ «Не удалось
// начать подключение», assert на наличие ошибки срабатывал — а серверного текста, ради которого
// тест написан, никто не читал, и запроса вообще не было. Чинить это после каждого
// `unstubAllGlobals()` по месту значит ждать, пока кто-нибудь допишет тест и забудет.
beforeEach(() => {
  vi.stubGlobal('$fetch', fetchMock)
})

afterEach(() => {
  delete routeQuery.preview
  fetchMock.mockClear()
  matrixReply.value = { rows: [], providers: [] }
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

  it('in portal + admin → card with button, no account field, no warning, no preview note', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bank-connect"]').exists()).toBe(true)
    // ⚠ The account-number field is GONE, asserted explicitly. It misled: the admin typed an
    // IBAN and the bank's page never asked about an account, so the field looked like it steered
    // the bank's consent when it only ever labelled our row. The account is chosen after
    // returning, from the connected list.
    expect(wrapper.find('[data-testid="account-input"]').exists()).toBe(false)
    // ⚠ ЕДИНСТВЕННЫЙ ПУТЬ — передать подключение владельцу счёта (решение владельца 2026-09-17).
    expect(wrapper.find('[data-testid="hand-over-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="open-chat"]').exists()).toBe(true)
    // ⚠ И ОТРИЦАНИЕ по всем трём снятым элементам сразу: кнопка подключения у обоих банков и поле
    // ключа API. Проверять только один из них значило бы разрешить вернуть остальные — а вернуть
    // их «для удобства администратора» и есть самое естественное движение следующего автора.
    for (const gone of ['connect-key-button', 'connect-button', 'api-key-input', 'authorize-link']) {
      expect(wrapper.find(`[data-testid="${gone}"]`).exists(), gone).toBe(false)
    }
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

describe('выбор банка (пикер остался — он выбирает, ЧЬЮ инструкцию отправить)', () => {
  it('предлагает оба банка', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const w = await mountReady()
    const picker = w.find('[data-testid="provider-picker"]')
    expect(picker.exists()).toBe(true)
    expect(picker.text()).toContain('Альфа')
    expect(picker.text()).toContain('Приор')
  })
})

describe('BankConnectCard — сверка счетов внутри карточки (#494)', () => {
  it('карточка сама запрашивает сверку при открытии', async () => {
    await mountReady()
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/bank/matrix')).toHaveLength(1)
  })

  it('блок сверки отрисован, и проблемная строка видна с обеими сторонами', async () => {
    matrixReply.value = {
      rows: [{
        state: 'looks-same',
        crm: { companyId: '7', number: 'BY11 ALFA 0001' },
        bank: { number: 'BY11ALFA0001', provider: 'alfa-by' },
        connected: true
      }],
      providers: [{ provider: 'alfa-by', count: 1, error: null }]
    }
    const w = await mountReady()
    expect(w.find('[data-testid="account-matrix"]').exists()).toBe(true)
    expect(w.find('[data-testid="matrix-row-looks-same"]').exists()).toBe(true)
    expect(w.text()).toContain('BY11 ALFA 0001')
  })

  it('отказ банка доезжает до экрана отдельной тревогой', async () => {
    matrixReply.value = {
      rows: [],
      providers: [{ provider: 'alfa-by', count: 0, error: 'банк не ответил (503)' }]
    }
    const w = await mountReady()
    expect(w.find('[data-testid="matrix-provider-error-alfa-by"]').exists()).toBe(true)
  })

  it('сбой запроса сверки не роняет карточку — она остаётся на экране', async () => {
    fetchMock.mockImplementationOnce((url: string) => {
      if (url === '/api/bank/matrix') return Promise.reject(new Error('boom'))
      return Promise.resolve({ accounts: [] })
    })
    const w = await mountReady()
    expect(w.find('[data-testid="bank-connect"]').exists()).toBe(true)
  })
})

describe('BankConnectCard: синтетическая сверка под ?preview=1', () => {
  // ⚠ Вне портала матрица ВСЕГДА пуста (нет фрейм-токена), поэтому блок сверки не попадал ни в один
  // визуальный эталон. Фикстура закрывает эту дыру — и сама остаётся непроверенной, если её не
  // прикрыть здесь: находка ревью (у соседнего `ConnectedBankAccounts` теста тоже нет).

  it('фикстура рисуется, а сеть за ней не ходит', async () => {
    routeQuery.preview = '1'
    const w = await mountReady()
    expect(w.text()).toContain('BY00ALFA00000000000000000009')
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/bank/matrix')).toEqual([])
  })

  it('⚠ поздний ответ сети НЕ затирает фикстуру', async () => {
    // Гонка, ради которой `reloadMatrix()` перепроверяет флаг ПОСЛЕ `await`: на гидратации
    // пререндеренной страницы адрес восстанавливается позже монтирования (#555), поэтому запрос
    // успевает уйти и вернуться уже при активном превью. Без перепроверки экран схлопывался бы в
    // пустую сверку — и молча, потому что пустая сверка это законное состояние.
    type MatrixReply = { rows: unknown[], providers: unknown[] }
    let release: (v: MatrixReply) => void = () => {}
    const pending = new Promise<MatrixReply>(r => (release = r))
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/bank/accounts') return Promise.resolve({ accounts: [] })
      if (url === '/api/bank/matrix') return pending
      return Promise.resolve({})
    })
    const w = await mountReady()
    routeQuery.preview = '1'
    release({ rows: [], providers: [] })
    await flushPromises()
    await nextTick()
    expect(w.text()).toContain('BY00ALFA00000000000000000009')
  })

  it('⚠ упавший запрос не оставляет красную ошибку рядом с фикстурой', async () => {
    // Внутри портала сверка может честно отказать (403 не-админу, 409 до конца установки). Если
    // после этого включится превью, экран заявлял бы И отказ, И его результат разом.
    type MatrixReply = { rows: unknown[], providers: unknown[] }
    let reject: (e: unknown) => void = () => {}
    const pending = new Promise<MatrixReply>((_r, rj) => (reject = rj))
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/bank/accounts') return Promise.resolve({ accounts: [] })
      if (url === '/api/bank/matrix') return pending
      return Promise.resolve({})
    })
    const w = await mountReady()
    routeQuery.preview = '1'
    reject(new Error('403'))
    await flushPromises()
    await nextTick()
    expect(w.find('[data-testid="matrix-error"]').exists()).toBe(false)
    expect(w.text()).toContain('BY00ALFA00000000000000000009')
  })
})
