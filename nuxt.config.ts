export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@vueuse/nuxt'
  ],

  // Off: keeps the agent-driven dev sessions (and SSG output) free of devtools noise.
  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Author shown in the landing footer. Override via NUXT_PUBLIC_AUTHOR_*.
      authorName: 'bx-shef',
      authorUrl: 'https://bx-shef.by'
    }
  },

  // Static site generation (SSG): the public page is a plain landing, no server.
  compatibilityDate: '2025-01-15',

  // `/app` (the in-portal statement view) isn't linked from the landing, so the
  // generate crawler would skip it — list it explicitly. More routes (/install,
  // widget) get added here as the Bitrix24 integration lands.
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/app', '/settings']
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
