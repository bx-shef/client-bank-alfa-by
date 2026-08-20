import { sliderRouteForPlace } from '~/config/b24'
import { SLIDER_INTENT_KEY, decodeSliderIntent } from '~/utils/sliderIntent'
import { useLogger } from '~/utils/logger'

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

/** Наша собственная метка намерения — второй признак, когда портал не донёс `place`.
 *  Читается ОДИН раз и сразу снимается: она описывает конкретное нажатие кнопки, а залипнув,
 *  увела бы в настройки обычный вход в приложение. */
function takeIntent(): string | undefined {
  try {
    const raw = window.sessionStorage.getItem(SLIDER_INTENT_KEY)
    window.sessionStorage.removeItem(SLIDER_INTENT_KEY)
    return decodeSliderIntent(raw, Date.now()) ?? undefined
  } catch {
    return undefined
  }
}

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // рукопожатие фрейма — только в браузере
  if (routed) return
  const { init, placementPlace } = useB24()
  // Идемпотентно; вне портала возвращает пустой результат, и гард ниже не срабатывает.
  await init()
  const place = placementPlace()
  // Метку снимаем ВСЕГДА, даже когда `place` пришёл: иначе она пережила бы этот фрейм и увела бы
  // следующий вход в приложение.
  const intent = takeIntent()
  const target = sliderRouteForPlace(place) ?? sliderRouteForPlace(intent)
  routed = true
  if (!target) return
  // ⚠ Уровень выбран по СМЫСЛУ, а не для громкости: в проде логгер режет всё ниже `warning`, и
  // именно в проде диагностика нужна. Штатное открытие — `info` (в проде молчит). А вот «портал
  // не донёс `place`, спасла наша метка» — аномалия платформы, которую иначе не увидит никто:
  // снаружи это выглядит просто как «слайдер открылся не тем экраном». В сообщении только наши
  // собственные литералы — ни токенов, ни данных портала.
  const log = useLogger('slider')
  if (place) log.info('открыт слайдер', { place, target })
  else log.warning('слайдер открыт БЕЗ place — ведём по своей метке', { intent, target })
  if (to.path !== target) return navigateTo(target)
})
