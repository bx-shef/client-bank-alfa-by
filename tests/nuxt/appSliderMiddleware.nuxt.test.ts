import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useNuxtApp, useRouter } from '#app'

// Мидлвар, уводящий свежий фрейм слайдера на нужный маршрут (#528). Логика простая, но
// проверить её больше нечем: у портала фрейм один, повторить руками нельзя, а ошибка здесь
// выглядит как «кнопка молча ничего не делает».

// `options` — то, что «прислал портал»; `placementPlace` берём НАСТОЯЩИЙ, потому что вся суть
// проверки в том, как читается присланное.
const state = vi.hoisted(() => ({ options: undefined as unknown, optionsAfterInit: undefined as unknown, initCalls: 0 }))
const readyQueue = vi.hoisted(() => [] as Array<() => void>)
const navigateSpy = vi.hoisted(() => vi.fn(async () => 'navigated'))

vi.mock('~/composables/useB24', async () => {
  const { placeFromOptions } = await import('~/utils/placementOptions')
  return {
    useB24: () => ({
      init: async () => {
        state.initCalls += 1
        // `place` становится читаемым ТОЛЬКО после рукопожатия — иначе порядок вызовов
        // ненаблюдаем, и перестановка `init()` за `placementPlace()` прошла бы незамеченной
        // (проверено мутацией). Это и есть тот отказ: вызов есть, а решение принято на пустом
        // `placement`.
        state.options = state.optionsAfterInit
      },
      get: () => ({ placement: { options: state.options, isSliderMode: true } }),
      placementPlace: () => placeFromOptions(state.options)
    })
  }
})

vi.mock('#app/composables/router', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, navigateTo: navigateSpy }
})

// `onNuxtReady` подменяем: именно на нём держится починка первой навигации (#555), а в тестовой
// среде ждать настоящей готовности приложения нечего. Признак гидратации ставим на НАСТОЯЩЕМ
// `nuxtApp` (ниже), а не подсовываем его копию: копия теряет привязку `runWithContext`, и роутер
// падает уже за пределами теста.
vi.mock('#app/composables/ready', () => ({
  onNuxtReady: (cb: () => void) => {
    readyQueue.push(cb)
  }
}))

type To = { path: string, query: Record<string, string> }

async function runMiddleware(path: string, query: Record<string, string> = {}) {
  vi.resetModules()
  const mw = (await import('~/middleware/01.appSlider.global')).default as unknown as
    (to: To, from: To) => Promise<unknown>
  return mw({ path, query }, { path, query })
}

/** Куда мидлвар обязан вести: маршрут ВМЕСТЕ со строкой запроса — `place` приезжает и адресом,
 *  а потерянный по дороге, он оставил бы целевой экран не считающим себя слайдером.
 *  ⚠ Источник строки — АДРЕС ОКНА, а не `to.query`: пререндеренную страницу Nuxt гидратирует на
 *  голом пути, и в `to` параметров нет вовсе (замерено на собранной статике). */
function dest(path: string, query: Record<string, string> = {}) {
  return { path, query }
}

afterEach(() => {
  navigateSpy.mockClear()
  state.options = undefined
  state.optionsAfterInit = undefined
  state.initCalls = 0
  useNuxtApp().isHydrating = false
  readyQueue.length = 0
  window.history.replaceState({}, '', '/')
})

describe('мидлвар слайдера', () => {
  it('уводит фрейм, открытый с place=app-options, на /settings', async () => {
    state.optionsAfterInit = { place: 'app-options' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith(dest('/settings'), { replace: true })
  })

  it('уводит фрейм, открытый с place=app-import, на /import', async () => {
    state.optionsAfterInit = { place: 'app-import' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith(dest('/import'), { replace: true })
  })

  it('справка едет с ЯКОРЕМ, а не с решёткой внутри пути', async () => {
    // ⚠ Контекстная ссылка «Что это значит?» несёт якорь раздела в самом `place` (#576 п.2) —
    // другого канала нет: строку запроса задаёт портал, а хэш до фрейма не доезжает. Дальше якорь
    // обязан отделиться от пути: `navigateTo({ path: '/help#exclusions' })` ищет ПУТЬ с решёткой,
    // такого маршрута нет, и слайдер показал бы 404. Мутация «не разделять» проходила зелёной —
    // чистый `sliderRouteForPlace` о судьбе своей строки ничего не знает.
    state.optionsAfterInit = { place: 'app-help-exclusions' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith({ path: '/help', query: {}, hash: '#exclusions' }, { replace: true })
  })

  it('справка без якоря не получает пустой хэш', async () => {
    // Пустой `hash: '#'` — это адрес, отличающийся от чистого, и в истории фрейма он лишний.
    state.optionsAfterInit = { place: 'app-help-нет-такого' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith(dest('/help'), { replace: true })
  })

  it('обычное открытие приложения (без place) никуда не уводит', async () => {
    await runMiddleware('/app')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('дожидается рукопожатия с порталом ДО чтения place', async () => {
    // Иначе решение принимается на пустом `placement`, и слайдер остаётся на /app —
    // снаружи это выглядит как «настройки не открываются».
    state.optionsAfterInit = { place: 'app-options' }
    await runMiddleware('/app')
    expect(state.initCalls).toBe(1)
  })
})

describe('мидлвар слайдера: форма PLACEMENT_OPTIONS (#555)', () => {
  it('уводит, когда портал прислал параметры JSON-СТРОКОЙ', async () => {
    // Живой симптом: слайдер открывался и показывал главный экран. Параметр доезжал, но читался
    // как `options.place` у объекта — у строки это молча `undefined`, и вести фрейм было не по чему.
    state.optionsAfterInit = JSON.stringify({ place: 'app-options' })
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith(dest('/settings'), { replace: true })
  })

  it('уводит, когда ключ пришёл заглавными', async () => {
    // Остальные поля init-данных портал шлёт именно так (PLACEMENT, LANG, IS_ADMIN).
    state.optionsAfterInit = { PLACE: 'app-import' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith(dest('/import'), { replace: true })
  })
})

describe('мидлвар слайдера: первая навигация фрейма (#555)', () => {
  // ⚠ Самая дорогая ошибка этого мидлвара: он ЧЕСТНО распознавал `place` и возвращал `navigateTo`,
  // а адрес оставался прежним. У пререндеренной страницы, открытой со строкой запроса (а портал
  // открывает приложение именно так), Nuxt после гидратации возвращает исходный адрес в обход
  // гардов и затирает наш редирект. Замерено на собранной статике; снаружи это выглядело как
  // «слайдер открывает главный экран».
  it('на гидратации не полагается на возврат из мидлвара, а навигирует сам после готовности', async () => {
    const nuxtApp = useNuxtApp()
    nuxtApp.isHydrating = true
    const router = useRouter()
    const here = router.currentRoute.value.path
    const replaceSpy = vi.spyOn(router, 'replace').mockResolvedValue(undefined)
    state.optionsAfterInit = { place: 'app-options' }

    // Портал открывает фрейм с параметрами — кладём их в адрес окна, как это делает он.
    window.history.replaceState({}, '', `${here}?APP_SID=x`)
    await runMiddleware(here)
    // Синхронно — молчим: вернуть навигацию тут значит не сделать ничего.
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(readyQueue).toHaveLength(1)

    readyQueue[0]?.()
    await nextTick()
    expect(replaceSpy).toHaveBeenCalledWith(dest('/settings', { APP_SID: 'x' }))
    replaceSpy.mockRestore()
  })

  it('на гидратации не перебивает пользователя, ушедшего со страницы сам', async () => {
    // `onNuxtReady` ждёт простоя главного потока, и за это время человек мог нажать «Загрузить
    // выписку». Его намерение выражено позже нашего — оно и должно победить.
    const nuxtApp = useNuxtApp()
    nuxtApp.isHydrating = true
    const router = useRouter()
    const replaceSpy = vi.spyOn(router, 'replace').mockResolvedValue(undefined)
    state.optionsAfterInit = { place: 'app-options' }

    await runMiddleware('/куда-мы-уже-не-вернёмся')
    readyQueue[0]?.()
    await nextTick()
    expect(replaceSpy).not.toHaveBeenCalled()
    replaceSpy.mockRestore()
  })

  it('на гидратации без place ничего не откладывает', async () => {
    useNuxtApp().isHydrating = true
    await runMiddleware('/app')
    expect(readyQueue).toHaveLength(0)
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

describe('мидлвар слайдера: решение один раз за жизнь фрейма', () => {
  // ⚠ Гард `routed` — не оптимизация, а защита от клетки: `place` прилипает к фрейму навсегда,
  // и без гарда человек, ушедший из слайдера обратно на /app (фолбэк, когда портал отказал во
  // вложенном), отбрасывался бы назад при КАЖДОЙ навигации. Проверяем повторным вызовом ОДНОГО
  // и того же модуля — с `vi.resetModules()` перед каждым прогоном гард ненаблюдаем, и его
  // удаление проходило CI молча (проверено мутацией).
  it('второй проход мидлвара не уводит фрейм снова', async () => {
    state.optionsAfterInit = { place: 'app-options' }
    vi.resetModules()
    const mw = (await import('~/middleware/01.appSlider.global')).default as unknown as
      (to: { path: string }, from: { path: string }) => Promise<unknown>
    await mw({ path: '/app' }, { path: '/app' })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    // Возврат пользователя на /app — его собственное намерение, и оно не перебивается.
    await mw({ path: '/app' }, { path: '/settings' })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
  })
})
