import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { fileURLToPath } from 'node:url'

const alias = {
  '~': fileURLToPath(new URL('./app', import.meta.url))
}

// Two projects (vitest 4): fast `unit` tests in node (pure functions), and
// `nuxt` tests (composables/components) under a real Nuxt runtime.
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/nuxt/**']
        }
      },
      await defineVitestProject({
        resolve: { alias },
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          // Nuxt cold start + happy-dom can exceed the 5s default on CI.
          testTimeout: 30_000,
          // The `setupNuxt()` beforeAll hook (Nuxt build + env) can exceed the default 10s
          // hookTimeout on a cold/loaded CI runner → intermittent "Hook timed out in 10000ms"
          // (not a logic failure). Give the hook the same generous budget as tests.
          hookTimeout: 60_000
        }
      })
    ]
  }
}))
