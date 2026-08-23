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
// ⚠ Возврат объявлен ШИРОКО (`Record<string, unknown>`), а не выведен из тела. Иначе тип мока
// сужается до первой формы ответа, и `mockImplementation`, подменяющий поведение в отдельном тесте
// (например «вторая строка отвечает 409»), перестаёт компилироваться — при полностью корректном
// тесте.
const fetchMock = vi.fn((url: string, _opts?: Record<string, unknown>): Promise<Record<string, unknown>> => {
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

// ⚠ Кнопки ищем ПО ПОДПИСИ, а не по позиции. После первого клика строка раскрывается в пару
// «Да, отключить» / «Отмена», и «последняя кнопка» — это ОТМЕНА: тест бы кликал не туда, запрос бы
// не уходил, а `mockImplementationOnce` оставался бы в очереди и срабатывал в СЛЕДУЮЩЕМ тесте.
async function askToDisconnect(wrapper: { findAll: (s: string) => { text: () => string, trigger: (e: string) => Promise<void> }[] }): Promise<void> {
  const btn = wrapper.findAll('button').find(b => b.text().includes('Отключить') && !b.text().includes('Да,'))
  await btn!.trigger('click')
  await nextTick()
}

async function confirmDisconnect(wrapper: { findAll: (s: string) => { text: () => string, trigger: (e: string) => Promise<void> }[] }): Promise<void> {
  const btn = wrapper.findAll('button').find(b => b.text().includes('Да, отключить'))
  await btn!.trigger('click')
  await flushPromises()
  await nextTick()
}

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
    // ⚠ Кнопку ищем ПО ПОДПИСИ, а не «последнюю на экране»: индекс ломается от любой соседней
    // кнопки (так и вышло, когда рядом появилась ссылка в справку), причём ломается неочевидно —
    // тест краснеет на исправном коде отключения.
    const disconnect = wrapper.findAll('button').find(b => b.text().trim() === 'Отключить')
    expect(disconnect, 'кнопки «Отключить» нет вовсе').toBeTruthy()
    await disconnect!.trigger('click')
    await nextTick()
    // Первый клик только спрашивает — запроса на удаление ещё нет.
    expect(wrapper.text()).toContain('Отключить?')
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/bank/disconnect')).toBe(false)
  })

  it('второй клик шлёт НЕИЗМЕНЯЕМЫЙ адрес строки, а не только номер счёта', async () => {
    // ⚠ Единственное место, где это вообще проверяется. Прежде ни один тест не доходил до второго
    // клика, поэтому «composable перестал слать `id`» не ронял НИЧЕГО: сервер отвечал бы 400, фича
    // «Отключить» не работала бы совсем, а CI оставался зелёным (находка ревью тестировщика).
    listReply.value = [{ id: 42, provider: 'alfa-by', accountKey: 'BY01ALFA0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    await askToDisconnect(wrapper)
    await confirmDisconnect(wrapper)
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/bank/disconnect')
    expect(call).toBeTruthy()
    expect((call![1] as { body: Record<string, unknown> }).body).toMatchObject({
      id: 42, provider: 'alfa-by', accountKey: 'BY01ALFA0001'
    })
  })

  it('на 409 показывает «список устарел», а не общий отказ', async () => {
    // 409 здесь значит «строка изменилась под вами», и текст обязан звать обновить список: это
    // единственный исход, ради которого сообщение читают.
    listReply.value = [{ id: 42, provider: 'alfa-by', accountKey: 'BY01ALFA0001', connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true }]
    const wrapper = await mountReady()
    await askToDisconnect(wrapper)
    fetchMock.mockImplementationOnce((() => Promise.reject(Object.assign(new Error('conflict'), { statusCode: 409 }))) as unknown as typeof fetchMock)
    await confirmDisconnect(wrapper)
    expect(wrapper.text()).toContain('устарел')
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

describe('срок согласия банка (#503)', () => {
  // Счета компонент грузит сам (`/api/bank/accounts`), поэтому строку задаём через тот же
  // фейк-ответ, что и остальные тесты файла, а не пропсом.
  const base = { provider: 'prior-by', accountKey: 'BY13', connectedAt: Date.now(), expiresAt: Date.now() + 3_600_000, hasRefresh: true }
  const DAY = 86_400_000

  it('дата показана, пока согласие живо', async () => {
    listReply.value = [{ ...base, consentExpiresAt: Date.now() + 60 * DAY }]
    expect((await mountReady()).text()).toContain('согласие банка действует до')
  })

  it('за неделю до конца — предупреждение с ДЕЙСТВИЕМ, а не просто дата', async () => {
    // Продлевает согласие владелец счёта из интернет-банка; без этого админ не поймёт, что делать.
    listReply.value = [{ ...base, consentExpiresAt: Date.now() + 3 * DAY }]
    const t = (await mountReady()).text()
    expect(t).toContain('истекает')
    expect(t).toContain('интернет-банк')
  })

  it('ДАТЫ НЕТ — о согласии молчим, а не рисуем прочерк', async () => {
    // У Альфы согласий не бывает вовсе: строка про них была бы выдуманной сущностью.
    listReply.value = [{ ...base, provider: 'alfa-by', consentExpiresAt: 0 }]
    expect((await mountReady()).text()).not.toContain('согласие банка')
  })

  it('уже истекло — молчим: про это кричит бейдж состояния', async () => {
    // Две надписи об одном размывают единственное действие.
    listReply.value = [{ ...base, consentExpiresAt: Date.now() - DAY }]
    expect((await mountReady()).text()).not.toContain('согласие банка действует')
  })
})

describe('#576 пауза автоопроса', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7, provider: 'alfa-by', accountKey: 'BY01ALFA0001',
    connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true, pollPaused: false, ...over
  })
  const pauseBtn = (w: { findAll: (s: string) => { text: () => string, trigger: (e: string) => Promise<void> }[] }) =>
    w.findAll('button').find(b => b.text().includes('Пауза') || b.text().includes('Возобновить'))

  it('обычное подключение предлагает «Пауза», приостановленное — «Возобновить»', async () => {
    listReply.value = [row()]
    expect(pauseBtn(await mountReady())!.text()).toContain('Пауза')

    listReply.value = [row({ pollPaused: true })]
    expect(pauseBtn(await mountReady())!.text()).toContain('Возобновить')
  })

  it('приостановленное подключение помечено бейджем, а не выглядит сломанным', async () => {
    // ⚠ Подключение при этом ЖИВОЕ — токен продлевается, грант цел. Строка не должна читаться как
    // поломка, иначе админ пойдёт чинить то, что сам и выключил.
    listReply.value = [row({ pollPaused: true })]
    expect((await mountReady()).text()).toContain('опрос на паузе')
  })

  it('шлёт неизменяемый id и ожидаемый номер счёта, а не только номер', async () => {
    // ⚠ Номер МЕНЯЕТСЯ при выборе счёта, поэтому адресация только по нему промахивалась бы мимо
    // строки — тот же дефект, что чинил #517 у отключения.
    listReply.value = [row()]
    const wrapper = await mountReady()
    await pauseBtn(wrapper)!.trigger('click')
    await flushPromises()
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/bank/pause')
    expect(call).toBeTruthy()
    expect((call![1] as { body: Record<string, unknown> }).body)
      .toEqual({ id: 7, provider: 'alfa-by', accountKey: 'BY01ALFA0001', paused: true })
  })

  it('у подключения БЕЗ выбранного счёта кнопки паузы нет', async () => {
    // Опрашивать там нечего (у банка нет такого «номера»), значит и приостанавливать нечего.
    listReply.value = [row({ accountKey: PENDING })]
    expect(pauseBtn(await mountReady())).toBeUndefined()
  })

  it('пока хоть одно подключение на паузе — предупреждаем о потере дней', async () => {
    // ⚠ Приложение забирает выписку за ОКНО (сутки), а не за всё пропущенное: после долгой паузы
    // пропущенные дни не подтянутся никогда. Молчать об этом — значит знать о потере данных и не
    // сказать.
    listReply.value = [row({ pollPaused: true })]
    expect((await mountReady()).text()).toContain('за пропущенные дни')

    listReply.value = [row()]
    expect((await mountReady()).text()).not.toContain('за пропущенные дни')
  })

  // Массовое переключение паузы (#581) — проводка: план из чистого ядра, цикл, итог, перечитывание.
  describe('«Приостановить всё»', () => {
    const row = (id: number, accountKey: string, pollPaused = false) => ({
      id, provider: 'alfa-by', accountKey, connectedAt: Date.now(), expiresAt: Date.now(), hasRefresh: true, pollPaused
    })

    it('одно подключение — кнопки НЕТ', async () => {
      listReply.value = [row(1, 'BY01ALFA0001')]
      const wrapper = await mountReady()
      expect(wrapper.find('[data-testid="pause-all"]').exists()).toBe(false)
    })

    it('два работающих — кнопка есть и приостанавливает ОБА', async () => {
      listReply.value = [row(1, 'BY01ALFA0001'), row(2, 'BY01ALFA0002')]
      const wrapper = await mountReady()
      const btn = wrapper.find('[data-testid="pause-all"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('Приостановить всё')
      fetchMock.mockClear()
      await btn.trigger('click')
      await flushPromises()
      const pauses = fetchMock.mock.calls.filter(c => c[0] === '/api/bank/pause')
      expect(pauses).toHaveLength(2)
      expect((pauses[0]![1] as { body: { paused: boolean, id: number } }).body.paused).toBe(true)
      expect((pauses[0]![1] as { body: { id: number } }).body.id).toBe(1)
      // ⚠ Список перечитывается ОДИН раз в конце, а не после каждой строки: иначе N+1 запрос и
      // список, мигающий под курсором.
      expect(fetchMock.mock.calls.filter(c => c[0] === '/api/bank/accounts')).toHaveLength(1)
    })

    it('оба на паузе — подпись переворачивается на «Возобновить всё»', async () => {
      listReply.value = [row(1, 'BY01ALFA0001', true), row(2, 'BY01ALFA0002', true)]
      const wrapper = await mountReady()
      expect(wrapper.find('[data-testid="pause-all"]').text()).toContain('Возобновить всё')
    })

    it('ЧАСТИЧНЫЙ отказ показывается, а не выдаётся за успех', async () => {
      // ⚠ Ровно та ложь, из-за которой потом ищут поломку в банке: администратор уверен, что опрос
      // выключен, а один счёт продолжает заводить дела.
      listReply.value = [row(1, 'BY01ALFA0001'), row(2, 'BY01ALFA0002')]
      const wrapper = await mountReady()
      let seen = 0
      fetchMock.mockImplementation((url: string): Promise<Record<string, unknown>> => {
        if (url === '/api/bank/accounts') return Promise.resolve({ accounts: listReply.value })
        seen++
        return seen === 2 ? Promise.reject(new Error('409')) : Promise.resolve({ ok: true })
      })
      await wrapper.find('[data-testid="pause-all"]').trigger('click')
      await flushPromises()
      await nextTick()
      const note = wrapper.find('[data-testid="pause-all-note"]')
      expect(note.exists()).toBe(true)
      expect(note.text()).toContain('не переключилось')
      fetchMock.mockImplementation((url: string): Promise<Record<string, unknown>> => (url === '/api/bank/accounts'
        ? Promise.resolve({ accounts: listReply.value })
        : Promise.resolve({ ok: true })))
    })

    it('отказ ОДНОЙ строки не останавливает остальные', async () => {
      // Намерение — «выключить всё»; остановившись на первой сбойной строке, мы оставили бы
      // остальные работать, хотя они переключились бы.
      listReply.value = [row(1, 'BY01ALFA0001'), row(2, 'BY01ALFA0002'), row(3, 'BY01ALFA0003')]
      const wrapper = await mountReady()
      let seen = 0
      fetchMock.mockImplementation((url: string): Promise<Record<string, unknown>> => {
        if (url === '/api/bank/accounts') return Promise.resolve({ accounts: listReply.value })
        seen++
        return seen === 1 ? Promise.reject(new Error('409')) : Promise.resolve({ ok: true })
      })
      await wrapper.find('[data-testid="pause-all"]').trigger('click')
      await flushPromises()
      expect(seen, 'все три строки были опрошены').toBe(3)
      fetchMock.mockImplementation((url: string): Promise<Record<string, unknown>> => (url === '/api/bank/accounts'
        ? Promise.resolve({ accounts: listReply.value })
        : Promise.resolve({ ok: true })))
    })

    it('незавершённое подключение в цикл НЕ попадает', async () => {
      listReply.value = [row(1, 'BY01ALFA0001'), row(2, 'BY01ALFA0002'), row(3, PENDING)]
      const wrapper = await mountReady()
      fetchMock.mockClear()
      await wrapper.find('[data-testid="pause-all"]').trigger('click')
      await flushPromises()
      const pauses = fetchMock.mock.calls.filter(c => c[0] === '/api/bank/pause')
      expect(pauses).toHaveLength(2)
      expect(pauses.map(c => (c[1] as { body: { id: number } }).body.id)).toEqual([1, 2])
    })
  })
})
