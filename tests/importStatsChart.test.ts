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
    // Сравниваем ЗНАК, а не точное представление: `-0` — артефакт `-b.expense` при нулевом
    // расходе, он ничего не значит, и закреплять его тестом значило бы запретить безобидную
    // нормализацию (`toEqual` в Vitest отличает -0 от 0).
    expect(expense.data[0]).toBe(0)
    expect(expense.data[1]).toBeLessThan(0)
    expect(expense.data[1]).toBe(-980.5)
  })

  it('ПОДСКАЗКА по модулю (ряд уже назван «Расходы»), а ОСЬ со знаком', () => {
    const o = option()
    // В подсказке имя ряда уже говорит «Расходы» — минус там дал бы двойное отрицание.
    expect(o.tooltip.valueFormatter(-980.5)).toBe('980.50')
    // На оси знак обязателен: без него шкала выглядит как «2000 / 0 / 2000» — два одинаковых
    // деления по разные стороны нуля, и понять, где расход, невозможно.
    expect(o.yAxis.axisLabel.formatter(-980.5)).toBe('-980.50')
    expect(o.yAxis.axisLabel.formatter(1200)).toBe('1200.00')
  })

  it('нулевая линия нарисована явно — по ней и читается «выше приход, ниже расход»', () => {
    // Обычной сеткой (10% прозрачности) ноль не читается, а `axisLine.onZero` у оси значений
    // рисует ВЕРТИКАЛЬНУЮ линию, не горизонтальную — поэтому явная markLine.
    const income = option().series.find(s => s.id === 'income')!
    expect(income.markLine?.data).toEqual([{ yAxis: 0 }])
    expect(income.markLine?.silent).toBe(true)
    expect(income.markLine?.label?.show).toBe(false)
  })

  it('приходы не вырождаются, когда расходов кратно больше (приёмка #419)', () => {
    // Перекос 1:50 — из-за общей оси маленький приход мог бы схлопнуться в невидимую полоску.
    const o = option({
      buckets: [
        { date: '2026-07-02', income: 1200, expense: 0 },
        { date: '2026-07-03', income: 200, expense: 9800 }
      ]
    })
    const income = o.series.find(s => s.id === 'income')!
    const expense = o.series.find(s => s.id === 'expense')!
    expect(income.data).toEqual([1200, 200])
    expect(expense.data[1]).toBe(-9800)
    // Ось строится автоматически по обеим сторонам — обрезки нет (ни min, ни max не заданы).
    expect('min' in o.yAxis).toBe(false)
    expect('max' in o.yAxis).toBe(false)
  })

  it('подписи оси СНАРУЖИ графика и под них есть отступ', () => {
    const o = option()
    // Раньше стоял `inside: true` — подписи налезали на столбцы.
    expect('inside' in o.yAxis.axisLabel).toBe(false)
    expect(o.grid.left).toBe(BAR_GRID_LEFT)
    // Ширину подписей резервирует `containLabel`, поэтому большой `left` СКЛАДЫВАЛСЯ бы с ней и
    // съедал график на узком экране портала.
    expect(o.grid.containLabel).toBe(true)
    expect(BAR_GRID_LEFT).toBeLessThanOrEqual(12)
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
