import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app.vue'

// Страница закрыта гейтом «только внутри портала» (#414), а в тестовой среде фрейма нет.
// `?preview=1` — тот самый штатный обход, на котором держатся и скриншоты: тест ходит той же
// дверью, что и визуальная приёмка, а не отключает гейт моком. Флаг задаём МАРШРУТОМ, а не
// `history.replaceState`: гейт читает его из роутера (на гидратации пререндеренной страницы
// `window.location.search` пуст — проверено на собранной статике).
const PREVIEW = { route: '/app?preview=1' }

// Standalone render (no B24 frame in the test env): useB24().init() no-ops, so the page is
// neither blocked nor nagged (setup banner is portal-only) and shows the real operations view —
// which is EMPTY (no demo data anymore). The backend operations feed (#5) fills it later.
describe('app statement page (no demo data)', () => {
  it('renders the operations card and filter chips with zero counts', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const text = wrapper.text()
    expect(text).toContain('Последние операции')
    // Chip filter counts are all zero — there is no mock statement.
    expect(text).toContain('Все (0)')
    expect(text).toContain('Приходы (0)')
    expect(text).toContain('Расходы (0)')
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
