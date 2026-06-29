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
  // Only `/` exists today, so the generate crawler covers everything and no
  // `nitro.prerender.routes` is needed. Add it when isolated, unlinked routes
  // appear (e.g. a Bitrix24 `/install` or widget page) so they get prerendered.
  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
