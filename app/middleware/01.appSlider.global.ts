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

/** Мы сами внутри слайдера портала? Признак самого портала (`PLACEMENT_OPTIONS.IFRAME`), а не наш
 *  параметр, — именно поэтому по нему видно случай «слайдер открылся, а `place` не доехал». */
function isSliderFrame(): boolean {
  try {
    return useB24().get()?.placement?.isSliderMode === true
  } catch {
    return false
  }
}

/** Имена ключей, которые прислал портал, — для диагностики. Только имена: значения принадлежат
 *  порталу, и в логе им не место. */
function optionKeys(): string[] {
  return Object.keys(parsePlacementOptions(useB24().get()?.placement?.options))
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
    // снаружи это неотличимо от «кнопка сломана». Пишем `warning`, потому что в проде логгер
    // режет всё ниже, а нужна диагностика именно там. Печатаем ТОЛЬКО ключи PLACEMENT_OPTIONS —
    // по ним видно, донёс ли портал параметр и под каким именем, а значений портала в логе быть
    // не должно.
    if (isSliderFrame()) {
      useLogger('slider').warning('слайдер открыт без распознанного place', { optionKeys: optionKeys() })
    }
    return
  }
  // Штатный путь — `info` (в проде логгер его режет, и правильно: тут всё в порядке).
  useLogger('slider').info('открыт слайдер', { place, target })
  if (to.path !== target) return navigateTo(target)
})
