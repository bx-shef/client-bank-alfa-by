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
const connectReply = { value: {} as Record<string, unknown> }
// Сверка счетов (#494) грузится тем же монтированием и ходит В БАНК, поэтому у неё свой ответ:
// иначе composable молча получал бы connect-ответ и тест был бы зелёным при любом поведении.
const matrixReply = { value: { rows: [] as unknown[], providers: [] as unknown[] } }
const keyReply = { value: { connected: true } as Record<string, unknown> }
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
  if (url === '/api/bank/connect-key') return Promise.resolve(keyReply.value)
  if (url === '/api/setup-status') return Promise.resolve({ alfaClientId: 'CID-FOR-CABINET' })
  return Promise.resolve(connectReply.value)
}
const fetchMock = vi.fn(defaultFetchImpl)
vi.stubGlobal('$fetch', fetchMock)

/** The reply /api/bank/connect should give for this test. */
function replyConnect(reply: Record<string, unknown>) {
  connectReply.value = reply
}

/** Calls the component made to /api/bank/connect (ignoring the accounts load). */
function connectCalls() {
  return fetchMock.mock.calls.filter(c => c[0] === '/api/bank/connect')
}

/** Вызовы подключения КЛЮЧОМ (#488) — отдельный маршрут, отдельная механика. */
function keyCalls() {
  return fetchMock.mock.calls.filter(c => c[0] === '/api/bank/connect-key')
}

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
  connectReply.value = {}
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

/** Выбрать Приора: поход в банк остался только у него (#488), у Альфы — ключ API. */
async function pickPrior(wrapper: Awaited<ReturnType<typeof mountReady>>) {
  const radios = wrapper.findAll('[role="radio"]')
  expect(radios).toHaveLength(2)
  await radios[1]!.trigger('click')
  await nextTick()
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
    // ⚠ У Альфы теперь КЛЮЧ API, а не поход в банк (#488): Code Grant измеренно непригоден без
    // человека — цепочка refresh живёт 10 часов от авторизации и не продлевается ничем.
    expect(wrapper.find('[data-testid="connect-key-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="api-key-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connect-button"]').exists()).toBe(false)
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
    // ⚠ Поход в банк остался только у Приора: у него Open Banking, и другого пути нет (#488).
    replyConnect({ authorizeUrl: 'https://prior/authorize?s=1' })
    // Fake window the component navigates after the fetch resolves.
    const fakeWin = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const openSpy = vi.fn(() => fakeWin as unknown as Window)
    vi.stubGlobal('open', openSpy)

    const wrapper = await mountReady()
    await pickPrior(wrapper)
    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    // Opened synchronously as a blank tab (popup-blocker safe), then navigated to the URL.
    expect(openSpy).toHaveBeenCalledWith('', '_blank')
    expect(fakeWin.location.href).toBe('https://prior/authorize?s=1')
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
    await pickPrior(wrapper)
    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    // ⚠ Проверяем, что дошли ДО сервера и показали ЕГО причину. Раньше здесь стоял голый
    // «ошибка есть» — и он был зелёным ровно потому, что стаб `$fetch` отвалился этажом выше:
    // запроса не было вовсе, компонент рисовал общее «Не удалось начать подключение», а тест
    // рапортовал об успехе. Assert, который нельзя провалить, охраняет не код, а сам себя.
    expect(connectCalls()).toHaveLength(1)
    expect(wrapper.find('[data-testid="connect-error"]').text()).toContain('provider not available')
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
    // ⚠ По умолчанию выбрана Альфа, и у неё СВОЯ кнопка — ключ API, а не поход в банк.
    expect(wrapper.find('[data-testid="connect-key-button"]').text()).toContain('Альфа-Банк')
    expect(wrapper.find('[data-testid="connect-button"]').exists()).toBe(false)

    // Pick Prior (b24ui RadioGroup renders reka-ui role=radio controls, one per item).
    await pickPrior(wrapper)
    expect(wrapper.find('[data-testid="connect-button"]').text()).toContain('Приорбанк')
    expect(wrapper.find('[data-testid="api-key-input"]').exists()).toBe(false)

    await wrapper.find('[data-testid="connect-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    // The backend got prior-by (not the alfa-by default).
    const body = (connectCalls()[0]![1] as { body: { provider: string, accountKey: string } }).body
    expect(body.provider).toBe('prior-by')
    // The account number goes out EMPTY — the server lands the connection under a provisional
    // key and the account is picked from the list, where it is already visible. The route's
    // contract did not change.
    expect(body.accountKey).toBe('')
    vi.unstubAllGlobals()
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

  it('сбой запроса сверки не роняет карточку — форма подключения остаётся рабочей', async () => {
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
      return Promise.resolve(connectReply.value)
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
      return Promise.resolve(connectReply.value)
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

describe('#488 подключение Альфы ключом API', () => {
  // ⚠ Пере-стабливаем `$fetch` на КАЖДЫЙ тест: соседние зовут `vi.unstubAllGlobals()` ради своего
  // `window.open`, и вместе с ним отваливается стаб. Без этого тесты оставались бы ЗЕЛЁНЫМИ,
  // проверяя не то, — ровно тот случай, о котором предупреждает комментарий у самого мока.
  beforeEach(() => {
    vi.stubGlobal('$fetch', fetchMock)
    fetchMock.mockClear()
    fetchMock.mockImplementation(defaultFetchImpl)
  })

  it('ключ уходит В ТЕЛЕ POST и стирается из поля после успеха', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    keyReply.value = { connected: true }
    const wrapper = await mountReady()

    const input = wrapper.find('[data-testid="api-key-input"]')
    await input.setValue('  SECRET-KEY-123  ')
    await wrapper.find('[data-testid="connect-key-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(keyCalls()).toHaveLength(1)
    const opts = keyCalls()[0]![1] as { method: string, body: { provider: string, apiKey: string } }
    expect(opts.method).toBe('POST')
    expect(opts.body.provider).toBe('alfa-by')
    expect(opts.body.apiKey).toBe('  SECRET-KEY-123  ')
    // ⚠ Ключ бессрочный, а форма живёт в открытой вкладке портала — после успеха поле обязано
    // опустеть, иначе он остаётся на экране до закрытия настроек.
    expect((wrapper.find('[data-testid="api-key-input"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="key-connected"]').exists()).toBe(true)
  })

  it('кнопка не нажимается, пока поле пустое', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    const btn = wrapper.find('[data-testid="connect-key-button"]')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('поле ключа — типа password: он бессрочный и виден через плечо', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="api-key-input"]').attributes('type')).toBe('password')
  })

  it('показан наш client_id — вписать его в кабинете банка больше неоткуда', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect((wrapper.find('[data-testid="alfa-client-id"]').element as HTMLInputElement).value)
      .toBe('CID-FOR-CABINET')
    // Инструкция говорит словами кабинета, а не пересказом: человек сверяет её глазами с экраном.
    expect(wrapper.text()).toContain('Open API')
    expect(wrapper.text()).toContain('Постоянный ключ')
  })

  it('банк не принял ключ — ошибка на экране, поле НЕ очищено', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    keyReply.value = { error: 'банк не принял ключ API' }
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="api-key-input"]').setValue('BAD')
    await wrapper.find('[data-testid="connect-key-button"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="connect-error"]').text()).toContain('не принял ключ')
    // ⚠ Поле не трогаем: очистив его, мы заставили бы снова идти в кабинет банка за тем же ключом.
    expect((wrapper.find('[data-testid="api-key-input"]').element as HTMLInputElement).value).toBe('BAD')
    expect(wrapper.find('[data-testid="key-connected"]').exists()).toBe(false)
    keyReply.value = { connected: true }
  })
})
