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
function frameFacts(): Record<string, unknown> {
  const frame = useB24().get()
  return {
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
    useLogger('slider').warning('place не распознан — экран остаётся текущим', frameFacts())
    return
  }
  // Штатный путь — `info` (в проде логгер его режет, и правильно: тут всё в порядке).
  useLogger('slider').info('открыт слайдер', { place, target })
  if (to.path !== target) return navigateTo(target)
})
