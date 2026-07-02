import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import LoginPage from '~/pages/login.vue'

// login.vue smoke test (#65): the page mounts (public, noindex) and its form
// submits the entered credentials through useAuth().login. The error-status →
// message mapping and the redirect guard are covered by pure unit tests
// (server/utils/session decideLogin + tests/loginRedirect.test.ts); here we just
// assert the page wires the form to login with the right values.
const loginSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, user: 'operator', exp: 1 })))

vi.mock('~/composables/useAuth', () => ({
  useAuth: () => ({ login: loginSpy, logout: vi.fn(), fetchSession: vi.fn() })
}))

describe('login.vue', () => {
  it('renders the operator login form (noindex, prefilled user)', async () => {
    const wrapper = await mountSuspended(LoginPage)
    expect(wrapper.text()).toContain('Вход для сотрудников')
    expect((wrapper.find('input[name="username"]').element as HTMLInputElement).value).toBe('operator')
    expect(wrapper.find('input[name="password"]').exists()).toBe(true)
  })

  it('submits the entered credentials through useAuth().login', async () => {
    loginSpy.mockClear()
    const wrapper = await mountSuspended(LoginPage)
    await wrapper.find('input[name="password"]').setValue('s3cret')
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()
    expect(loginSpy).toHaveBeenCalledWith('operator', 's3cret')
  })
})
