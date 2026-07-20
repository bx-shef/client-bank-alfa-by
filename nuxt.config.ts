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
// Self-silence внутри iframe (`window.self !== window.top`): in-portal-страницы
// (`/app`,`/settings`,`/install`, layout `clear`) открываются внутри портала Б24,
// и Метрика там НЕ инициализируется — иначе webvisor писал бы session-replay CRM
// клиента, а цели (`reachGoal`) пачкали бы аналитику лендинга портальным трафиком.
// `ym` тогда не определён → `useMetrikaGoal().reachGoal()` сам становится no-op.
// Тот же приём, что в `currency-converter` (там — в `public/metrika.js`). На
// standalone-листинге Маркета (self===top) счётчик грузится как обычно.
const metrikaSnippet = `if(window.self===window.top){(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js?id=${metrikaId}','ym');ym(${metrikaId},'init',{ssr:true,webvisor:true,clickmap:true,accurateTrackBounce:true,trackLinks:true});}`

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
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/app', '/settings', '/install', '/import', '/queues', '/login', '/partners']
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
