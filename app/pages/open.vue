<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { useSliderRedirect } from '~/composables/useSliderRedirect'
import { sliderRouteForPlace } from '~/config/b24'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'

// Обработчик ссылки `/marketplace/view/<код приложения>/?params[place]=…` — точка встраивания
// `REST_APP_URI` (#19). Портал открывает ИМЕННО ЭТОТ адрес слайдером, а `place` из `params`
// приезжает в `PLACEMENT_OPTIONS`; куда вести дальше — решает общий мидлвар
// `01.appSlider.global.ts` по той же таблице `sliderRouteForPlace`, что и кнопки внутри
// приложения.
//
// ⚠ СТРАНИЦА ОТДЕЛЬНАЯ, И ЭТО НЕ ЛИШНЯЯ СУЩНОСТЬ. Обработчик у точки РОВНО ОДИН на приложение, то
// есть его адрес — часть регистрации на портале клиента, а не деталь нашей маршрутизации. Указать
// обработчиком `/app` было бы дешевле на одну страницу и дороже на всё остальное: у `/app` есть
// собственная логика пусковой страницы (#15 — базовый фрейм сам открывает слайдер), и ссылка без
// параметров попадала бы ровно в неё, открывая слайдер поверх слайдера. Здесь такой логики нет и
// быть не может.
//
// ⚠ ЗАГОЛОВОК ПОРТАЛА И `fitWindow` ЗДЕСЬ НЕ ЗОВЁМ — намеренно. Эта страница транзитная: она
// смонтируется и почти сразу уступит место целевой. Их вызов отсюда — ровно тот дефект, ради
// которого заведён `useSliderRedirect` (см. его шапку): поздно вернувшийся `setTitle` перекрывает
// заголовок экрана, который уже открыт, а `fitWindow` подгоняет высоту под вёрстку, которой на
// экране нет.
definePageMeta({ layout: 'portal' })

useHead({
  title: pageTitle('Открытие'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

const log = useLogger('slider')
const b24 = useB24()
const router = useRouter()
const redirect = useSliderRedirect()

/** Что показываем, пока не решили: `''` — ещё решаем, иначе текст объяснения. */
const notice = ref('')

onMounted(async () => {
  await b24.init()
  // Мидлвар уже объявил, что фрейм уезжает, — не мешаем: место назначения выбрал он, и делать
  // здесь второй переход значило бы гоняться с ним за один и тот же фрейм.
  if (redirect.target.value) return
  const place = b24.placementPlace()
  const target = sliderRouteForPlace(place)
  if (target) {
    // Сюда попадаем, когда мидлвар отработал ДО рукопожатия с порталом (его ожидание ограничено
    // по времени — см. `HANDSHAKE_TIMEOUT_MS`). Тогда решение принимаем мы, уже зная `place`.
    const [path, hash] = target.split('#')
    await router.replace({ path: path!, query: { ...router.currentRoute.value.query }, ...(hash ? { hash: `#${hash}` } : {}) })
    return
  }
  // ⚠ Ссылка без параметров (или с неизвестным `place`) — НЕ ошибка: ровно так выглядит
  // `/marketplace/view/<код>/` без `params`. Ведём на главный экран приложения, а не показываем
  // тупик: человек хотел открыть приложение и открыл его.
  log.warning('ссылка открыта без известного place — ведём на главный экран', { place: place ?? null })
  if (b24.isInit()) {
    await router.replace({ path: '/app', query: { ...router.currentRoute.value.query } })
    return
  }
  // Вне портала переходить некуда — там нет ни фрейм-токена, ни слайдера. Гейт ниже покажет своё
  // объяснение, а эта строка нужна для `?preview=1`, где гейт пропускает.
  notice.value = 'Эта ссылка открывается только внутри Bitrix24.'
})
</script>

<!-- Только внутри портала: снаружи у страницы нет ни контекста, ни смысла — открывать нечего. -->
<template>
  <InPortalGate>
    <main class="mx-auto max-w-3xl px-4 py-10">
      <p
        v-if="notice"
        class="text-sm text-(--ui-color-base-3)"
      >
        {{ notice }}
      </p>
      <p
        v-else
        class="text-sm text-(--ui-color-base-3)"
        role="status"
      >
        Открываем…
      </p>
    </main>
  </InPortalGate>
</template>
