import { sliderRouteForPlace } from '~/config/b24'

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

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // рукопожатие фрейма — только в браузере
  if (routed) return
  const { init, placementPlace } = useB24()
  // Идемпотентно; вне портала возвращает пустой результат, и гард ниже не срабатывает.
  await init()
  const target = sliderRouteForPlace(placementPlace())
  routed = true
  if (target && to.path !== target) return navigateTo(target)
})
