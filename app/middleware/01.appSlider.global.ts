import { sliderRouteForPlace } from '~/config/b24'
import { useLogger } from '~/utils/logger'
import { parsePlacementOptions } from '~/utils/placementOptions'

// Приложение, открытое НАМИ через `openSliderAppPage({ place })`, портал переоткрывает по НАШЕМУ же
// адресу (портальный путь дал бы 404) и передаёт `place` в PLACEMENT_OPTIONS. Этот мидлвар читает
// его и уводит свежий фрейм слайдера на нужный маршрут: `app-options` → /settings,
// `app-import` → /import. У обычно открытой страницы `place` нет — редиректа не происходит.
//
// ⚠ Решение принимается ОДИН раз за жизнь фрейма. `place` прилипает к фрейму навсегда, поэтому
// проверка на каждой навигации превратилась бы в клетку: пользователь, ушедший из слайдера обратно
// на `/app` (фолбэк, когда портал отказал во вложенном слайдере), возвращался бы назад — и кнопка
// выглядела бы сломанной.
let routed = false

/** Что портал реально прислал во фрейм — для диагностики. Только ИМЕНА ключей и адрес без
 *  строки запроса: значения принадлежат порталу, и в логе им не место.
 *
 *  ⚠ Раньше эта диагностика стояла за признаком «мы в слайдере» (`placement.isSliderMode`), и это
 *  была ошибка: SDK выводит его из `PLACEMENT_OPTIONS.IFRAME`, то есть из ТЕХ ЖЕ данных, которых
 *  может не быть. Живой прогон дал ровно этот случай — options пусты целиком, признак false, и
 *  единственная строка, ради которой всё писалось, не напечаталась. Условие снято: гейт у
 *  диагностики не должен зависеть от того, что она же и диагностирует. */
function frameFacts(to: string): Record<string, unknown> {
  const frame = useB24().get()
  return {
    // ⚠ `path` и `placement` — чтобы отличить ОСНОВНОЕ окно приложения от фрейма слайдера.
    // Без них строки неразличимы, и первая же диагностика ушла в молоко: в основном окне
    // `place` отсутствует ЗАКОНОМЕРНО, и его отчёт выглядел как отчёт слайдера.
    path: to,
    placement: frame?.placement?.placement ?? null,
    isSlider: frame?.placement?.isSliderMode ?? null,
    inFrame: frame !== undefined,
    optionKeys: Object.keys(parsePlacementOptions(frame?.placement?.options)),
    queryKeys: typeof window === 'undefined' ? [] : [...new URLSearchParams(window.location.search).keys()]
  }
}

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // рукопожатие фрейма — только в браузере
  if (routed) return
  const { init, placementPlace } = useB24()
  // Идемпотентно; вне портала возвращает пустой результат, и гард ниже не срабатывает.
  await init()
  const place = placementPlace()
  const target = sliderRouteForPlace(place)
  routed = true
  if (!target) {
    // ⚠ Тишина здесь — самый дорогой случай: слайдер открылся, но показал главный экран, и
    // снаружи это неотличимо от «кнопка сломана». Уровень `warning`, потому что в проде логгер
    // режет всё ниже, а диагностика нужна именно там. Обычное открытие приложения (вне фрейма
    // или без параметров) шумит одной строкой — это дёшево и однократно.
    useLogger('slider').warning('place не распознан — экран остаётся текущим', frameFacts(to.path))
    return
  }
  // Штатный путь — `info` (в проде логгер его режет, и правильно: тут всё в порядке).
  useLogger('slider').info('открыт слайдер', { place, target })
  if (to.path === target) return
  return redirectToSlider(target)
})

/** Увести фрейм на экран слайдера.
 *
 *  ⚠ Возвращать `navigateTo` из мидлвара ЗДЕСЬ НЕДОСТАТОЧНО, и это не теория: воспроизведено на
 *  собранной статике (`.output/public`, `/app?place=app-options`) — мидлвар печатает «открыт
 *  слайдер → /settings», а адрес остаётся `/app`. На ПЕРВОЙ навигации Nuxt считает редирект уже
 *  выполненным на сервере и результат мидлвара при гидратации не применяет; у нас сервера нет
 *  вовсе (SSG + nginx), на сервере мидлвар выходит первой же строкой — значит редирект не делает
 *  никто. Ровно это и видел администратор: слайдер открывался и показывал главный экран. У
 *  соседнего приложения тот же код работает потому, что там страницу отдаёт Nitro на лету.
 *
 *  Поэтому при гидратации навигируем САМИ — и не «сразу после монтирования»: замерено, что
 *  `router.replace` в `app:mounted` возвращает NavigationFailure `aborted` (8), а вызванный на
 *  такте раньше конца первой навигации — молча проигрывает ей и адрес остаётся прежним. Точка,
 *  где это работает, — `onNuxtReady` (после `app:suspense:resolve`, следующим тиком), то есть
 *  когда первая навигация уже завершилась и роутер свободен.
 *
 *  `replace`, а не `push`: `/app` в истории фрейма слайдера — не шаг пользователя, и «назад» не
 *  должно возвращать на экран, который он не открывал. */
function redirectToSlider(target: string) {
  const nuxtApp = useNuxtApp()
  if (!nuxtApp.isHydrating) return navigateTo(target, { replace: true })
  onNuxtReady(() => {
    void nuxtApp.runWithContext(() => navigateTo(target, { replace: true }))
  })
}
