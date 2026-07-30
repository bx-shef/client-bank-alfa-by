import { describe, expect, it } from 'vitest'
import { BAR_GRID_LEFT, buildBarOption, type ChartColors } from '~/utils/importStatsChart'
import type { DayBucket } from '~/utils/importStats'

// Косметика графика (#419). Проверяем ровно то, что ломается незаметно и не видно на скриншоте
// (график рисуется только при наличии операций): знак расходов, вынос подписей оси наружу и
// форматирование по модулю.

const COLORS: ChartColors = {
  income: '#059669',
  expense: '#e11d48',
  axis: '#6b7280',
  split: 'rgba(0,0,0,0.10)',
  label: '#52514e'
}

const BUCKETS: DayBucket[] = [
  { date: '2026-07-02', income: 1200, expense: 0 },
  { date: '2026-07-03', income: 0, expense: 980.5 }
]

function option(over: Partial<Parameters<typeof buildBarOption>[0]> = {}) {
  return buildBarOption({
    buckets: BUCKETS,
    colors: COLORS,
    animate: true,
    money: (n: number) => n.toFixed(2),
    ...over
  })
}

describe('buildBarOption', () => {
  it('расходы уходят ВНИЗ — ось двусторонняя, «пришло/ушло» читается без легенды', () => {
    const o = option()
    const income = o.series.find(s => s.id === 'income')!
    const expense = o.series.find(s => s.id === 'expense')!
    expect(income.data).toEqual([1200, 0])
    expect(expense.data).toEqual([-0, -980.5])
  })

  it('подписи и подсказка форматируются по МОДУЛЮ — иначе на минусовой половине двойной минус', () => {
    const o = option()
    expect(o.yAxis.axisLabel.formatter(-980.5)).toBe('980.50')
    expect(o.tooltip.valueFormatter(-980.5)).toBe('980.50')
    // Положительные не трогаем.
    expect(o.yAxis.axisLabel.formatter(1200)).toBe('1200.00')
  })

  it('подписи оси СНАРУЖИ графика и под них есть отступ', () => {
    const o = option()
    // Раньше стоял `inside: true` — подписи налезали на столбцы.
    expect('inside' in o.yAxis.axisLabel).toBe(false)
    expect(o.grid.left).toBe(BAR_GRID_LEFT)
    expect(BAR_GRID_LEFT).toBeGreaterThan(8) // прежнее значение, места не хватало
  })

  it('легенда включена — зелёный↔красный нельзя оставлять единственным различием', () => {
    expect(option().legend.show).toBe(true)
    expect(option().legend.data).toEqual(['Приходы', 'Расходы'])
  })

  it('prefers-reduced-motion выключает анимацию полностью', () => {
    const o = option({ animate: false })
    expect(o.animation).toBe(false)
    expect(o.animationDuration).toBe(0)
  })

  it('на оси дат остаётся ММ-ДД — год занимал бы место без пользы', () => {
    expect(option().xAxis.data).toEqual(['07-02', '07-03'])
  })

  it('пустой набор не роняет построение', () => {
    const o = option({ buckets: [] })
    expect(o.xAxis.data).toEqual([])
    expect(o.series.every(s => s.data.length === 0)).toBe(true)
  })
})
