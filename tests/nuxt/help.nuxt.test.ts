import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HelpPage from '~/pages/help.vue'
import { FAQ } from '~/utils/faq'

// Страница справки (#576 п.1). Проверяется не «нарисовалось хоть что-то», а ровно то, на чём
// держатся контекстные ссылки: якорь раздела в разметке. Сломай его — `place` из слайдера
// по-прежнему приводит на `/help`, но не туда, где ответ, и снаружи это выглядит как «справка
// открывается не на том месте».

describe('страница справки', () => {
  it('каждый раздел рисуется и несёт СВОЙ якорь', async () => {
    const w = await mountSuspended(HelpPage)
    const sections = w.findAll('[data-testid="faq-entry"]')
    expect(sections).toHaveLength(FAQ.length)
    for (const [i, entry] of FAQ.entries()) {
      expect(sections[i]!.attributes('id'), `раздел ${entry.id} без якоря`).toBe(entry.id)
      expect(sections[i]!.text()).toContain(entry.question)
      for (const p of entry.answer) expect(sections[i]!.text()).toContain(p)
    }
  })

  it('оглавление ведёт на реальные якоря', async () => {
    // Страница длинная, а приходят на неё с одним вопросом: битая ссылка оглавления возвращает
    // человека к прокрутке — то есть к тому, от чего оглавление и спасает.
    const w = await mountSuspended(HelpPage)
    const hrefs = w.find('[data-testid="faq-toc"]').findAll('a').map(a => a.attributes('href'))
    expect(hrefs).toEqual(FAQ.map(e => `#${e.id}`))
  })

  it('промпт для ИИ-помощника показан целиком, а не обрезан', async () => {
    const w = await mountSuspended(HelpPage)
    expect(w.find('[data-testid="faq-agent"]').text()).toContain('Отвечай только тем, что написано')
  })
})
