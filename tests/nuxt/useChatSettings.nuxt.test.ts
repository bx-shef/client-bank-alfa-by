import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatSettings } from '~/composables/useChatSettings'
import { nextTick } from 'vue'

// Резолв названия чата (#528, 3.2). Composable — синглтон на модуль, поэтому каждый тест
// перезагружает его через `vi.resetModules()` (иначе состояние прошлого теста переезжает).
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
    const cs = useChatSettings()
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
    const cs = useChatSettings()
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
    const cs = useChatSettings()
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
    const cs = useChatSettings()
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
