import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConnectedBankAccounts from '~/components/ConnectedBankAccounts.vue'
import { provisionalAccountKey } from '~/utils/bankAccountKey'
import type { BankSideAccount } from '~/utils/bankAccountMatrix'

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

describe('ConnectedBankAccounts — состояние подключения (#488)', () => {
  // Прежде строка говорила только «подключён N назад», а единственное поле про сроки —
  // `expiresAt` — описывает ACCESS-токен. Из-за этого мёртвое подключение выглядело здоровым:
  // access свежий, refresh за ним уже не существует. Бейдж считает по ВОЗРАСТУ ПАРЫ.
  const HOUR = 3_600_000
  const row = (over: Record<string, unknown>) => ({
    provider: 'alfa-by', accountKey: 'BY01ALFA0001',
    connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true, ...over
  })

  it('в полосе обновления — «скоро обновим»', async () => {
    listReply.value = [row({ connectedAt: Date.now() - 9 * HOUR })]
    expect((await mountReady()).text()).toContain('скоро обновим')
  })

  it('старше срока жизни — «подключение истекло»', async () => {
    listReply.value = [row({ connectedAt: Date.now() - 11 * HOUR })]
    expect((await mountReady()).text()).toContain('подключение истекло')
  })

  it('без refresh-токена — «нужно переподключить», даже если подключение свежее', async () => {
    listReply.value = [row({ hasRefresh: false })]
    expect((await mountReady()).text()).toContain('нужно переподключить')
  })

  it('исправное подключение бейджа НЕ получает — иначе значки перестают читать', async () => {
    listReply.value = [row({})]
    const t = (await mountReady()).text()
    expect(t).not.toContain('скоро обновим')
    expect(t).not.toContain('подключение истекло')
    expect(t).not.toContain('нужно переподключить')
  })

  it('подсказка доезжает до разметки — бейдж без объяснения бесполезен', async () => {
    listReply.value = [row({ connectedAt: Date.now() - 11 * HOUR })]
    const hint = (await mountReady()).find('[title]').attributes('title')
    expect(hint).toContain('интернет-банк')
  })
})

describe('ConnectedBankAccounts — выбор счёта из ответа банка (#494)', () => {
  // Раньше номер счёта надо было ПЕРЕПЕЧАТАТЬ (28 знаков IBAN), и опечатка не давала никакой
  // ошибки: опрос шёл по номеру, которого у банка нет, а операции не приземлялись. Банк сам
  // называет свои счета — значит выбор должен быть кликом.
  const pendingRow = {
    provider: 'alfa-by', accountKey: PENDING,
    connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true
  }

  async function mountWithBank(bankAccounts: BankSideAccount[]) {
    const wrapper = await mountSuspended(ConnectedBankAccounts, { props: { bankAccounts } })
    await flushPromises()
    await nextTick()
    return wrapper
  }

  it('счета банка предлагаются кнопками рядом с ожидающим подключением', async () => {
    listReply.value = [pendingRow]
    const w = await mountWithBank([{ number: 'BY11ALFA0001', currency: 'BYN', provider: 'alfa-by' }])
    const chips = w.find('[data-testid="account-suggestions"]')
    expect(chips.exists()).toBe(true)
    expect(chips.text()).toContain('BY11ALFA0001')
    expect(chips.text()).toContain('BYN')
  })

  it('клик по счёту привязывает ИМЕННО его, отправляя временный ключ', async () => {
    listReply.value = [pendingRow]
    const w = await mountWithBank([{ number: 'BY11ALFA0001', provider: 'alfa-by' }])
    await w.find('[data-testid="account-suggestions"] button').trigger('click')
    await flushPromises()
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/bank/set-account')
    expect(call).toBeTruthy()
    expect((call?.[1] as { body: Record<string, string> }).body).toMatchObject({
      provider: 'alfa-by', pendingKey: PENDING, accountKey: 'BY11ALFA0001'
    })
  })

  it('уже привязанный счёт повторно не предлагается — сервер ответил бы 409', async () => {
    listReply.value = [
      pendingRow,
      { provider: 'alfa-by', accountKey: 'BY11ALFA0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }
    ]
    const w = await mountWithBank([
      { number: 'BY11 ALFA 0001', provider: 'alfa-by' },
      { number: 'BY11ALFA0002', provider: 'alfa-by' }
    ])
    const chips = w.find('[data-testid="account-suggestions"]')
    // Сравнение нормализованное: то же подключение, записанное с пробелами, — не «ещё один счёт».
    expect(chips.text()).not.toContain('BY11 ALFA 0001')
    expect(chips.text()).toContain('BY11ALFA0002')
  })

  it('банк не ответил — поле ввода остаётся единственным путём, а не исчезает', async () => {
    listReply.value = [pendingRow]
    const w = await mountWithBank([])
    expect(w.find('[data-testid="account-suggestions"]').exists()).toBe(false)
    expect(w.find('[data-testid="pending-alfa-by"] input').exists()).toBe(true)
  })

  it('счёт ЧУЖОГО банка к выбору не предлагается', async () => {
    // Портал может держать Альфу и Приор одновременно — это штатно. Без фильтра по банку счёт
    // Приора попал бы в подсказки альфового подключения, а клик записал бы его в `account_key`
    // альфовой строки: конфликта нет (уникальность в пределах провайдера), зато дальше этот номер
    // уходит БУКВАЛЬНО параметром `number=` в запрос выписки Альфы — подключение молча умирает.
    listReply.value = [pendingRow]
    const w = await mountWithBank([
      { number: 'BY11PJCB0001', provider: 'prior-by' },
      { number: 'BY11ALFA0001', provider: 'alfa-by' }
    ])
    const chips = w.find('[data-testid="account-suggestions"]')
    expect(chips.text()).not.toContain('BY11PJCB0001')
    expect(chips.text()).toContain('BY11ALFA0001')
  })

  it('одинаковый номер у разных банков — не «уже привязан»', async () => {
    // Ключ хранилища — (банк, счёт). Считать номер занятым без учёта банка значило бы спрятать
    // единственный доступный счёт второго банка.
    listReply.value = [
      { ...pendingRow, provider: 'prior-by' },
      { provider: 'alfa-by', accountKey: 'BY11X0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }
    ]
    const w = await mountWithBank([{ number: 'BY11X0001', provider: 'prior-by' }])
    expect(w.find('[data-testid="account-suggestions"]').text()).toContain('BY11X0001')
  })

  it('строка банка без метки провайдера к выбору не предлагается — отказ в безопасную сторону', async () => {
    // Метку ставит сервер. Если она почему-то не доехала (старый бэкенд при разъехавшемся выкате),
    // предложить такой счёт значило бы, возможно, привязать его не к тому банку. Молчим и
    // оставляем поле ввода — это неудобно, но не ломает подключение.
    listReply.value = [pendingRow]
    const w = await mountWithBank([{ number: 'BY11ALFA0001' }])
    expect(w.find('[data-testid="account-suggestions"]').exists()).toBe(false)
    expect(w.find('[data-testid="pending-alfa-by"] input').exists()).toBe(true)
  })
})
