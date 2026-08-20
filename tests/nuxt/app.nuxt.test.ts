import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app.vue'

// Страница закрыта гейтом «только внутри портала» (#414), а в тестовой среде фрейма нет.
// `?preview=1` — тот самый штатный обход, на котором держатся и скриншоты: тест ходит той же
// дверью, что и визуальная приёмка, а не отключает гейт моком. Флаг задаём МАРШРУТОМ, а не
// `history.replaceState`: гейт читает его из роутера (на гидратации пререндеренной страницы
// `window.location.search` пуст — проверено на собранной статике).
const PREVIEW = { route: '/app?preview=1' }

// Рендер через preview-обход (фрейма в тестовой среде нет, гейт без обхода показал бы заглушку).
// Баннер «не настроено» — портальный, поэтому не мешает; список операций РЕАЛЬНЫЙ и пустой
// (демо-данных больше нет). Фид операций с backend (#5) наполнит его позже.
describe('app statement page', () => {
  it('под `?preview=1` показывает демо-набор — вёрстку длинного списка есть на чём смотреть', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const text = wrapper.text()
    expect(text).toContain('Последние операции')
    // Счётчики чипов считают демо-набор: он существует ради вёрстки (скриншоты, визуальные тесты).
    expect(text).toMatch(/Все \((?!0\))\d+\)/)
  })

  it('БЕЗ `?preview=1` список пуст — в портале демо-платежей быть не должно', async () => {
    // Иначе бухгалтер увидит чужие платежи и решит, что импорт уже работает. Гейт — тот же флаг,
    // что открывает `InPortalGate`, поэтому здесь страница монтируется без него: контента не будет
    // вовсе, и проверяем именно отсутствие демо-строк.
    // ⚠ Сверяемся со строкой, которая в наборе ЕСТЬ. Прежний ассерт искал контрагента из
    // старого набора; после его замены строки не стало нигде, и тест проходил бы даже с
    // распахнутым гейтом — то есть защищал ровно ничего.
    const wrapper = await mountSuspended(AppPage, { route: '/app' })
    expect(wrapper.text()).not.toContain('ДЕМО-БАНК')
    expect(wrapper.text()).not.toContain('ВАСИЛЁК')
  })

  it('no demo-data notice and no app-level test setting', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const text = wrapper.text()
    expect(text).not.toContain('Демо-данные')
    expect(text).not.toContain('Тестовая настройка')
  })

  it('links to the manual upload page', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    expect(wrapper.text()).toContain('Загрузить выписку')
  })
})
