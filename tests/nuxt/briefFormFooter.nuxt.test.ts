import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import BriefForm from '~/components/BriefForm.vue'
import BuildFooter from '~/components/BuildFooter.vue'
import { DEFAULT_AUTHOR_NAME, DEFAULT_AUTHOR_URL } from '~/utils/build'
import { DEFAULT_METRIKA_ID } from '~/utils/metrika'

// Проводка компонентов на значениях конфига В ФОРМЕ СБОРКИ (#758): пустая строка там, где
// переменная репозитория не задана, и число `1` у `NUXT_PUBLIC_LOCAL_MODE=1` (destr). До #758
// `BriefForm` читал сырой конфиг, и на проде с #701 вместо формы заявок висела заглушка, а цель
// `brief_submit` не уходила; подменять композаблы здесь нельзя — ровно их проводку и проверяем.

type WithYm = Window & { ym?: (...args: unknown[]) => void }

const KEYS = ['b24FormId', 'b24FormSecret', 'b24FormScriptUrl', 'metrikaId', 'localMode', 'authorName', 'authorUrl']
const pub = () => useRuntimeConfig().public as Record<string, unknown>
let saved: Record<string, unknown> = {}

function setConfig(values: Record<string, unknown>) {
  const p = pub()
  saved = Object.fromEntries(KEYS.map(k => [k, p[k]]))
  Object.assign(p, Object.fromEntries(KEYS.map(k => [k, ''])), values)
}

afterEach(() => {
  Object.assign(pub(), saved)
  delete (window as WithYm).ym
})

describe('BriefForm', () => {
  it('переменные пусты (как на проде) — наша форма, а не заглушка', async () => {
    setConfig({})
    const w = await mountSuspended(BriefForm)
    const src = w.find('iframe').attributes('src') ?? ''
    expect(src).toMatch(/^\/b24-form\.html\?/)
    expect(decodeURIComponent(src)).toContain('form=inline/1/3c735r')
    expect(w.text()).not.toContain('Слот под CRM-форму')
  })

  it('локальный режим числом (NUXT_PUBLIC_LOCAL_MODE=1 после destr) — заглушка, нашей формы нет', async () => {
    setConfig({ localMode: 1 })
    const w = await mountSuspended(BriefForm)
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.text()).toContain('Слот под CRM-форму')
  })

  it('отправка формы — цель brief_submit на наш счётчик; чужой источник — нет', async () => {
    setConfig({})
    const ym = vi.fn()
    ;(window as WithYm).ym = ym
    await mountSuspended(BriefForm)
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: 'b24:form:submit' }))
    expect(ym).not.toHaveBeenCalled()
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: 'b24:form:submit' }))
    expect(ym).toHaveBeenCalledWith(Number(DEFAULT_METRIKA_ID), 'reachGoal', 'brief_submit')
  })
})

describe('BuildFooter', () => {
  it('переменные пусты — наше имя со ссылкой на оффер; год помечен для маски снимков', async () => {
    setConfig({})
    const w = await mountSuspended(BuildFooter)
    const link = w.findAll('a').find(a => a.text().includes(DEFAULT_AUTHOR_NAME))
    expect(link?.attributes('href')).toBe(DEFAULT_AUTHOR_URL)
    expect(w.find('[data-testid="footer-author"]').exists()).toBe(false)
    // Маска визуальных снимков ищет год по этому атрибуту: без него 1 января краснеют все эталоны.
    expect(w.find('[data-testid="footer-year"]').exists()).toBe(true)
  })

  it('своё имя без адреса — текстом, без ссылки и без пустой кнопки', async () => {
    setConfig({ authorName: 'ООО Ромашка' })
    const w = await mountSuspended(BuildFooter)
    expect(w.find('[data-testid="footer-author"]').text()).toBe('ООО Ромашка')
    expect(w.findAll('a').some(a => a.text().includes('ООО Ромашка'))).toBe(false)
    expect(w.findAll('button').some(b => b.text().includes('ООО Ромашка'))).toBe(false)
  })
})
