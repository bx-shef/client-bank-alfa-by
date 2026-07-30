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

/** Отступ слева. Ширину самих подписей резервирует `containLabel: true`, поэтому большое
 *  значение здесь СКЛАДЫВАЕТСЯ с ней и просто съедает график — на узком экране портала это заметная
 *  доля ширины. Налезание подписей чинил не отступ, а отказ от `axisLabel.inside`. */
export const BAR_GRID_LEFT = 8

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
  /** Для ПОДСКАЗКИ: ряд уже подписан «Расходы», и знак там дал бы «−980» при названии «Расходы» —
   *  двойное отрицание. На ОСИ так делать нельзя (см. ниже). */
  const abs = (v: number) => money(Math.abs(v))
  /** Для ОСИ: знак обязателен. Без него шкала выглядит как «2000 / 0 / 2000» — два одинаковых
   *  деления по разные стороны от нуля, и понять, где расход, невозможно. */
  const signed = (v: number) => money(v)

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
      axisLabel: { color: c.axis, formatter: signed },
      splitLine: { lineStyle: { color: c.split } }
    },
    series: [
      {
        id: 'income',
        name: 'Приходы',
        type: 'bar' as const,
        color: c.income,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: buckets.map(b => b.income),
        // Нулевая линия — единственная, которую обязательно видно: весь смысл графика в том, что
        // выше неё приход, ниже расход. Обычной сеткой (10% прозрачности) она не читается, а
        // `axisLine.onZero` тут не помогает — у оси значений это ВЕРТИКАЛЬНАЯ линия, а нужна
        // горизонтальная. Поэтому явная markLine (без подписи и без реакции на наведение).
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: c.axis, width: 1, type: 'solid' as const },
          data: [{ yAxis: 0 }]
        }
      },
      // `b.expense === 0 ? 0 : -…` — чтобы в данные не попадал `-0`: значения он не меняет, но
      // мусорит в отладке и сериализации.
      { id: 'expense', name: 'Расходы', type: 'bar' as const, color: c.expense, itemStyle: { borderRadius: [0, 0, 3, 3] }, data: buckets.map(b => (b.expense === 0 ? 0 : -b.expense)) }
    ]
  }
}
