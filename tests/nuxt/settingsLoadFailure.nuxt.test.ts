import { afterEach, describe, expect, it, vi } from 'vitest'

// Отказ чтения настроек не равен «не настроено», и сохранять поверх непрочитанного нельзя (#705).
//
// Цена дефекта несимметрична: провал `GET /api/chat-settings` оставлял на экране ДЕФОЛТЫ —
// внешне неотличимые от ненастроенного портала, — и обычное действие («вижу, чат не выбран →
// выбираю → Сохранить») необратимо затирало реальные настройки клиента.
//
// Проверяем ровно два несущих утверждения: признак провала поднимается и снимается по ФАКТУ
// чтения, и `save()` при поднятом признаке не делает НИ ОДНОГО запроса.

vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => ({ token: 't', domain: 'p.bitrix24.by' }),
  frameAuthHeaders: () => ({}),
  frameFetchError: (_e: unknown, fallback: string) => fallback
}))

// Синглтон живёт на модуле — берём свежий инстанс внутри каждого теста, как в соседнем наборе.
async function freshSettings() {
  vi.resetModules()
  const mod = await import('~/composables/useChatSettings')
  return mod.useChatSettings()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const OK_SETTINGS = { chat: { dialogId: 'chat7', title: 'Бухгалтерия' }, errorChat: { dialogId: '' } }

describe('настройки: провал чтения (#705)', () => {
  it('поднимает признак провала и НЕ выдаёт дефолты за настройки портала', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (): Promise<unknown> => {
      throw new Error('502')
    }) as never)
    const cs = await freshSettings()
    await cs.load()

    expect(cs.loaded.value).toBe(true) // загрузка завершилась…
    expect(cs.loadFailed.value).toBe(true) // …но не удалась, и это РАЗНЫЕ вещи
    expect(cs.settings.chat.dialogId).toBe('') // на экране дефолты
  })

  it('снимает признак после удачного чтения', async () => {
    let fail = true
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (fail) throw new Error('502')
      if (String(url).includes('chat-settings')) return OK_SETTINGS
      return { items: [] }
    }) as never)
    const cs = await freshSettings()
    await cs.load()
    expect(cs.loadFailed.value).toBe(true)

    fail = false
    await cs.load()
    expect(cs.loadFailed.value).toBe(false)
    expect(cs.settings.chat.dialogId).toBe('chat7')
  })

  it('ГАРД: save() при непрочитанных настройках не шлёт запрос', async () => {
    // Мутационный гард из самой задачи: снятие запрета в `save()` обязано ронять этот тест.
    // Смотрим на ОТСУТСТВИЕ POST, а не на флаг: затирание — это именно запрос, а не состояние.
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }): Promise<unknown> => {
      if (opts?.method === 'POST') return {}
      throw new Error('502')
    })
    vi.stubGlobal('$fetch', fetchMock as never)
    const cs = await freshSettings()
    await cs.load()
    expect(cs.loadFailed.value).toBe(true)

    const before = fetchMock.mock.calls.length
    await cs.save()

    const posts = fetchMock.mock.calls.slice(before).filter(([, o]) => (o as { method?: string } | undefined)?.method === 'POST')
    expect(posts).toHaveLength(0)
    expect(cs.savedOk.value).toBe(false)
    expect(cs.error.value).not.toBe('')
  })

  it('после удачного чтения сохранение проходит — запрет не стал вечным', async () => {
    const fetchMock = vi.fn(async (url: string, _opts?: { method?: string }): Promise<unknown> => {
      if (String(url).includes('chat-settings')) return OK_SETTINGS
      return { items: [] }
    })
    vi.stubGlobal('$fetch', fetchMock as never)
    const cs = await freshSettings()
    await cs.load()
    await cs.save()

    const posts = fetchMock.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
  })
})
