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
      rows: [{ state: 'crm-only', crm: { companyId: '7', number: 'BY11ALFA0001' }, connected: false }],
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
