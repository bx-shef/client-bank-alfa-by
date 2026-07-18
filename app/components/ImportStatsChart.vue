<script setup lang="ts">
/**
 * ImportStatsChart — the employee "result of import" view (#62): a lively summary of a
 * parsed statement instead of a dry table. Count-up stat tiles (operations / income /
 * expense) + an ECharts bar of income-vs-expense BY DAY + a donut of the income/expense
 * share, for the chosen currency. Chromed with b24ui (B24Card/B24Select) so it themes
 * light/dark like the app.
 *
 * Data is the pure `computeImportStats` core (app/utils/importStats.ts) over the same
 * StatementItem[] the preview shows — no extra I/O. ECharts is dynamically imported and
 * TREE-SHAKEN (Bar + Pie + Grid/Tooltip/Legend + Canvas) client-only, mirroring QueueMonitor.
 *
 * ACCESSIBILITY: income vs expense are ALWAYS labelled (↑ приходы / ↓ расходы, text +
 * arrow) so identity never rests on colour alone — the green/red pair sits in the CVD
 * floor band, legal only with this secondary encoding (dataviz). `prefers-reduced-motion`
 * disables both the count-up and the ECharts animation.
 */
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import type { ECharts } from 'echarts/core'
import { computeImportStats, dayBucketsForCurrency, currencyTotal } from '~/utils/importStats'
import type { StatementItem } from '~/types/statement'

const props = defineProps<{ items: StatementItem[] }>()

const stats = computed(() => computeImportStats(props.items))
const currencies = computed(() => stats.value.byCurrency.map(c => c.currency))
const selected = ref('')

// Keep the selected currency valid as items change (default to the dominant one).
watch(stats, (s) => {
  if (!currencies.value.includes(selected.value)) selected.value = s.dominantCurrency ?? ''
}, { immediate: true })

const currencyItems = computed(() => currencies.value.map(c => ({ label: c || '—', value: c })))
const showSelector = computed(() => currencies.value.length > 1)

const chosenTotal = computed(() => currencyTotal(stats.value, selected.value))
const buckets = computed(() => dayBucketsForCurrency(props.items, selected.value))

// --- formatting -----------------------------------------------------------
const moneyFmt = new Intl.NumberFormat('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const intFmt = new Intl.NumberFormat('ru')
function money(n: number): string {
  return moneyFmt.format(n)
}
/** Currency label with a graceful blank fallback. */
const curLabel = computed(() => selected.value || '')

// --- count-up animation ---------------------------------------------------
const reduceMotion = ref(false)
const COUNT_MS = 800
const displayTotal = ref(0)
const displayIncome = ref(0)
const displayExpense = ref(0)
let countRaf = 0

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}
/** Animate the three headline numbers from their current shown value to the new targets
 *  over COUNT_MS (eased). On reduced-motion, jump straight to the targets. */
function runCountUp() {
  const targetTotal = stats.value.total
  const targetIncome = chosenTotal.value.income
  const targetExpense = chosenTotal.value.expense
  if (countRaf) cancelAnimationFrame(countRaf)
  if (reduceMotion.value || typeof requestAnimationFrame === 'undefined') {
    displayTotal.value = targetTotal
    displayIncome.value = targetIncome
    displayExpense.value = targetExpense
    return
  }
  const fromTotal = displayTotal.value
  const fromIncome = displayIncome.value
  const fromExpense = displayExpense.value
  const start = performance.now()
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / COUNT_MS)
    const e = easeOutCubic(p)
    displayTotal.value = fromTotal + (targetTotal - fromTotal) * e
    displayIncome.value = fromIncome + (targetIncome - fromIncome) * e
    displayExpense.value = fromExpense + (targetExpense - fromExpense) * e
    if (p < 1) countRaf = requestAnimationFrame(step)
    else countRaf = 0
  }
  countRaf = requestAnimationFrame(step)
}

// --- ECharts --------------------------------------------------------------
const barEl = ref<HTMLElement | null>(null)
const donutEl = ref<HTMLElement | null>(null)
const barChart = shallowRef<ECharts | null>(null)
const donutChart = shallowRef<ECharts | null>(null)
let ro: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
// Set in onBeforeUnmount so an async onMounted resuming after unmount bails out.
let disposed = false

/** True when the app is in dark mode (`.dark` on <html>). */
function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

// income = emerald, expense = rose — the SAME income/expense hues the app already uses in
// OperationList / app.vue (Tailwind emerald-600/400, rose-600/400), so the chart matches the
// operation rows shown right below it (canvas can't read CSS vars, hence literal hex here).
// NOTE: green↔red is an inherently CVD-hard pair (below the strict dataviz CVD floor), so
// identity is ALWAYS carried by non-colour cues too — the ↑/↓ + text stat tiles, the bar
// legend, and the donut legend — never colour alone.
function seriesColors() {
  const dark = isDark()
  return {
    income: dark ? '#34d399' : '#059669', // emerald-400 / emerald-600
    expense: dark ? '#fb7185' : '#e11d48', // rose-400 / rose-600
    axis: dark ? '#9aa4b2' : '#6b7280',
    split: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
    label: dark ? '#c3c2b7' : '#52514e'
  }
}

function barOption() {
  const c = seriesColors()
  const anim = !reduceMotion.value
  return {
    animation: anim,
    animationDuration: anim ? 700 : 0,
    animationEasing: 'cubicOut' as const,
    grid: { left: 8, right: 12, top: 40, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => money(v) },
    // Legend ON: the two bars per day differ only by colour otherwise, so a CVD user (green↔red
    // floor pair) needs this non-hover, non-colour identity cue (tooltip is pointer-only).
    legend: { show: true, top: 0, data: ['Приходы', 'Расходы'], textStyle: { color: c.label } },
    xAxis: {
      type: 'category' as const,
      data: buckets.value.map(b => b.date.slice(5)), // MM-DD part (drop the year for a compact axis)
      axisLabel: { color: c.axis, hideOverlap: true },
      axisLine: { lineStyle: { color: c.split } }
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { inside: true, color: c.axis },
      splitLine: { lineStyle: { color: c.split } }
    },
    series: [
      { id: 'income', name: 'Приходы', type: 'bar', color: c.income, itemStyle: { borderRadius: [3, 3, 0, 0] }, data: buckets.value.map(b => b.income) },
      { id: 'expense', name: 'Расходы', type: 'bar', color: c.expense, itemStyle: { borderRadius: [3, 3, 0, 0] }, data: buckets.value.map(b => b.expense) }
    ]
  }
}

function donutOption() {
  const c = seriesColors()
  const anim = !reduceMotion.value
  return {
    animation: anim,
    animationDuration: anim ? 700 : 0,
    tooltip: { trigger: 'item' as const, valueFormatter: (v: number) => money(v) },
    legend: { show: false },
    series: [{
      type: 'pie',
      radius: ['55%', '80%'],
      avoidLabelOverlap: true,
      // 2px surface gap between slices (dataviz mark spec).
      itemStyle: { borderColor: c.split, borderWidth: 2 },
      label: { show: false },
      data: [
        { name: 'Приходы', value: chosenTotal.value.income, itemStyle: { color: c.income } },
        { name: 'Расходы', value: chosenTotal.value.expense, itemStyle: { color: c.expense } }
      ]
    }]
  }
}

function redraw() {
  barChart.value?.setOption(barOption(), { notMerge: true })
  donutChart.value?.setOption(donutOption(), { notMerge: true })
}

// Re-render on data/currency change (charts + count-up).
watch([buckets, chosenTotal], () => {
  redraw()
  runCountUp()
})

// Last-seen dark state, so the <html> class MutationObserver repaints ONLY on an actual
// light↔dark flip — not on unrelated class churn (scroll-locks, other toggles), which would
// otherwise trigger two full setOption rebuilds + re-animations per mutation.
let lastDark = false

onMounted(async () => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    reduceMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ])
  // The component may have unmounted while the dynamic import was in flight — bail before
  // creating observers, or they'd leak (onBeforeUnmount already ran with ro/themeObserver null).
  if (disposed || (!barEl.value && !donutEl.value)) return
  core.use([charts.BarChart, charts.PieChart, components.GridComponent, components.TooltipComponent, components.LegendComponent, renderers.CanvasRenderer])
  if (barEl.value) barChart.value = core.init(barEl.value)
  if (donutEl.value) donutChart.value = core.init(donutEl.value)
  lastDark = isDark()
  redraw()
  runCountUp()
  ro = new ResizeObserver(() => {
    barChart.value?.resize()
    donutChart.value?.resize()
  })
  if (barEl.value) ro.observe(barEl.value)
  if (donutEl.value) ro.observe(donutEl.value)
  themeObserver = new MutationObserver(() => {
    const dark = isDark()
    if (dark === lastDark) return // ignore unrelated <html> class churn
    lastDark = dark
    redraw()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onBeforeUnmount(() => {
  disposed = true
  if (countRaf) cancelAnimationFrame(countRaf)
  ro?.disconnect()
  themeObserver?.disconnect()
  barChart.value?.dispose()
  donutChart.value?.dispose()
  barChart.value = null
  donutChart.value = null
})
</script>

<template>
  <B24Card v-if="stats.total > 0">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-semibold">
          Результат импорта
        </h2>
        <B24Select
          v-if="showSelector"
          :model-value="selected"
          :items="currencyItems"
          size="sm"
          class="w-28"
          aria-label="Валюта"
          @update:model-value="selected = String($event)"
        />
      </div>
    </template>

    <!-- Count-up stat tiles. Numbers animate from 0; identity carries text + arrow, never
         colour alone. -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div class="rounded-lg border border-(--ui-color-base-4) px-4 py-3">
        <div class="text-xs text-(--ui-color-base-3)">
          Операций
        </div>
        <div class="mt-1 text-2xl font-semibold tabular-nums">
          {{ intFmt.format(Math.round(displayTotal)) }}
        </div>
      </div>
      <div class="rounded-lg border border-(--ui-color-base-4) px-4 py-3">
        <div class="text-xs text-(--ui-color-base-3)">
          <span aria-hidden="true">↑</span> Приходы<span v-if="curLabel">, {{ curLabel }}</span>
        </div>
        <div class="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
          {{ money(displayIncome) }}
        </div>
        <div class="text-[11px] text-(--ui-color-base-4)">
          {{ chosenTotal.incomeCount }} шт.
        </div>
      </div>
      <div class="rounded-lg border border-(--ui-color-base-4) px-4 py-3">
        <div class="text-xs text-(--ui-color-base-3)">
          <span aria-hidden="true">↓</span> Расходы<span v-if="curLabel">, {{ curLabel }}</span>
        </div>
        <div class="mt-1 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">
          {{ money(displayExpense) }}
        </div>
        <div class="text-[11px] text-(--ui-color-base-4)">
          {{ chosenTotal.expenseCount }} шт.
        </div>
      </div>
    </div>

    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
      <!-- By-day income vs expense bars. -->
      <div>
        <div class="mb-1 text-xs text-(--ui-color-base-3)">
          Приходы и расходы по дням<span v-if="curLabel"> ({{ curLabel }})</span>
        </div>
        <div
          ref="barEl"
          role="img"
          :aria-label="`График приходов и расходов по дням. Всего операций: ${stats.total}. Приходы: ${money(chosenTotal.income)}, расходы: ${money(chosenTotal.expense)} ${curLabel}`"
          class="h-64 w-full"
        />
      </div>
      <!-- Income/expense share donut. -->
      <div>
        <div class="mb-1 text-xs text-(--ui-color-base-3)">
          Доля прихода и расхода
        </div>
        <div
          ref="donutEl"
          role="img"
          :aria-label="`Доля приходов и расходов: приходы ${money(chosenTotal.income)}, расходы ${money(chosenTotal.expense)} ${curLabel}`"
          class="h-64 w-full"
        />
        <!-- Legend (text + colour swatch): identity is not colour-alone. -->
        <div class="mt-1 flex items-center justify-center gap-4 text-xs">
          <span class="flex items-center gap-1.5">
            <i class="size-2.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />Приходы
          </span>
          <span class="flex items-center gap-1.5">
            <i class="size-2.5 rounded-full bg-rose-600 dark:bg-rose-400" />Расходы
          </span>
        </div>
      </div>
    </div>
  </B24Card>
</template>
