import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import type { SetupStatus } from '~/composables/useSetupStatus'

// Полоса статуса импорта на /app (#528, 3.5). Правило: показываем, если прогон был ИЛИ есть чему
// запускаться, — и НЕ прячем, когда состояние настройки прочитать не удалось.
//
// ⚠ Последнее — не деталь: `/api/setup-status` admin-only и не-админу отвечает 403. Спрячь мы
// полосу «за компанию», бухгалтер и админ видели бы на одном портале разное.

const DEFAULTS: SetupStatus = {
  connectedAccounts: 0,
  pendingAccounts: 0,
  pollEnabled: false,
  pollIntervalMin: 5,
  lastRunMs: null
}

function mockSetup(status: Partial<SetupStatus>, error = '') {
  vi.doMock('~/composables/useSetupStatus', () => ({
    useSetupStatus: () => ({
      status: ref({ ...DEFAULTS, ...status }),
      inFrame: ref(true),
      loading: ref(false),
      loaded: ref(true),
      error: ref(error),
      load: async () => {}
    })
  }))
}

async function mountApp() {
  const AppPage = (await import('~/pages/app.vue')).default
  return mountSuspended(AppPage, { route: '/app?preview=1' })
}

afterEach(() => {
  vi.doUnmock('~/composables/useSetupStatus')
  vi.resetModules()
})

describe('полоса статуса импорта', () => {
  it('молчит, пока прогонов не было и подключать нечего', async () => {
    // Иначе «Ещё не запускалась» сообщает не о состоянии импорта, а о незаконченной настройке —
    // про это уже говорит экран готовности, и вторая формулировка читается как поломка.
    mockSetup({ connectedAccounts: 0 })
    expect((await mountApp()).text()).not.toContain('Ещё не запускалась')
  })

  it('появляется, как только подключён счёт', async () => {
    mockSetup({ connectedAccounts: 1 })
    expect((await mountApp()).text()).toContain('Ещё не запускалась')
  })

  it('появляется и когда состояние настройки прочитать НЕ удалось (403 у не-админа)', async () => {
    mockSetup({ connectedAccounts: 0 }, 'Не удалось загрузить состояние настройки')
    expect((await mountApp()).text()).toContain('Ещё не запускалась')
  })
})
