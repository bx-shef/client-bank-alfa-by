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

// ── Период показа (#42) ─────────────────────────────────────────────────────────────────────────
// ⚠ Проверяем ПРОВОДКУ, а не только присутствие кнопок: витрина брала последние 50 записей реестра
// без привязки к датам, поэтому важно, что смена периода реально перезапрашивает фид С ГРАНИЦАМИ.
// Под `?preview=1` «сегодня» ФИКСИРОВАНО (`PREVIEW_TODAY`) — иначе и эталоны, и эти утверждения
// зависели бы от календаря машины.
describe('app: период показа (#42)', () => {
  it('рисует все пресеты и подпись «за какой период»', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const text = wrapper.text()
    for (const label of ['День', '2 дня', '3 дня', 'Неделя', 'Месяц', 'Квартал', 'Год', 'Диапазон']) {
      expect(text).toContain(label)
    }
    // Умолчание — месяц от фиксированного дня превью.
    expect(text).toContain('с 26 мая 2026 по 24 июня 2026')
  })

  // ⚠ Подпись описывает ПРИМЕНЁННЫЙ период. Клик по «Диапазон» запроса не шлёт (границы пусты), и
  // подпись обязана остаться прежней — иначе над месячным списком мгновенно встало бы «за всё
  // время», то есть экран соврал бы о том, что показывает.
  it('«Диапазон» открывает поле выбора и НЕ переписывает подпись', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const btn = wrapper.findAll('button').find(b => b.text().trim() === 'Диапазон')
    await btn!.trigger('click')
    await new Promise(r => setTimeout(r, 0))
    expect(wrapper.text()).toContain('Свой период')
    expect(wrapper.text()).toContain('с 26 мая 2026 по 24 июня 2026')
    expect(wrapper.text()).not.toContain('за всё время')
  })

  it('клик по «День» применяет однодневный период — подпись меняется на день', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    const dayBtn = wrapper.findAll('button').find(b => b.text().trim() === 'День')
    await dayBtn!.trigger('click')
    await new Promise(r => setTimeout(r, 0))
    expect(wrapper.text()).toContain('за 24 июня 2026')
  })

  // ⚠ Период попадает и в ЗАГОЛОВОК СВОДКИ: задача заведена ровно потому, что числа над списком
  // были «за неизвестно что», и подпись только у списка оставила бы дефект на месте.
  it('сводка над списком тоже названа периодом', async () => {
    const wrapper = await mountSuspended(AppPage, PREVIEW)
    expect(wrapper.text()).toContain('Сводка по операциям с 26 мая 2026 по 24 июня 2026')
  })
})
