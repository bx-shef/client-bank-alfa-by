export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@vueuse/nuxt'
  ],

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

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
