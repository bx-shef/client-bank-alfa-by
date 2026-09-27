// Маршруты — из единого источника (#425): из него же строятся sitemap.xml, robots.txt и признак
// «закрыть от индексации». Копия списка здесь означала бы, что страница может попасть в пререндер,
// но не в карту сайта (или наоборот), и заметить это можно только случайно.
import { PRERENDER_ROUTES, SERVICE_ROUTES } from './app/config/routes'
import { destr } from 'destr'
import { isLocalMode } from './app/utils/localMode'
import { resolveMetrikaId } from './app/utils/metrika'

// Счётчик — по тому же правилу, по которому `useMetrikaGoal` шлёт цели (`resolveMetrikaId`):
// заданный (только цифры — защита от опечатки или компрометации ENV в CI) или наш, но наш только
// вне локального режима. Одна функция на оба места — иначе сниппет и цели разойдутся, как уже
// разошлись с #701.
// ⚠ И ОДНО представление значения: переменные разбираются тем же `destr`, которым Nitro кладёт
// их в конфиг. Без этого одна функция видела бы разные входы: `1e5` здесь строка («15» после
// отсева нецифр), а в конфиге число 100000; `"1"` в кавычках здесь не включение, а в конфиге — «1».
const metrikaId = resolveMetrikaId(
  destr(process.env.NUXT_PUBLIC_METRIKA_ID),
  isLocalMode(destr(process.env.NUXT_PUBLIC_LOCAL_MODE))
)
if (process.env.NUXT_PUBLIC_METRIKA_ID?.trim() && !metrikaId) {
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
      // ⚠ У КАЖДОГО ключа этого блока умолчание пустое, а запасное значение живёт в функции, которая
      // конфиг читает (`resolveAuthor`, `resolveMetrikaId`, `resolveB24Form`, `useAppCode`,
      // `resolveRepoUrl`). Причина: пустая переменная сборки ПЕРЕКРЫВАЕТ умолчание конфига, а
      // `Dockerfile` выставляет её пустой всякий раз, когда переменная репозитория не задана. Так с
      // #701 (2026-09-13) на проде пропали форма заявок и цели Метрики (замерено 2026-09-27), а у
      // клонов — подпись в подвале. Непустое умолчание здесь запрещает
      // `tests/nuxtConfigEnv.test.ts` — он загружает этот конфиг и проверяет вычисленные значения.
      // ⚠ Значения приходят через `destr`: `1` становится числом, `true` — булевым.
      //
      // Автор в подвале (#758). Пусто ⇒ «ИП Шевчик И. С.» со ссылкой на оффер — см. `resolveAuthor`.
      authorName: '',
      authorUrl: '',
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
      // Репозиторий ЭТОЙ сборки — для подписи «сборка <sha>» и для `/api/health`. Пусто ⇒ апстрим
      // (`REPO_URL` в `app/utils/build.ts`). Задаётся у КЛОНА (docs/DEPLOY_BITRIXVM.md): иначе
      // ссылка ведёт в наш репозиторий, куда у клиента доступа нет.
      repoUrl: process.env.NUXT_PUBLIC_REPO_URL || '',
      // Яндекс.Метрика — id счётчика для целей. Пусто ⇒ наш вне локального режима — см.
      // `resolveMetrikaId` (сниппет выше строится той же функцией).
      metrikaId: '',
      // КОД ПРИЛОЖЕНИЯ НА ПОРТАЛЕ — им портал открывает наши экраны по ссылке
      // `/marketplace/view/<код>/` (#19) и им же помечен канал pull-синхронизации настроек.
      // У тиражного это символьный код Маркета (`shef.bankimport`), у ЛОКАЛЬНОГО приложения —
      // `client_id` (`local.…`), то есть значение СВОЁ у каждой установки-клона.
      // Пусто ⇒ `LANDING_MARKET_CODE` — см. `useAppCode`.
      //
      // ⚠ Переменной «код нашего ЛИСТИНГА в Маркете» здесь НЕТ намеренно (решение владельца,
      // 2026-09-13): у клона листинга не существует ни нашего, ни своего, а нам код листинга
      // задаёт константа `LANDING_MARKET_CODE` — она же строит публичный адрес карточки на
      // лендинге. Переменная давала бы ВТОРОЙ ответ на вопрос с одним ответом.
      b24AppCode: '',
      // Битрикс24 CRM веб-форма заявок (embed) — публичные идентификаторы, не секреты. Пусто ⇒
      // наша форма вне локального режима, заглушка в локальном — см. `resolveB24Form`.
      b24FormId: '',
      b24FormSecret: '',
      b24FormScriptUrl: ''
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
