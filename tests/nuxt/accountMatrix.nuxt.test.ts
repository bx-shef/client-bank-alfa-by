import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import AccountMatrix from '~/components/AccountMatrix.vue'
import type { MatrixRow } from '~/utils/bankAccountMatrix'
import type { MatrixProviderStatus } from '~/composables/useBankMatrix'

// Сверка «наш счёт ↔ счёт в банке» (#494). Компонент презентационный (данные приходят пропсами из
// карточки подключения — она делит один запрос со списком подключений), поэтому проверяется именно
// то, что чистое ядро не видит: КАКОЕ состояние экрана видит админ.
//
// Главное здесь — что «банк не ответил» и «в реквизитах пусто» выглядят по-разному. Слить их в
// один пустой экран значит отправить админа править исправные реквизиты.

function mountMatrix(over: Partial<{
  rows: MatrixRow[]
  providers: MatrixProviderStatus[]
  loading: boolean
  loaded: boolean
  error: string
}> = {}) {
  return mountSuspended(AccountMatrix, {
    props: { rows: [], providers: [], loading: false, loaded: true, error: '', ...over }
  })
}

const matched: MatrixRow = {
  state: 'matched',
  crm: { companyId: '7', number: 'BY11ALFA0001' },
  bank: { number: 'BY11ALFA0001' },
  connected: true
}

/** Счёт из реквизитов, про который банк в этот прогон промолчал (хвост #539). */
const unchecked: MatrixRow = {
  state: 'unchecked',
  crm: { companyId: '7', number: 'BY11ALFA0002' },
  connected: false
}

describe('AccountMatrix', () => {
  it('пока сверяем — говорит об этом, а не показывает пустоту', async () => {
    const w = await mountMatrix({ loading: true, loaded: false })
    expect(w.text()).toContain('Сверяем')
    expect(w.find('[data-testid="matrix-empty"]').exists()).toBe(false)
  })

  it('всё сходится — одна спокойная строка, без перечисления', async () => {
    const w = await mountMatrix({ rows: [matched] })
    await flushPromises()
    expect(w.find('[data-testid="matrix-clean"]').exists()).toBe(true)
    expect(w.find('[data-testid="matrix-problems"]').exists()).toBe(false)
  })

  it('счёт есть в банке, но нет в реквизитах — красная строка с инструкцией', async () => {
    const w = await mountMatrix({
      rows: [{ state: 'bank-only', bank: { number: 'BY11ALFA9999' }, connected: false }]
    })
    await flushPromises()
    expect(w.find('[data-testid="matrix-row-bank-only"]').exists()).toBe(true)
    expect(w.text()).toContain('BY11ALFA9999')
    expect(w.text()).toContain('Добавьте номер в реквизиты')
  })

  it('«записан иначе» показан ОТДЕЛЬНО от совпадения — иначе экран зелёный, а импорт сломан', async () => {
    const w = await mountMatrix({
      rows: [{
        state: 'looks-same',
        crm: { companyId: '7', number: 'BY11 ALFA 0001' },
        bank: { number: 'BY11ALFA0001' },
        connected: true
      }]
    })
    await flushPromises()
    expect(w.find('[data-testid="matrix-row-looks-same"]').exists()).toBe(true)
    expect(w.find('[data-testid="matrix-clean"]').exists()).toBe(false)
    // Обе стороны видны рядом — именно ради этого экран и существует.
    expect(w.text()).toContain('BY11 ALFA 0001')
    expect(w.text()).toContain('BY11ALFA0001')
  })

  it('рабочие строки не пропадают из счёта, когда есть проблемные', async () => {
    const w = await mountMatrix({
      rows: [{ state: 'bank-only', bank: { number: 'BY9' }, connected: false }, matched, matched]
    })
    await flushPromises()
    expect(w.find('[data-testid="matrix-matched-count"]').text()).toContain('2 счёта сходятся')
  })

  it('одна рабочая строка — фраза человеческая, а не «Остальные 1»', async () => {
    // ⚠ Замечание владельца: «Остальные 1 — сходятся» читается как обрывок и как ошибка
    // склонения. Считаем словами; остальные числа склоняет общий `pluralRu`, а не ручной `=== 1`
    // в шаблоне — такой суррогат уже давал «5 портала(ов)» в другом месте.
    const w = await mountMatrix({
      rows: [{ state: 'bank-only', bank: { number: 'BY9' }, connected: false }, matched]
    })
    await flushPromises()
    const note = w.find('[data-testid="matrix-matched-count"]').text()
    expect(note).toBe('Ещё один счёт сходится.')
    expect(note, 'вернулась прежняя формулировка').not.toContain('Остальные')
  })

  it('отказ банка показан отдельной тревогой, а не как «банк не отдал ни одного счёта»', async () => {
    const w = await mountMatrix({
      rows: [unchecked],
      providers: [{ provider: 'alfa-by', count: 0, error: 'банк не ответил (503)' }]
    })
    await flushPromises()
    expect(w.find('[data-testid="matrix-provider-error-alfa-by"]').exists()).toBe(true)
    expect(w.text()).toContain('банк не ответил (503)')
  })

  it('сверять нечего — объясняет, что сделать', async () => {
    const w = await mountMatrix()
    await flushPromises()
    expect(w.find('[data-testid="matrix-empty"]').text()).toContain('реквизиты')
  })

  it('ошибка запроса не притворяется пустым результатом', async () => {
    const w = await mountMatrix({ error: 'Не удалось сверить счета с банком' })
    await flushPromises()
    expect(w.find('[data-testid="matrix-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="matrix-empty"]').exists()).toBe(false)
  })
})

describe('AccountMatrix: банк промолчал (хвост #539)', () => {
  // ⚠ Экран сам себе противоречил: алерт сверху сообщал «список счетов этого банка сейчас
  // неизвестен», а строки под ним уверенно писали «банк его не отдаёт» и предлагали подключить
  // банк. Админ исправного портала шёл править исправные реквизиты — ровно то, от чего этот
  // экран заведён.

  it('непроверенные СВОРАЧИВАЮТСЯ в счётчик, а не выдаются за проблемы', async () => {
    const w = await mountMatrix({
      rows: [unchecked, unchecked],
      providers: [{ provider: 'alfa-by', count: 0, error: 'подключение сейчас обновляется' }]
    })
    await flushPromises()
    expect(w.find('[data-testid="matrix-problems"]').exists()).toBe(false)
    expect(w.find('[data-testid="matrix-unchecked-count"]').text()).toContain('2 счёта проверить не удалось')
  })

  it('и в «сходятся» они тоже не попадают — за них никто не ручается', async () => {
    const w = await mountMatrix({ rows: [unchecked, matched] })
    await flushPromises()
    // ⚠ Прежняя арифметика счётчика была «всего минус проблемы», и `unchecked` попал бы сюда:
    // экран поручился бы за строку, которую не проверял.
    expect(w.find('[data-testid="matrix-matched-count"]').text()).toBe('Ещё один счёт сходится.')
  })

  it('«всё сходится» не пишем, пока есть непроверенные', async () => {
    const w = await mountMatrix({ rows: [unchecked, matched] })
    await flushPromises()
    expect(w.find('[data-testid="matrix-clean"]').exists()).toBe(false)
  })

  it('на исправном портале лишней строки нет', async () => {
    const w = await mountMatrix({ rows: [matched] })
    await flushPromises()
    expect(w.find('[data-testid="matrix-unchecked-count"]').exists()).toBe(false)
  })

  it('склонение — общим `pluralRu`, а не «счёт(а)»', async () => {
    const w = await mountMatrix({ rows: [unchecked] })
    await flushPromises()
    expect(w.find('[data-testid="matrix-unchecked-count"]').text()).toContain('1 счёт проверить не удалось')
  })

  it('текст говорит, что чинить нечего — иначе он повторяет прежнюю ошибку словами', async () => {
    const w = await mountMatrix({ rows: [unchecked] })
    await flushPromises()
    const note = w.find('[data-testid="matrix-unchecked-count"]').text()
    expect(note).toContain('не проблема реквизитов')
    expect(note).toContain('повторите сверку')
    expect(note).not.toContain('не отдаёт')
  })
})

describe('AccountMatrix: сводки не ручаются за молчащий банк (хвост #539)', () => {
  // ⚠ Строки — не единственное место, где экран утверждал больше, чем знал. «Всё сходится» и
  // «ни один банк не сообщил о своих» — тоже утверждения о ПОЛНОТЕ, а молчащий банк мог держать
  // счёт, которого нет в реквизитах: `bank-only`, самая дорогая строка этого экрана.

  const silent = [{ provider: 'alfa-by' as const, count: 0, error: 'банк не ответил (503)' }]

  it('все строки сошлись, но банк молчал — «всё сходится» НЕ пишем', async () => {
    const w = await mountMatrix({ rows: [matched], providers: silent })
    await flushPromises()
    const note = w.find('[data-testid="matrix-clean"]').text()
    expect(note).not.toContain('Всё сходится')
    expect(note).toContain('не ответил')
    expect(note).toContain('Повторите')
  })

  it('ответили все — прежняя зелёная формулировка на месте', async () => {
    const w = await mountMatrix({ rows: [matched], providers: [{ provider: 'alfa-by', count: 1, error: null }] })
    await flushPromises()
    const el = w.find('[data-testid="matrix-clean"]')
    expect(el.text()).toContain('Всё сходится: 1')
    expect(el.classes().join(' ')).toContain('success')
  })

  it('зелёный снимается, пока сторона банка неполна — цвет читается как «можно не смотреть»', async () => {
    const w = await mountMatrix({ rows: [matched], providers: silent })
    await flushPromises()
    expect(w.find('[data-testid="matrix-clean"]').classes().join(' ')).not.toContain('success')
  })

  it('сверять нечего и банк молчал — не пишем «ни один банк не сообщил о своих»', async () => {
    const w = await mountMatrix({ rows: [], providers: silent })
    await flushPromises()
    const note = w.find('[data-testid="matrix-empty"]').text()
    expect(note).not.toContain('ни один банк')
    expect(note).toContain('банк сейчас не ответил')
  })

  it('сверять нечего и банки ответили — прежний текст', async () => {
    const w = await mountMatrix()
    await flushPromises()
    expect(w.find('[data-testid="matrix-empty"]').text()).toContain('ни один банк не сообщил о своих')
  })
})
