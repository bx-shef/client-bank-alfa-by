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
  seedSeries,
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
  /** Частота опроса, сек (шаг точек = частота). Реже опрос → крупнее шаг → заметнее
   *  «течение» графика; чаще → плотнее детализация. По умолчанию 5 с. */
  pollSec?: number
  /** Потолок числа точек в окне (память). Если диапазон/частота дают больше — шаг
   *  укрупняется так, чтобы точек было не больше этого (окно всё равно = диапазон). */
  maxPoints?: number
  autoStart?: boolean
}>(), {
  title: 'Очереди обработки',
  rangeMin: 10,
  pollSec: 5,
  maxPoints: 1000,
  autoStart: true
})

/** Выбор видимого диапазона (мин). Ширина окна времени. */
const RANGE_ITEMS = [
  { label: '10 минут', value: 10 },
  { label: '30 минут', value: 30 },
  { label: '1 час', value: 60 },
  { label: '2 часа', value: 120 },
  { label: '4 часа', value: 240 }
]
/** Частота опроса (сек) — независимый от диапазона регулятор плотности/скорости точек. */
const POLL_ITEMS = [
  { label: '2 сек', value: 2 },
  { label: '5 сек', value: 5 },
  { label: '15 сек', value: 15 }
]
/** Narrow (phone) breakpoint — Tailwind `sm`. On phones we show HALF the selected time
 *  span so the axis isn't cramped (fewer, more legible points/labels). */
const NARROW_QUERY = '(max-width: 639px)'

const chartEl = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
// ECharts loaded lazily (client-only) and TREE-SHAKEN — see onMounted.
let echartsCore: typeof import('echarts/core') | null = null
let timer: ReturnType<typeof setTimeout> | null = null
// Generation token for the poll loop: start()/stop() bump it so a chain that was
// mid-`await tick()` when the range changed (or the component unmounted) won't
// reschedule itself — otherwise two loops could run in parallel (double poll rate)
// or a poll could outlive the component and hit a disposed chart.
let pollGen = 0
let ro: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let mql: MediaQueryList | null = null
// The first successful tick BACKFILLS a full window (seedSeries) so the chart starts
// full and immediately slides — no "grow from empty / clamped first date". Afterwards
// each tick appends one point. Reset to false on a range change to re-seed the new span.
let seeded = false

const range = ref(props.rangeMin) // minutes (selected window width)
const poll = ref(props.pollSec) // seconds (selected poll cadence)
const isNarrow = ref(false) // phone viewport → show half the span
const isReload = ref(props.autoStart)
const error = ref('')
const total = ref(0)
const rows = ref<QueueLegendRow[]>([])
const hidden = ref<Record<string, boolean>>({})
const series = ref<SeriesPoints>(emptySeries())

const nf = new Intl.NumberFormat('ru')
const fmt = (v: number): string => nf.format(v)

const enabled = ref(true)

/** Visible window width in ms. On a phone we halve the selected span so the narrow
 *  axis isn't cramped (user request; see NARROW_QUERY). */
function rangeMs(): number {
  return range.value * 60_000 * (isNarrow.value ? 0.5 : 1)
}
/** Poll/step interval in ms. It's the SELECTED poll cadence, but bumped up if the
 *  range/cadence combo would exceed `maxPoints` (memory ceiling) — so the full window
 *  is always shown, just with a coarser step when it otherwise wouldn't fit. */
function stepMs(): number {
  const wanted = Math.max(1000, Math.round(poll.value * 1000))
  const memFloor = Math.ceil(rangeMs() / Math.max(1, props.maxPoints))
  return Math.max(wanted, memFloor)
}
/** How many points fill the current window (seed size + trim cap). ≥2, ≤ maxPoints. */
function pointCount(): number {
  return Math.max(2, Math.round(rangeMs() / stepMs()))
}

/** Update-animation duration (ms). Matching it to the poll step makes the axis GLIDE
 *  the whole way from one position to the next — a continuous right-to-left conveyor —
 *  instead of a short hop then a freeze. Floored so it stays visible; capped at 15s
 *  (the slowest poll) so a wide range's coarse step doesn't run an endless tween. */
function updateDurationMs(): number {
  return Math.min(15_000, Math.max(600, stepMs()))
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
    // Continuous conveyor: the axis extent shifts by exactly one step each tick and
    // ECharts tweens to it LINEARLY over ~one step — so the graph flows smoothly
    // right-to-left instead of snapping. See updateDurationMs().
    animationDurationUpdate: updateDurationMs(),
    animationEasingUpdate: 'linear' as const,
    // Nudge overlapping end-labels apart (all queues share y=0 in the idle state →
    // four "0" would stack on the right edge otherwise).
    labelLayout: { moveOverlap: 'shiftY' as const },
    grid: { left: 8, right: 40, top: 16, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => fmt(v) },
    legend: { show: false, selected: {} as Record<string, boolean> },
    xAxis: {
      type: 'time' as const,
      // EXACT data extent (dataMin/dataMax), not ECharts' "nice"-rounded bounds — so the
      // window shifts by precisely one step per tick (no snap to round minutes) and the
      // update animation carries the whole line + axis labels smoothly leftward.
      min: 'dataMin' as const,
      max: 'dataMax' as const,
      // `day` level → a window crossing midnight (up to the 4h range) shows the date.
      axisLabel: { hideOverlap: true, color: c.axis, formatter: { second: '{HH}:{mm}:{ss}', minute: '{HH}:{mm}', hour: '{HH}:{mm}', day: '{dd}.{MM}' } },
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
    // First tick backfills a full window (flat at the current backlog) so the chart is
    // full from frame one and slides; later ticks append one point + trim the oldest.
    if (!seeded) {
      series.value = seedSeries(snapshot, now, stepMs(), pointCount())
      seeded = true
    } else {
      series.value = appendSnapshot(series.value, snapshot, now, pointCount())
    }
    rows.value = legendRows(snapshot)
    total.value = totalBacklog(snapshot)
    // Only the data changes; the axis extent (dataMin/dataMax) follows it and ECharts
    // tweens the whole line + labels leftward — the conveyor. Merge (not notMerge) keeps
    // the area fills/gradients from redraw() so they don't rebuild every tick.
    chart.value?.setOption({
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
  // Re-seed on the next resume: after a pause (or a fetch error), the retained window
  // is stale — resuming would append across the pause gap and, with dataMin/dataMax,
  // stretch the axis past the selected range and draw a straight bridge over the gap.
  // Dropping `seeded` makes the resume rebuild a fresh full window at current backlog.
  seeded = false
}
function toggleReload() {
  if (isReload.value) stop()
  else start()
}
/** Pause the poll+animation loop while the tab is hidden (the linear tween is now
 *  near-continuous — no point burning CPU/fetches off-screen), and resume on return.
 *  Keeps `isReload` (the ▶/⏸ state) untouched; drops `seeded` so the return re-seeds a
 *  fresh window rather than bridging the hidden gap (same reasoning as stop()). */
function onVisibility() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    pollGen++
    stopTimer()
    seeded = false
  } else if (isReload.value) {
    pollGen++
    stopTimer()
    scheduleNext()
  }
}
/** Re-seed a fresh full window after any span/step change (range, poll cadence, or the
 *  phone/desktop breakpoint). redraw() rebuilds baseOption so the new updateDurationMs()
 *  (and axis) take effect; a repaint fires immediately so the change shows even while
 *  paused; if running, start() reschedules the loop at the new step. */
function reseed() {
  seeded = false
  redraw()
  if (isReload.value) start()
  void tick()
}
function changeRange(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  range.value = n
  reseed()
}
function changePoll(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  poll.value = n
  reseed()
}
/** Phone breakpoint crossed → the visible span halves/doubles → re-seed the new window. */
function onNarrowChange(e: MediaQueryListEvent | MediaQueryList) {
  if (e.matches === isNarrow.value) return
  isNarrow.value = e.matches
  reseed()
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
  // Phone breakpoint: set the initial state BEFORE the first seed so the window is
  // already halved on load (not seeded full then re-seeded). matchMedia is client-only.
  if (typeof window !== 'undefined' && window.matchMedia) {
    mql = window.matchMedia(NARROW_QUERY)
    isNarrow.value = mql.matches
    mql.addEventListener('change', onNarrowChange)
  }
  chart.value = core.init(chartEl.value)
  redraw()
  ro = new ResizeObserver(() => chart.value?.resize())
  ro.observe(chartEl.value)
  // Re-theme the canvas when the OS/user toggles light↔dark (`.dark` on <html>).
  themeObserver = new MutationObserver(() => redraw())
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  document.addEventListener('visibilitychange', onVisibility)
  await tick()
  if (props.autoStart) start()
})

onBeforeUnmount(() => {
  // stop() (not just stopTimer()) bumps pollGen + clears isReload, so a tick that is
  // mid-fetch at unmount won't reschedule itself onto the disposed chart.
  stop()
  ro?.disconnect()
  themeObserver?.disconnect()
  mql?.removeEventListener('change', onNarrowChange)
  document.removeEventListener('visibilitychange', onVisibility)
  chart.value?.dispose()
  // Null the ref AFTER dispose so a tick still mid-fetch (e.g. changeRange's `void
  // tick()`) resolving post-unmount hits `chart.value?.setOption` as a no-op instead
  // of calling into a disposed ECharts instance.
  chart.value = null
})
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="font-semibold">
          {{ title }} — в очередях {{ fmt(total) }}
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <B24Button
            :icon="isReload ? PauseLIcon : PlayLIcon"
            :label="isReload ? 'Пауза' : 'Запуск'"
            color="air-tertiary-no-accent"
            size="sm"
            @click="toggleReload"
          />
          <B24Select
            :model-value="poll"
            :items="POLL_ITEMS"
            size="sm"
            class="w-28"
            aria-label="Частота опроса очередей"
            @update:model-value="changePoll"
          />
          <B24Select
            :model-value="range"
            :items="RANGE_ITEMS"
            size="sm"
            class="w-32"
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

    <!-- Chart spans the FULL card width (wider is easier to read a live trend); the
         legend table sits below it rather than stealing horizontal room. -->
    <div class="flex flex-col gap-4">
      <!-- Canvas chart has no accessible text; expose the current total as a label
           (the legend table below carries the per-queue detail). -->
      <div
        ref="chartEl"
        role="img"
        :aria-label="`График длины очередей обработки, всего в очередях: ${total}`"
        class="h-80 w-full sm:h-96"
      />

      <div class="w-full max-w-2xl">
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
