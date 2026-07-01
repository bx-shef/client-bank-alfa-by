export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt',
    '@vueuse/nuxt'
  ],

  // Off: keeps the agent-driven dev sessions (and SSG output) free of devtools noise.
  devtools: { enabled: false },

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
      commitSha: ''
    }
  },

  // Static site generation (SSG): the public page is a plain landing, no server.
  compatibilityDate: '2025-01-15',

  // In-portal pages aren't linked from the landing, so the generate crawler would
  // skip them — list them explicitly. `/install` is the Bitrix24 install handler.
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/app', '/settings', '/install']
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
