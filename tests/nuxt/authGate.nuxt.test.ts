import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import AuthGate from '~/components/AuthGate.vue'

// Клиентская половина fail-closed-гейта служебной зоны. Проверяется ровно то, что сервер решать
// не может: увидит ли человек содержимое страницы. Раньше клиент решал по `!configured`, поэтому
// в проде без пароля рисовал бы полный интерфейс, каждый запрос которого возвращает 401.

const session = { value: { configured: false, authenticated: false, open: true } as Record<string, unknown> }
let shouldThrow = false

vi.mock('~/composables/useAuth', () => ({
  useAuth: () => ({
    fetchSession: () => (shouldThrow ? Promise.reject(new Error('backend down')) : Promise.resolve(session.value)),
    login: vi.fn(),
    logout: vi.fn()
  })
}))

const Probe = defineComponent({
  setup: () => () => h(AuthGate, null, { default: () => h('p', 'СЕКРЕТНОЕ СОДЕРЖИМОЕ') })
})

async function render() {
  const wrapper = await mountSuspended(Probe)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  shouldThrow = false
  session.value = { configured: false, authenticated: false, open: true }
})

describe('AuthGate', () => {
  it('пускает, когда зона открыта (нет пароля вне прода)', async () => {
    expect((await render()).text()).toContain('СЕКРЕТНОЕ СОДЕРЖИМОЕ')
  })

  it('пускает по действующей сессии', async () => {
    session.value = { configured: true, authenticated: true, open: false }
    expect((await render()).text()).toContain('СЕКРЕТНОЕ СОДЕРЖИМОЕ')
  })

  it('ПРОД без пароля: контент скрыт и объяснено, что делать', async () => {
    // Ключевой случай инцидента: пароль не задан, но зона закрыта. Редирект на /login тут не
    // годится — там 503, и владелец крутился бы между страницей и формой.
    session.value = { configured: false, authenticated: false, open: false }
    const text = (await render()).text()
    expect(text).not.toContain('СЕКРЕТНОЕ СОДЕРЖИМОЕ')
    expect(text).toContain('Служебная зона закрыта')
    expect(text).toContain('PUBLIC_PAGE_BASIC_AUTH_PASS')
  })

  it('пароль задан, сессии нет: контент скрыт (уводит middleware)', async () => {
    session.value = { configured: true, authenticated: false, open: false }
    const text = (await render()).text()
    expect(text).not.toContain('СЕКРЕТНОЕ СОДЕРЖИМОЕ')
    expect(text).not.toContain('Служебная зона закрыта')
  })

  it('backend недоступен — не блокируем UI (защита всё равно на API)', async () => {
    shouldThrow = true
    expect((await render()).text()).toContain('СЕКРЕТНОЕ СОДЕРЖИМОЕ')
  })
})
