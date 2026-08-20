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
    // Новые строки (#421) должны РЕНДЕРИТЬСЯ, а не просто попасть в счётчик: иначе бейдж показал
    // бы 6, а админ не увидел бы, чего именно не хватает.
    expect(wrapper.find('[data-testid="readiness-error-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="readiness-recognition"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Добавьте шаблоны номеров')
    // Строк стало шесть (#421 добавил чат ошибок и карту распознавания) — счётчик считает ВСЕ
    // незакрытые, иначе он обещал бы готовность раньше, чем она наступит.
    //
    // ⚠ Проверяем ТЕКСТ карточки, а не отдельный бейдж: носитель счётчика уже сменился (бейдж →
    // подпись карточки), и тест, державшийся за элемент, покраснел на правке вёрстки, хотя
    // проверяемое им решение не менялось. Держимся за смысл — «карточка называет, сколько осталось».
    expect(wrapper.find('[data-testid="setup-readiness"]').text()).toContain('осталось: 6')
  })

  it('never re-loads chat settings — that would overwrite the admin\'s unsaved edits', async () => {
    // useChatSettings.load() is NOT idempotent: it ends in Object.assign(settings, serverCopy). The
    // parent form has already loaded them, so a second load here would silently discard whatever
    // the admin typed in the meantime.
    //
    // ⚠ Утверждаем ОТСУТСТВИЕ настроек, а не точный список запросов. Список делал тест
    // порядко-зависимым: карточка носит виджет отзыва (#499), тот на маунте прощупывает канал —
    // и `/api/feedback` появлялся или не появлялся в зависимости от того, успел ли предыдущий тест
    // в этом же файле «выжечь» модульный кэш `enabled`. Запусти этот тест в одиночку — красный,
    // хотя проверяемое им поведение не менялось.
    setupReply.value = { connectedAccounts: 1, pollEnabled: true, pollIntervalMin: 5, lastRunMs: null }
    await mountReady()
    const urls = fetchMock.mock.calls.map(c => c[0])
    expect(urls).not.toContain('/api/chat-settings')
    expect(urls).toContain('/api/setup-status')
  })

  it('outside the portal it is an explicit preview, not a confident «осталось: 4»', async () => {
    mockState.inPortal = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="readiness-preview"]').exists()).toBe(true)
    // Никакого уверенного счётчика: данных о портале снаружи нет, и «осталось: N» было бы
    // утверждением о том, чего мы не спрашивали.
    expect(wrapper.find('[data-testid="setup-readiness"]').text()).not.toContain('осталось:')
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

describe('SetupReadinessCard — «не понимаю, чего от меня хотят» (#499)', () => {
  it('несёт виджет отзыва: это единственный экран, где застревают не на платеже, а на задаче', async () => {
    // ⚠ Проверяем РАЗМЕТКУ, а не факт запроса к `/api/feedback`: прощупывание канала — модульный
    // синглтон, оно срабатывает один раз на файл, и assert по нему был бы зелёным или красным в
    // зависимости от того, какой тест выполнился раньше. Ровно та порядко-зависимость, которую
    // пришлось чинить этажом выше.
    setupReply.value = { connectedAccounts: 0, pollEnabled: false, pollIntervalMin: 5, lastRunMs: null }
    const wrapper = await mountReady()
    expect(wrapper.findComponent({ name: 'FeedbackWidget' }).exists()).toBe(true)
  })
})

describe('SetupReadinessCard — сбой чтения состояния', () => {
  it('не выдумывает состояние по дефолтам: ни чек-листа, ни расписания, ни «осталось: N»', async () => {
    // `/api/setup-status` admin-only и легко отвечает 403 или падает. Дефолты композейбла —
    // нули, поэтому и чек-лист, и строка расписания читались бы как уверенный диагноз
    // настроенному порталу: красное «Банк подключён», «Автоматический опрос выключен».
    fetchMock.mockImplementation((url: string) => (url === '/api/setup-status'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({})))
    const wrapper = await mountReady()
    const text = wrapper.text()

    expect(wrapper.find('[data-testid="readiness-error"]').exists()).toBe(true)
    expect(text).not.toContain('Автоматический опрос банков выключен')
    expect(text).not.toContain('осталось:')
    expect(wrapper.find('[data-testid="readiness-bank"]').exists()).toBe(false)
  })

  it('оставляет подвал карточки — там живёт форма обратной связи, на которую ссылается ошибка', async () => {
    // Сам виджет включается серверным гейтом канала и в тестовой среде выключен; проверяем, что
    // подвал не схлопнут целиком — иначе текст ошибки отсылал бы к форме, которой на экране нет.
    fetchMock.mockImplementation((url: string) => (url === '/api/setup-status'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({})))
    const wrapper = await mountReady()
    expect(wrapper.find('[data-slot="footer"]').exists()).toBe(true)
  })
})
