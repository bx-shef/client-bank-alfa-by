import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// Резолв названия чата (#528, 3.2). Composable — синглтон НА МОДУЛЬ, поэтому его нельзя
// импортировать статически: `vi.resetModules()` не действует на уже полученную ссылку, и все
// тесты работали бы с одним `settings`/`notifyOption` — то есть зависели бы от порядка запуска
// (ранний выход `adoptTitle` по `target.value` от соседнего теста и т. п.). Берём свежий модуль
// внутри каждого теста, ПОСЛЕ сброса.
//
// Проверяем ровно те три гарантии, ради которых написан `adoptTitle`: не спрашиваем портал
// зря, не приклеиваем имя не к тому чату и не кэшируем сырой id как «известное имя».

// Фрейм-авторизация мокается целиком: она читает SDK портала, которого в тестах нет, а предмет
// проверки — не она, а порядок запросов за названием чата.
vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => ({ token: 't', domain: 'p.bitrix24.by' }),
  frameAuthHeaders: () => ({}),
  frameFetchError: (_e: unknown, fallback: string) => fallback
}))

/** Свежий инстанс composable: модуль перезагружается, синглтон создаётся заново. */
async function freshSettings() {
  vi.resetModules()
  const mod = await import('~/composables/useChatSettings')
  return mod.useChatSettings()
}

function mockFetch(handler: (url: string, opts: { params?: Record<string, unknown> }) => unknown) {
  vi.stubGlobal('$fetch', vi.fn(handler) as never)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('useChatSettings: название сохранённого чата', () => {
  it('не спрашивает портал, если название уже в настройках', async () => {
    const calls: string[] = []
    mockFetch((url, opts) => {
      calls.push(`${url}${opts?.params?.id ? '?id' : ''}`)
      if (String(url).includes('chat-settings')) {
        return { chat: { dialogId: 'chat7', title: 'Бухгалтерия' }, errorChat: { dialogId: '' } }
      }
      return { items: [] }
    })
    const cs = await freshSettings()
    await cs.load()
    expect(cs.notifyOption.value?.label).toBe('Бухгалтерия')
    expect(calls.some(c => c.endsWith('?id'))).toBe(false)
  })

  it('спрашивает портал, когда названия нет нигде, и кэширует его в настройки', async () => {
    mockFetch((url, opts) => {
      if (String(url).includes('chat-settings')) {
        return { chat: { dialogId: 'chat7' }, errorChat: { dialogId: '' } }
      }
      if (opts?.params?.id === 'chat7') return { item: { value: 'chat7', label: 'Оплаты' } }
      return { items: [] }
    })
    const cs = await freshSettings()
    await cs.load()
    expect(cs.notifyOption.value).toEqual({ value: 'chat7', label: 'Оплаты' })
    // Кэш в настройках — чтобы следующее открытие формы было бесплатным.
    expect(cs.settings.chat.title).toBe('Оплаты')
  })

  it('НЕ кэширует сырой id как название, если портал не смог его разрешить', async () => {
    // Иначе `seedOption` навсегда счёл бы `chat7` известным именем, и портал больше не спросили бы.
    mockFetch((url) => {
      if (String(url).includes('chat-settings')) {
        return { chat: { dialogId: 'chat7' }, errorChat: { dialogId: '' } }
      }
      return { item: null, items: [] }
    })
    const cs = await freshSettings()
    await cs.load()
    expect(cs.notifyOption.value?.label).toBe('chat7') // значение остаётся выбираемым
    expect(cs.settings.chat.title).toBeFalsy()
  })

  it('медленный ответ НЕ приклеивает имя старого чата к новому id', async () => {
    // `load()` повторяется по pull-нотификации от другого инстанса формы. Без сверки id
    // ответ предыдущего запроса подписал бы НОВЫЙ чат именем СТАРОГО — и это имя уехало бы
    // в app.option на ближайшем сохранении.
    let release: (v: unknown) => void = () => {}
    let sent = false
    mockFetch((url, opts) => {
      if (String(url).includes('chat-settings')) {
        return { chat: { dialogId: 'chat7' }, errorChat: { dialogId: '' } }
      }
      if (opts?.params?.id === 'chat7') {
        sent = true
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return { items: [] }
    })
    const cs = await freshSettings()
    const loading = cs.load()
    // Ждём, пока запрос за названием действительно уйдёт: до этого `load()` ещё перезаписывает
    // настройки ответом сервера, и подмена id была бы затёрта — тест проверял бы не гонку.
    for (let i = 0; i < 50 && !sent; i++) await nextTick()
    expect(sent).toBe(true)
    // Пока ответ в пути, настройки перечитаны (pull от другого инстанса) и чат уже другой.
    cs.settings.chat.dialogId = 'chat99'
    release({ item: { value: 'chat7', label: 'Старый чат' } })
    await loading

    expect(cs.notifyOption.value?.label).not.toBe('Старый чат')
    expect(cs.settings.chat.title).not.toBe('Старый чат')
  })
})

describe('useChatSettings: оба названия резолвятся параллельно', () => {
  it('второй запрос уходит, не дожидаясь ответа на первый', async () => {
    // Запросы независимы, а форма до их завершения показывает «Загрузка настроек…»: выстроенные
    // в очередь, они держат экран оба круга подряд. Свойство было записано только комментарием —
    // последовательная версия проходила все тесты.
    let sent = 0
    const release: Array<() => void> = []
    mockFetch((url, opts) => {
      if (String(url).includes('chat-settings')) {
        return { chat: { dialogId: 'chat7' }, errorChat: { dialogId: 'chat8' } }
      }
      if (opts?.params?.id) {
        sent += 1
        return new Promise((resolve) => {
          release.push(() => resolve({ item: { value: String(opts.params!.id), label: 'Чат' } }))
        })
      }
      return { items: [] }
    })

    const cs = await freshSettings()
    const loading = cs.load()
    await vi.waitFor(() => expect(sent).toBe(2)) // ОБА ушли, пока ни один не ответил
    release.forEach(fn => fn())
    await loading
  })
})
