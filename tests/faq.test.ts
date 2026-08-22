import { describe, expect, it } from 'vitest'
import { FAQ, FAQ_AGENT_PROMPT, FAQ_INTRO, buildLlmsTxt } from '~/utils/faq'
import { LANDING_SITE_URL } from '~/utils/seo'

// Справка — ОДИН источник на две поверхности (#576 п.1). Тест держит ровно это: страница и
// `llms.txt` обязаны говорить одно и то же, а якоря — оставаться пригодными для ссылок.

describe('справка', () => {
  it('якоря уникальны и пригодны для адреса', () => {
    // ⚠ Якорь уезжает в URL и в контекстные ссылки «Что это значит?». Кириллица или пробел
    // означали бы процентное кодирование в ссылке, которую человек пересылает в чат.
    const ids = FAQ.map(e => e.id)
    expect(new Set(ids).size, 'дублирующийся якорь — ссылка ведёт не туда').toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('у каждого раздела есть вопрос и непустой ответ', () => {
    for (const e of FAQ) {
      expect(e.question.trim().length, e.id).toBeGreaterThan(0)
      expect(e.answer.length, `${e.id}: пустой ответ`).toBeGreaterThan(0)
      for (const p of e.answer) expect(p.trim().length, e.id).toBeGreaterThan(0)
    }
  })

  it('текст ПЛОСКИЙ — без разметки', () => {
    // ⚠ Разметка в источнике заставила бы одну из сторон её вырезать, а вырезают такое обычно
    // регуляркой, которая однажды съест не то. `llms.txt` — простой текст по своему устройству.
    const all = [FAQ_INTRO, FAQ_AGENT_PROMPT, ...FAQ.flatMap(e => [e.question, ...e.answer])]
    for (const s of all) {
      expect(s, 'HTML в справке').not.toMatch(/<[a-z/]/i)
      expect(s, 'markdown-заголовок или список в справке').not.toMatch(/(^|\n)\s*(#|[*-]\s)/)
    }
  })

  it('llms.txt несёт ВЕСЬ текст справки, а не выжимку', () => {
    // ⚠ Это и есть проверка «одного источника»: выборочный экспорт — тот самый способ, которым
    // агентская копия расходится с человеческой молча.
    const txt = buildLlmsTxt(LANDING_SITE_URL)
    expect(txt).toContain(FAQ_INTRO)
    expect(txt).toContain(FAQ_AGENT_PROMPT)
    for (const e of FAQ) {
      expect(txt, `нет вопроса ${e.id}`).toContain(e.question)
      for (const p of e.answer) expect(txt, `нет абзаца из ${e.id}`).toContain(p)
    }
  })

  it('llms.txt указывает на справку по каноническому домену', () => {
    expect(buildLlmsTxt(LANDING_SITE_URL)).toContain(`${LANDING_SITE_URL}/help`)
  })

  it('без базового URL ссылок нет вовсе, а не относительных', () => {
    // Относительная ссылка в документе, который читает чужой агент, ведёт в никуда.
    const txt = buildLlmsTxt('')
    expect(txt).not.toContain('Справка:')
    expect(txt).toContain(FAQ_INTRO)
  })

  it('файл заканчивается ровно одним переводом строки и без тройных пустых', () => {
    const txt = buildLlmsTxt(LANDING_SITE_URL)
    expect(txt.endsWith('\n')).toBe(true)
    expect(txt).not.toMatch(/\n{3}/)
  })
})
