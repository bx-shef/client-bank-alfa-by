import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HelpLink from '~/components/HelpLink.vue'
import { APP_SLIDER_WIDTH } from '~/config/b24'

// Контекстная ссылка в справку (#576 п.2). Логика короткая, но обе её половины отказывают ТИХО:
// не открылся слайдер — кнопка «ничего не делает»; открылся не на том якоре — человек попадает не
// туда, где ответ на его вопрос.

const openAppSlider = vi.hoisted(() => vi.fn(async () => true))
const navigateSpy = vi.hoisted(() => vi.fn(async () => 'navigated'))

vi.mock('~/composables/useB24', () => ({ useB24: () => ({ openAppSlider }) }))
vi.mock('#app/composables/router', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, navigateTo: navigateSpy }
})

afterEach(() => {
  openAppSlider.mockClear().mockResolvedValue(true)
  navigateSpy.mockClear()
})

describe('HelpLink', () => {
  it('открывает справку слайдером портала на своём якоре', async () => {
    const w = await mountSuspended(HelpLink, { props: { anchor: 'exclusions' } })
    await w.find('[data-testid="help-link"]').trigger('click')
    expect(openAppSlider).toHaveBeenCalledWith('app-help-exclusions', {
      width: APP_SLIDER_WIDTH,
      title: 'Справка'
    })
    // Слайдер открылся — второй навигации быть не должно, иначе фрейм уедет из настроек.
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('портал отказал во вложенном слайдере — уходим обычной навигацией', async () => {
    // ⚠ Без фолбэка кнопка молча ничего не делала бы: справку зовут из УЖЕ открытого слайдера,
    // и отказ во вложенном — штатный ответ портала, а не поломка.
    openAppSlider.mockResolvedValue(false)
    const w = await mountSuspended(HelpLink, { props: { anchor: 'not-working' } })
    await w.find('[data-testid="help-link"]').trigger('click')
    expect(navigateSpy).toHaveBeenCalledWith({ path: '/help', hash: '#not-working' })
  })

  it('подпись по умолчанию и своя', async () => {
    const def = await mountSuspended(HelpLink, { props: { anchor: 'my-company' } })
    expect(def.text()).toBe('Что это значит?')
    const own = await mountSuspended(HelpLink, { props: { anchor: 'my-company', label: 'Почему так?' } })
    expect(own.text()).toBe('Почему так?')
  })
})
