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
  /** Интервал опроса, сек. */
  intervalSec?: number
  /** Сколько точек держать в окне (ширина «бегущей ленты»). */
  maxPoints?: number
  autoStart?: boolean
}>(), {
  title: 'Очереди обработки',
  intervalSec: 5,
  maxPoints: 60,
  autoStart: true
})

const INTERVAL_ITEMS = [2, 5, 10, 30].map(v => ({ label: `каждые ${v} сек`, value: v }))

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

const interval = ref(props.intervalSec)
const isReload = ref(props.autoStart)
const error = ref('')
const total = ref(0)
const rows = ref<QueueLegendRow[]>([])
const hidden = ref<Record<string, boolean>>({})
const series = ref<SeriesPoints>(emptySeries())
// Right edge of the sliding time window (latest poll time); the X axis follows it
// so the chart scrolls left as new points arrive. Null until the first tick.
const lastTickAt = ref<number | null>(null)
// When polling started — the window grows from here until it reaches the full span,
// then slides. Keeps the chart looking full on fresh load instead of bunched right.
const startedAt = ref<number | null>(null)

const nf = new Intl.NumberFormat('ru')
const fmt = (v: number): string => nf.format(v)

const enabled = ref(true)

/** The [min, max] time window the X axis should show right now — a fixed span
 *  ending at the latest poll, so dates slide left continuously. Early on (before a
 *  full span has elapsed) the left edge is pinned to `startedAt`, so the window
 *  grows to fill the axis rather than leaving the data bunched at the right. */
function axisWindow(): { min: number, max: number } {
  const max = lastTickAt.value ?? Date.now()
  const spanStart = max - props.maxPoints * interval.value * 1000
  const grown = startedAt.value != null ? Math.max(spanStart, startedAt.value) : spanStart
  // Keep the window at least one interval wide so the first tick (startedAt === max)
  // doesn't collapse the axis to zero width.
  return { min: Math.min(grown, max - interval.value * 1000), max }
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
  // Soft gradient area fill under EVERY series (the "main" queue a touch stronger),
  // kept low-opacity so 4 overlapping fills stay readable, not muddy.
  if (echartsCore) {
    s.areaStyle = {
      opacity: meta.main ? 0.14 : 0.08,
      color: new echartsCore.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: meta.color },
        { offset: 1, color: 'rgba(0,0,0,0)' }
      ])
    }
  }
  return s
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
    if (startedAt.value == null) startedAt.value = now
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
    // (e.g. an interval change during an in-flight fetch) dies here.
    if (isReload.value && gen === pollGen) scheduleNext()
  }, interval.value * 1000)
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
function changeInterval(v: unknown) {
  interval.value = Number(v)
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
            :model-value="interval"
            :items="INTERVAL_ITEMS"
            size="sm"
            class="w-40"
            @update:model-value="changeInterval"
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
