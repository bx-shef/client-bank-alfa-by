// Маршруты — из единого источника (#425): из него же строятся sitemap.xml, robots.txt и признак
// «закрыть от индексации». Копия списка здесь означала бы, что страница может попасть в пререндер,
// но не в карту сайта (или наоборот), и заметить это можно только случайно.
import { PRERENDER_ROUTES, SERVICE_ROUTES } from './app/config/routes'

// Только цифры — защита от случайной опечатки или компрометации ENV в CI.
const metrikaId = (process.env.NUXT_PUBLIC_METRIKA_ID || '109399587').replace(/\D/g, '')
if (!metrikaId) {
  console.warn('[nuxt.config] NUXT_PUBLIC_METRIKA_ID после фильтрации пустой — счётчик Яндекс.Метрики не будет вставлен')
}

// Inline-сниппет Яндекс.Метрики. Код счётчика обязан присутствовать прямо в
// разметке (иначе валидатор установки его не находит, а на SSG ssr-детект не
// срабатывает). ID подставляется на этапе сборки. Хэш этого inline-скрипта
// подхватывает scripts/csp-hashes.mjs из собранного HTML — CSP остаётся строгим.
//
// Метрика не грузится ДВАЖДЫ отсечённая, и оба условия нужны.
//
// 1. Внутри iframe (`window.self !== window.top`) — иначе webvisor писал бы session-replay CRM
//    клиента, а цели (`reachGoal`) пачкали бы аналитику лендинга портальным трафиком.
// 2. На СЛУЖЕБНЫХ маршрутах (`SERVICE_ROUTES`) — вне зависимости от фрейма. Одного признака
//    iframe мало: `/app?preview=1`, открытый в обычной вкладке (разработка, скриншоты, прямая
//    ссылка), считался top-level, счётчик грузился и сыпал в консоль ошибками сертификата. Эти
//    страницы не маркетинговые: мерить на них нечего, а писать session-replay интерфейса, где
//    видны платежи, — тем более.
//
// Список маршрутов берётся из `SERVICE_ROUTES`, а не набирается руками: разъехавшийся дубль тихо
// вернул бы счётчик на новую служебную страницу. `ym` не определён → `useMetrikaGoal()` no-op.
const serviceRoutePattern = SERVICE_ROUTES.map(r => r.replace(/^\//, '')).join('|')
const metrikaSnippet = `if(window.self===window.top&&!/^\\/(${serviceRoutePattern})(\\/|$)/.test(location.pathname)){(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js?id=${metrikaId}','ym');ym(${metrikaId},'init',{ssr:true,webvisor:true,clickmap:true,accurateTrackBounce:true,trackLinks:true});}`

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt',
    '@vueuse/nuxt'
  ],

  // Off: keeps the agent-driven dev sessions (and SSG output) free of devtools noise.
  devtools: { enabled: false },

  app: {
    head: {
      // Инлайн-счётчик Метрики (см. metrikaSnippet выше) + noscript-пиксель.
      script: metrikaId ? [{ innerHTML: metrikaSnippet }] : [],
      noscript: metrikaId
        ? [{ innerHTML: `<div><img src="https://mc.yandex.ru/watch/${metrikaId}" style="position:absolute;left:-9999px;" alt="" /></div>` }]
        : []
    }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Author shown in the landing footer. Override via NUXT_PUBLIC_AUTHOR_*.
      authorName: 'bx-shef',
      authorUrl: 'https://bx-shef.by',
      // Public URL the app is served from. Used by the Bitrix24 install handler
      // to build absolute placement handler URLs once placement.bind lands.
      // Set via NUXT_PUBLIC_SITE_URL at build time (Dockerfile/CI).
      siteUrl: '',
      // Git commit the build came from — shown in the footer as a link to the
      // exact commit. CI passes ${{ github.sha }}; empty in dev.
      commitSha: '',
      // «Локальный режим» для форка/white-label (#39): суть приложения не меняется, но
      // скрываются НАШИ промо/брендинг-баннеры (cross-sell, визитка, карточка Маркета) и попап
      // «оцените приложение». BUILD-TIME: запекается в статику, поэтому задаётся build-arg
      // NUXT_PUBLIC_LOCAL_MODE=1 (Dockerfile/CI форка). Пустое/0 → обычный режим.
      localMode: process.env.NUXT_PUBLIC_LOCAL_MODE || '',
      // Яндекс.Метрика — id счётчика (только цифры, отфильтрован выше).
      metrikaId,
      // Bitrix24 Market listing code override for the «оцените приложение» modal. Empty → the
      // composable falls back to the app's real slug (LANDING_MARKET_CODE in landing.ts). Set
      // NUXT_PUBLIC_B24_MARKET_CODE only to point at a different listing (e.g. a re-publish).
      b24MarketCode: '',
      // Битрикс24 CRM веб-форма (embed) — публичные идентификаторы, не секреты.
      // По умолчанию вшита форма Игоря Шевчика (портал b37817748). Смена — через
      // ENV без перебилда; пустые значения → на лендинге показывается слот.
      b24FormId: process.env.NUXT_PUBLIC_B24_FORM_ID || '1',
      b24FormSecret: process.env.NUXT_PUBLIC_B24_FORM_SECRET || '3c735r',
      b24FormScriptUrl: process.env.NUXT_PUBLIC_B24_FORM_SCRIPT_URL || 'https://cdn-ru.bitrix24.by/b37817748/crm/form/loader_1.js'
    }
  },

  // Static site generation (SSG): the public page is a plain landing, no server.
  compatibilityDate: '2025-01-15',

  // In-portal pages aren't linked from the landing, so the generate crawler would
  // skip them — list them explicitly. `/install` is the Bitrix24 install handler.
  //
  // Список берётся из `app/config/routes.ts` — того же модуля, из которого строятся `sitemap.xml`,
  // `robots.txt` и признак «закрыть от индексации» (#425). Держать его здесь отдельной копией
  // означало бы, что добавленная страница может попасть в пререндер, но не в карту сайта (или
  // наоборот) — и заметить это можно только случайно.
  nitro: {
    prerender: {
      crawlLinks: true,
      // ⚠ `/settings` — ЕСТЬ и обязана пререндериться: её открывает слайдер портала с `/app`
      // (`openSliderAppPage`), то есть портал запрашивает наш собственный адрес. Без файла в
      // статике слайдер откроет 404. (Прежний самодельный `B24Slideover` внутри `/app` снят.)
      // ⚠ `/404.html` сюда добавлять БЕСПОЛЕЗНО — проверено на сборке: Nitro честно проходит этот
      // маршрут, но кладёт ту же SPA-оболочку (разница с `200.html` — ровно наш мета-тег, 48 байт).
      // Страница ошибки рисуется на клиенте, поэтому `noindex` в артефакт вписывает генератор
      // (`injectNoindex` в `scripts/seo-files.mjs`), а не `useHead` из `app/error.vue`.
      routes: PRERENDER_ROUTES
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
