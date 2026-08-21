import { sliderRouteForPlace } from '~/config/b24'
import { useSliderRedirect } from '~/composables/useSliderRedirect'
import type { RouteLocationNormalized } from 'vue-router'
import { useLogger } from '~/utils/logger'
import { parsePlacementOptions } from '~/utils/placementOptions'
import { isSamePath } from '~/utils/routePath'

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

/** Сколько ждём рукопожатия с порталом, прежде чем оставить фрейм как есть. */
const HANDSHAKE_TIMEOUT_MS = 10_000

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
  // ⚠ Со страховкой по времени и молча — как в `InPortalGate`: голый `await` здесь означает, что
  // зависшее рукопожатие не резолвит МАРШРУТ вовсе, то есть человек видит пустой фрейм без всякого
  // объяснения, а брошенное исключение — необработанную ошибку навигации. Не дождались — просто не
  // редиректим: страница остаётся рабочей, и это честнее пустоты.
  await Promise.race([
    init().catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, HANDSHAKE_TIMEOUT_MS))
  ])
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
  return redirectToSlider(to, target)
})

/** Строка запроса фрейма как её видит браузер (у пререндеренной страницы `to.query` пуст). */
function queryFromLocation(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  return Object.fromEntries(new URLSearchParams(window.location.search))
}

/** Увести фрейм на экран слайдера.
 *
 *  ⚠ Возвращать `navigateTo` из мидлвара ЗДЕСЬ НЕДОСТАТОЧНО, и это не теория: воспроизведено на
 *  собранной статике (`.output/public`, `/app?place=app-options`) — мидлвар печатает «открыт
 *  слайдер → /settings», а адрес остаётся `/app`.
 *
 *  Механика (Nuxt 4.5, `pages/runtime/plugins/router.js`): у ПРЕРЕНДЕРЕННОЙ страницы, открытой со
 *  строкой запроса, `initialURL` не совпадает с `payload.path`, поэтому Nuxt гидратирует на голом
 *  пути, а на `app:suspense:resolve` ВОССТАНАВЛИВАЕТ исходный адрес — присваиванием
 *  `router.currentRoute.value` в обход гардов (`hasDeferredRoute`/`restoreDeferredRoute`). Редирект
 *  мидлвара, сделанный до этого, просто затирается. Фрейм слайдера под условие попадает всегда:
 *  портал открывает приложение с параметрами (`DOMAIN`, `PROTOCOL`, `LANG`, `APP_SID`). У соседнего
 *  приложения (и в официальном примере `03-nuxt-frame`) тот же код работает потому, что там
 *  `ssr: false` — SPA, где восстанавливать нечего: оболочка отдаётся на любой адрес, начальный
 *  маршрут резолвится из настоящего URL, и редирект мидлвара никто не перетирает.
 *
 *  ⚠ Ось различия — ПРЕРЕНДЕР против SPA, а не «nginx против Nitro»: Nitro есть и у нас, он отдаёт
 *  `/api/*`. Проверено экспериментом: с `ssr: false` файла `_payload.json` не появляется вовсе, и
 *  старый код (голый `return navigateTo`) уводит фрейм на `/settings` штатно. Перейти на `ssr: false`
 *  нам нельзя — на пререндеренном HTML держится SEO лендинга (мета, `og:image`, JSON-LD в разметке),
 *  поэтому починка остаётся на нашей стороне.
 *
 *  Поэтому при гидратации навигируем САМИ из `onNuxtReady`: он висит на том же
 *  `app:suspense:resolve`, но подписывается ПОЗЖЕ и вдобавок уходит в `requestIdleCallback`, то
 *  есть гарантированно исполняется после восстановления адреса. Замер по точкам: возврат из
 *  мидлвара — адрес не меняется, `app:mounted` — NavigationFailure `aborted` (8), `onNuxtReady` —
 *  проходит. Штатной альтернативы нет: `redirectCode` читается только на сервере, `abortNavigation`
 *  редиректа не даёт, `external: true` — полная перезагрузка приложения.
 *
 *  `replace`, а не `push`: `/app` в истории фрейма слайдера — не шаг пользователя, и «назад» не
 *  должно возвращать на экран, который он не открывал. */
function redirectToSlider(to: RouteLocationNormalized, target: string) {
  const nuxtApp = useNuxtApp()
  // ⚠ Строку запроса тащим с собой. `place` приезжает ДВУМЯ путями, и живой прогон дал именно тот,
  // где `PLACEMENT_OPTIONS` пуст целиком, а параметр приходит адресом. Потеряв его здесь, мы
  // получили бы `/settings`, которая себя слайдером не считает: «Отмена» вместо сворачивания
  // открывала бы ВТОРОЙ экран приложения поверх работы, с крестиком портала над ним.
  //
  // ⚠ Берём её из АДРЕСА ОКНА, а не из `to.query`, и это та же история, что с самим редиректом:
  // пререндеренную страницу Nuxt гидратирует на голом пути, поэтому в `to` строки запроса нет
  // вовсе. Замерено — с `to.query` фрейм приезжал на голый `/settings`, и целевой экран терял и
  // `place`, и параметры портала (`APP_SID` и прочие), то есть переставал быть слайдером.
  const dest = { path: target, query: queryFromLocation() }
  if (!nuxtApp.isHydrating) return navigateTo(dest, { replace: true })
  useSliderRedirect().claim(target)
  onNuxtReady(() => {
    void nuxtApp.runWithContext(async () => {
      const router = useRouter()
      // Пользователь мог уйти сам, пока мы ждали простоя главного потока, — своё намерение он
      // выразил позже нашего, и перебивать его нельзя.
      //
      // ⚠ Сравнение — по НОРМАЛИЗОВАННОМУ пути. Прямое `!==` выглядит строже и на живой сборке
      // отменяло редирект ВСЕГДА: адрес фрейма приходит с хвостовым слэшем (`/app/`), а маршрут
      // резолвится без него, — то есть «страница сменилась» срабатывало там, где никто никуда не
      // уходил. Замерено на статике: слайдер снова оставался на главном экране.
      if (!isSamePath(router.currentRoute.value.path, to.path)) return
      // ⚠ Именно `router.replace`, а не `navigateTo`: последний, застав чужую навигацию в работе,
      // ВОЗВРАЩАЕТ объект маршрута вместо перехода — и результат было бы некому применить, а в
      // логе осталось бы бодрое «открыт слайдер». Тот самый молчаливый отказ, ради которого всё
      // это и переписывалось.
      const failure = await router.replace(dest)
      if (failure) useLogger('slider').warning('перейти на экран слайдера не удалось', { target, type: failure.type })
    })
  })
}
