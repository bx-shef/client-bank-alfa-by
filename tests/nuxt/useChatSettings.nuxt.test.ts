import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatSettings } from '~/composables/useChatSettings'

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
})
