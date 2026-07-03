<script setup lang="ts">
/**
 * QueueMonitor — a live line chart of BullMQ queue lengths (backlog) on Vue 3 + ECharts,
 * chromed with b24ui (B24Card/B24Button/B24Select) so it themes light/dark like the app.
 *
 * Source is the GET /api/ops/queues snapshot (no history/rates), so the time-series is
 * built on the client — each poll appends one `[time, backlog]` point to a sliding window
 * (app/utils/queueChart.ts). ECharts is dynamically imported and TREE-SHAKEN (echarts/core
 * + Line/Grid/Tooltip/Legend/Canvas) in onMounted (client-only). Axis/grid colours follow
 * the current theme (`.dark` class), re-applied when the theme toggles.
 *
 * NOTE: on a fetch error the poll loop STOPS (does not auto-recover) — resume with ▶.
 */
import { ref, shallowRef, computed, onMounted, onBeforeUnmount } from 'vue'
import type { ECharts } from 'echarts/core'
import PlayLIcon from '@bitrix24/b24icons-vue/outline/PlayLIcon'
import PauseLIcon from '@bitrix24/b24icons-vue/outline/PauseLIcon'
import {
  QUEUE_META,
  appendSnapshot,
  emptySeries,
  legendRows,
  totalBacklog,
  type QueueLegendRow,
  type QueuesSnapshot,
  type SeriesPoints
} from '~/utils/queueChart'

const props = withDefaults(defineProps<{
  /** Загрузчик снапшота очередей (например, GET /api/ops/queues или демо-генератор). */
  fetcher: () => Promise<QueuesSnapshot>
  title?: string
  /** Видимый диапазон времени, мин (по умолчанию 10). */
  rangeMin?: number
  /** Максимум точек в окне — потолок памяти. Шаг опроса выводится из диапазона:
   *  step = range / maxPoints (не чаще MIN_STEP_MS). Так память ограничена
   *  независимо от диапазона (4 ч не копит тысячи точек). */
  maxPoints?: number
  autoStart?: boolean
}>(), {
  title: 'Очереди обработки',
  rangeMin: 10,
  maxPoints: 240,
  autoStart: true
})

/** Выбор видимого диапазона (мин). Шаг опроса подстраивается под диапазон. */
const RANGE_ITEMS = [
  { label: '10 минут', value: 10 },
  { label: '30 минут', value: 30 },
  { label: '1 час', value: 60 },
  { label: '2 часа', value: 120 },
  { label: '4 часа', value: 240 }
]
/** Никогда не опрашивать чаще, чем раз в 2 с (даже на самом узком диапазоне). */
const MIN_STEP_MS = 2000

const chartEl = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
// ECharts loaded lazily (client-only) and TREE-SHAKEN — see onMounted.
let echartsCore: typeof import('echarts/core') | null = null
let timer: ReturnType<typeof setTimeout> | null = null
// Generation token for the poll loop: start()/stop() bump it so a chain that was
// mid-`await tick()` when the interval changed won't reschedule itself — otherwise
// two loops could run in parallel and double the poll rate.
let pollGen = 0
let ro: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

const range = ref(props.rangeMin) // minutes
const isReload = ref(props.autoStart)
const error = ref('')
const total = ref(0)
const rows = ref<QueueLegendRow[]>([])
const hidden = ref<Record<string, boolean>>({})
const series = ref<SeriesPoints>(emptySeries())
// Right edge of the sliding time window (latest poll time); the X axis follows it
// so the chart scrolls left as new points arrive. Null until the first tick.
const lastTickAt = ref<number | null>(null)

const nf = new Intl.NumberFormat('ru')
const fmt = (v: number): string => nf.format(v)

const enabled = ref(true)

/** Visible window width in ms (the selected range). */
function rangeMs(): number {
  return range.value * 60_000
}
/** Poll/step interval in ms — derived from the range so ~maxPoints points fill the
 *  window (memory bounded). Clamped so we never poll faster than MIN_STEP_MS. */
function stepMs(): number {
  return Math.max(MIN_STEP_MS, Math.round(rangeMs() / props.maxPoints))
}

/** The [min, max] time window the X axis shows now — a FIXED-width span ending at the
 *  latest poll. Both edges advance by one step each tick, so the axis (start date
 *  included) slides continuously right-to-left. Empty history just fills in from the
 *  right over time. */
function axisWindow(): { min: number, max: number } {
  const max = lastTickAt.value ?? Date.now()
  return { min: max - rangeMs(), max }
}

/** Axis/grid colours for the current theme (ECharts draws on canvas — CSS vars don't apply). */
function themeColors() {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return dark
    ? { axis: '#9aa4b2', split: 'rgba(255,255,255,0.10)' }
    : { axis: '#6b7280', split: 'rgba(0,0,0,0.10)' }
}

function baseOption() {
  const c = themeColors()
  return {
    animation: true,
    animationDurationUpdate: 200,
    grid: { left: 8, right: 40, top: 16, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => fmt(v) },
    legend: { show: false, selected: {} as Record<string, boolean> },
    xAxis: {
      type: 'time' as const,
      // Fixed sliding window (not data-extent auto-fit) so the axis scrolls smoothly.
      ...axisWindow(),
      axisLabel: { hideOverlap: true, color: c.axis, formatter: { second: '{HH}:{mm}:{ss}', minute: '{HH}:{mm}', hour: '{HH}:{mm}' } },
      axisLine: { lineStyle: { color: c.split } },
      splitLine: { show: true, lineStyle: { color: c.split } }
    },
    yAxis: { type: 'value' as const, min: 0, minInterval: 1, axisLabel: { inside: true, color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
    series: [] as unknown[]
  }
}

function buildSeries(meta: typeof QUEUE_META[number]) {
  const s: Record<string, unknown> = {
    id: meta.name,
    name: meta.label,
    type: 'line',
    showSymbol: false,
    symbolSize: 8,
    smooth: 0.35,
    lineStyle: { color: meta.color, width: 2 },
    itemStyle: { color: meta.color },
    endLabel: { show: true, formatter: (p: { value: [number, number] }) => fmt(p.value[1]), color: meta.color },
    emphasis: { focus: 'series' as const },
    data: series.value[meta.name] ?? []
  }
  // Area fill under EVERY series with a HORIZONTAL gradient (0,0 → 1,0): left (older)
  // more opaque, right (newest) transparent — a comet-tail as the chart flows
  // right→left. Uniform top-to-bottom (no vertical fade). Low alpha so 4 overlapping
  // fills stay readable. Fades to the SAME hue at 0 alpha (`+00`) so no dark muddying.
  if (echartsCore) {
    const leftAlpha = meta.main ? 0.34 : 0.20
    s.areaStyle = {
      color: new echartsCore.graphic.LinearGradient(0, 0, 1, 0, [
        { offset: 0, color: `${meta.color}${alphaHex(leftAlpha)}` },
        { offset: 1, color: `${meta.color}00` }
      ])
    }
  }
  return s
}

/** Two-digit hex alpha (0..1 → '00'..'ff') for an 8-digit hex colour. */
function alphaHex(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
}

function redraw() {
  if (!chart.value) return
  const option = baseOption()
  const selected: Record<string, boolean> = {}
  for (const meta of QUEUE_META) {
    selected[meta.label] = !hidden.value[meta.name]
    option.series.push(buildSeries(meta))
  }
  option.legend.selected = selected
  chart.value.setOption(option, { notMerge: true })
}

async function tick() {
  try {
    const snapshot = await props.fetcher()
    error.value = ''
    enabled.value = snapshot.enabled !== false
    const now = Date.now()
    lastTickAt.value = now
    series.value = appendSnapshot(series.value, snapshot, now, props.maxPoints)
    rows.value = legendRows(snapshot)
    total.value = totalBacklog(snapshot)
    // Advance the sliding window (X axis follows `now`) and update the series data
    // (ECharts diffs + animates the change), so dates scroll left each poll.
    chart.value?.setOption({
      xAxis: axisWindow(),
      series: QUEUE_META.map(m => ({ id: m.name, data: series.value[m.name] }))
    })
  } catch (e) {
    error.value = (e as Error)?.message || 'Ошибка загрузки'
    stop()
  }
}

function stopTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
function scheduleNext() {
  const gen = pollGen
  timer = setTimeout(async () => {
    await tick()
    // Only the current generation reschedules — a chain superseded by start()/stop()
    // (e.g. a range change during an in-flight fetch) dies here.
    if (isReload.value && gen === pollGen) scheduleNext()
  }, stepMs())
}
function start() {
  isReload.value = true
  pollGen++
  stopTimer()
  scheduleNext()
}
function stop() {
  isReload.value = false
  pollGen++
  stopTimer()
}
function toggleReload() {
  if (isReload.value) stop()
  else start()
}
function changeRange(v: unknown) {
  range.value = Number(v)
  // Re-render the axis window immediately (new span) even while paused.
  chart.value?.setOption({ xAxis: axisWindow() })
  if (isReload.value) start()
}
function toggleLine(row: QueueLegendRow) {
  hidden.value = { ...hidden.value, [row.name]: !hidden.value[row.name] }
  chart.value?.dispatchAction({ type: 'legendToggleSelect', name: row.label })
}

const legendView = computed<QueueLegendRow[]>(() => rows.value.length ? rows.value : legendRows({ enabled: true, queues: {} }))

onMounted(async () => {
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ])
  core.use([charts.LineChart, components.GridComponent, components.TooltipComponent, components.LegendComponent, renderers.CanvasRenderer])
  echartsCore = core
  if (!chartEl.value) return
  chart.value = core.init(chartEl.value)
  redraw()
  ro = new ResizeObserver(() => chart.value?.resize())
  ro.observe(chartEl.value)
  // Re-theme the canvas when the OS/user toggles light↔dark (`.dark` on <html>).
  themeObserver = new MutationObserver(() => redraw())
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  await tick()
  if (props.autoStart) start()
})

onBeforeUnmount(() => {
  stopTimer()
  ro?.disconnect()
  themeObserver?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="font-semibold">
          {{ title }} — в очередях {{ fmt(total) }}
        </h3>
        <div class="flex items-center gap-2">
          <B24Button
            :icon="isReload ? PauseLIcon : PlayLIcon"
            :label="isReload ? 'Пауза' : 'Запуск'"
            color="air-tertiary-no-accent"
            size="sm"
            @click="toggleReload"
          />
          <B24Select
            :model-value="range"
            :items="RANGE_ITEMS"
            size="sm"
            class="w-36"
            aria-label="Диапазон времени графика"
            @update:model-value="changeRange"
          />
        </div>
      </div>
    </template>

    <B24Alert
      v-if="!enabled"
      color="air-primary-warning"
      variant="soft"
      title="Очереди выключены"
      description="Не задан REDIS_URL — приём работает синхронным фолбэком, но пайплайн/крон не запущены."
      class="mb-3"
    />
    <!-- aria-live region: a screen reader announces a fetch error when it appears. -->
    <div aria-live="polite">
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        variant="soft"
        :title="error"
        class="mb-3"
      />
    </div>

    <div class="flex flex-wrap gap-3">
      <!-- Canvas chart has no accessible text; expose the current total as a label
           (the legend table below carries the per-queue detail). -->
      <div
        ref="chartEl"
        role="img"
        :aria-label="`График длины очередей обработки, всего в очередях: ${total}`"
        class="min-h-80 min-w-[320px] flex-[1_1_60%]"
      />

      <div class="flex-[1_1_30%] min-w-[280px]">
        <div class="grid grid-cols-[minmax(0,1fr)_repeat(4,2.5rem)] gap-x-1.5 border-b border-(--ui-color-design-tinted-na-stroke) pb-1.5 text-[11px] font-semibold text-(--ui-color-base-3)">
          <span>Очередь</span>
          <span class="text-center">ждут</span>
          <span class="text-center">работа</span>
          <span class="text-center">готово</span>
          <span class="text-center">ошибки</span>
        </div>
        <button
          v-for="row in legendView"
          :key="row.name"
          type="button"
          :aria-pressed="!hidden[row.name]"
          class="grid w-full grid-cols-[minmax(0,1fr)_repeat(4,2.5rem)] items-center gap-x-1.5 border-b border-(--ui-color-design-tinted-na-stroke) py-1.5 text-left text-sm tabular-nums transition-opacity last:border-b-0 hover:opacity-80"
          :class="{ 'opacity-40': hidden[row.name] }"
          @click="toggleLine(row)"
        >
          <span class="flex items-center gap-2 truncate">
            <i
              class="size-2.5 shrink-0 rounded-full"
              :style="{ background: row.color }"
            />{{ row.label }}
          </span>
          <span class="text-center">{{ fmt(row.waiting) }}</span>
          <span class="text-center">{{ fmt(row.active) }}</span>
          <span class="text-center">{{ fmt(row.completed) }}</span>
          <span
            class="text-center"
            :class="row.failed > 0 ? 'font-semibold text-(--ui-color-accent-main-alert)' : ''"
          >{{ fmt(row.failed) }}</span>
        </button>
      </div>
    </div>
  </B24Card>
</template>
