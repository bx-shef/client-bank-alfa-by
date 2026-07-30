import { describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'

// Проводка гейта (#414). Чистое решение покрыто в `tests/inPortalGate.test.ts`, здесь — ровно то,
// что оно доехало до разметки: тело страницы НЕ рендерится снаружи портала. Без этого теста правка
// шаблона (например `v-if="state !== 'checking'"`) прошла бы мимо всей зелёной сборки.

const state = vi.hoisted(() => ({ inFrame: false }))

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => state.inFrame }) }
})

const InPortalGate = await import('~/components/InPortalGate.vue').then(m => m.default)

const BODY = 'ТЕЛО-СТРАНИЦЫ'
const slots = { default: () => h('p', BODY) }

/** Смонтировать и ДОЖДАТЬСЯ асинхронной проверки фрейма — до неё гейт честно висит в «проверяем». */
async function mountGate(route?: string) {
  const w = await mountSuspended(InPortalGate, route ? { slots, route } : { slots })
  await flushPromises()
  await nextTick()
  return w
}

describe('InPortalGate', () => {
  it('внутри портала отдаёт слот', async () => {
    state.inFrame = true
    const w = await mountGate()
    expect(w.text()).toContain(BODY)
    expect(w.find('[data-testid="portal-gate-outside"]').exists()).toBe(false)
  })

  it('снаружи портала показывает заглушку и НЕ рендерит тело', async () => {
    state.inFrame = false
    const w = await mountGate()
    expect(w.find('[data-testid="portal-gate-outside"]').exists()).toBe(true)
    expect(w.text()).not.toContain(BODY)
  })

  it('?preview=1 открывает тело даже вне портала', async () => {
    // Единственное место, где обход проверяется НАПРЯМУЮ. Он читается из роутера, а не из
    // `window.location.search` (на гидратации пререндеренной страницы строка запроса пуста) —
    // именно эта ошибка и была поймана на собранной статике, а не тестами.
    state.inFrame = false
    const w = await mountGate('/app?preview=1')
    expect(w.text()).toContain(BODY)
    expect(w.find('[data-testid="portal-gate-outside"]').exists()).toBe(false)
  })
})
