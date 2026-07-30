// Построение опций столбчатого графика «приходы/расходы по дням» (#62, косметика #419).
//
// Вынесено из компонента в чистую функцию по двум причинам: во-первых, это конвенция репозитория
// (чистая логика — в `utils`, под тесты); во-вторых, именно здесь живут решения, которые легко
// сломать незаметно — знак расходов, вынос подписей оси наружу и отступ под них. Проверить это
// скриншотом нельзя: график рисуется только при наличии операций.

import type { DayBucket } from '~/utils/importStats'

/** Цвета серии и осей — считает компонент (зависят от светлой/тёмной темы). */
export interface ChartColors {
  income: string
  expense: string
  axis: string
  split: string
  label: string
}

export interface BarOptionInput {
  buckets: readonly DayBucket[]
  colors: ChartColors
  /** Анимация выключена при `prefers-reduced-motion`. */
  animate: boolean
  /** Форматтер денег (locale-зависимый, живёт в компоненте). */
  money: (n: number) => string
}

/** Отступ слева под подписи оси. Раньше подписи рисовались ВНУТРИ области графика
 *  (`axisLabel.inside`) и налезали на столбцы; вынесли наружу — нужно место. */
export const BAR_GRID_LEFT = 48

/**
 * Опции ECharts для столбчатого графика.
 *
 * Ключевое: расходы уходят в ряд со ЗНАКОМ МИНУС, ось становится двусторонней, и график читается
 * как «пришло вверх / ушло вниз» без чтения легенды. ⚠ Знак — ТОЛЬКО отображение: в агрегатах
 * (`importStats`) суммы остаются положительными, иначе поехали бы итоги плиток над графиком.
 * Поэтому же подписи и подсказка форматируются по модулю — иначе получился бы двойной минус.
 */
export function buildBarOption(input: BarOptionInput) {
  const { buckets, colors: c, animate, money } = input
  const abs = (v: number) => money(Math.abs(v))

  return {
    animation: animate,
    animationDuration: animate ? 700 : 0,
    animationEasing: 'cubicOut' as const,
    grid: { left: BAR_GRID_LEFT, right: 12, top: 40, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: abs },
    // Легенда ВКЛ: иначе два столбца дня различались бы только цветом, а зелёный↔красный —
    // тяжёлая для дальтоников пара, и нужна опознавательная подсказка без наведения.
    legend: { show: true, top: 0, data: ['Приходы', 'Расходы'], textStyle: { color: c.label } },
    xAxis: {
      type: 'category' as const,
      data: buckets.map(b => b.date.slice(5)), // MM-DD (год на оси не нужен)
      axisLabel: { color: c.axis, hideOverlap: true },
      axisLine: { lineStyle: { color: c.split } }
    },
    yAxis: {
      type: 'value' as const,
      // Без `inside: true` — подписи слева от графика, а не поверх столбцов.
      axisLabel: { color: c.axis, formatter: abs },
      splitLine: { lineStyle: { color: c.split } }
    },
    series: [
      { id: 'income', name: 'Приходы', type: 'bar' as const, color: c.income, itemStyle: { borderRadius: [3, 3, 0, 0] }, data: buckets.map(b => b.income) },
      { id: 'expense', name: 'Расходы', type: 'bar' as const, color: c.expense, itemStyle: { borderRadius: [0, 0, 3, 3] }, data: buckets.map(b => -b.expense) }
    ]
  }
}
