import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import StatementUpload from '~/components/StatementUpload.vue'

// Локальный режим форка (#39): промо/брендинг-баннеры скрыты, когда флаг включён. Проверяем
// ПРОВОДКУ (`v-if="!localMode"`) на попапе «оцените приложение» (`AppRatingModal`) в `StatementUpload`
// — это простой носитель без портал-логики. Ядро флага (`isLocalMode`) покрыто unit-тестом.

const local = vi.hoisted(() => ({ value: false }))
vi.mock('~/composables/useLocalMode', () => ({ useLocalMode: () => local.value }))

afterEach(() => {
  local.value = false
})

async function mount() {
  const w = await mountSuspended(StatementUpload)
  await flushPromises()
  return w
}

describe('локальный режим прячет промо (#39)', () => {
  it('обычный режим — попап «оцените приложение» в дереве', async () => {
    local.value = false
    const w = await mount()
    expect(w.findComponent({ name: 'AppRatingModal' }).exists()).toBe(true)
  })

  it('локальный режим — попап «оцените приложение» скрыт', async () => {
    local.value = true
    const w = await mount()
    expect(w.findComponent({ name: 'AppRatingModal' }).exists()).toBe(false)
  })
})
