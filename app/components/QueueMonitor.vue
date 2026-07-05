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
  bucketSnapshot,
  seedSeries,
  emptySeries,
  legendRows,
  totalBacklog,
  windowPlan,
  type QueueLegendRow,
  type QueuesSnapshot,
  type SeriesPoints
} from '~/utils/queueChart'

const props = withDefaults(defineProps<{
  /** Загрузчик снапшота очередей (например, GET /api/ops/queues или демо-генератор). */
  fetcher: () => Promise<QueuesSnapshot>
  title?: string
  /** Видимый диапазон времени, мин (по умолчанию 10). Дискрет и частота опроса
   *  выводятся из него автоматически (см. windowPlan). */
  rangeMin?: number
  /** Потолок числа точек — страховка (дискрет и так держит ~10–14). */
  maxPoints?: number
  autoStart?: boolean
}>(), {
  title: 'Очереди обработки',
  rangeMin: 10,
  maxPoints: 400,
  autoStart: true
})

/** Выбор видимого диапазона (мин). Единственный регулятор — дискрет и частота опроса
 *  подбираются автоматически под диапазон (windowPlan). */
const RANGE_ITEMS = [
  { label: '2 минуты', value: 2 },
  { label: '10 минут', value: 10 },
  { label: '30 минут', value: 30 },
  { label: '4 часа', value: 240 }
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
// requestAnimationFrame handle + last-painted timestamp for the axis-slide loop.
// 0 = not running.
let rafId = 0
let lastFrameAt = 0
// Repaint only once the axis has advanced ~¼px since the last paint (a sub-pixel step is
// AA-smooth), floored at ~30fps so a narrow range stays fluid. This paces the redraw to
// the ACTUAL motion: a 10-min window creeps <2px/s so it needs only a few fps; a 4-h
// window barely moves so it rests between paints — far cheaper than a flat 30fps that
// redraws ~1600 vertices forever regardless of how little the axis moved.
const MIN_FRAME_MS = 33
const MIN_PAINT_PX = 0.25
// The first successful tick BACKFILLS a full window (seedSeries) so the chart starts
// full and immediately slides — no "grow from empty / clamped first date". Afterwards
// each tick appends one point. Reset to false on a range change to re-seed the new span.
let seeded = false

const range = ref(props.rangeMin) // minutes (selected window width)
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

// Derived window plan (span/step/pointCount/anim-duration). Pure — see queueChart.ts.
// Called imperatively from tick()/baseOption()/scheduleNext(); NOT reactive/computed,
// so don't reference it from the template (it won't update there).
function plan() {
  return windowPlan(range.value, isNarrow.value, props.maxPoints)
}

/** Axis/grid colours for the current theme (ECharts draws on canvas — CSS vars don't apply). */
function themeColors() {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return dark
    ? { axis: '#9aa4b2', split: 'rgba(255,255,255,0.10)' }
    : { axis: '#6b7280', split: 'rgba(0,0,0,0.10)' }
}

/** The [min, max] wall-clock window shown now: [now − span, now]. The rAF loop pushes
 *  this every frame, so the axis slides continuously right-to-left while each plotted
 *  point keeps its own (timestamp, value) — the point's Y never moves, it only scrolls
 *  left. `atMs` lets callers pass a shared frame timestamp. */
function currentWindow(atMs: number): { min: number, max: number } {
  return { min: atMs - plan().windowMs, max: atMs }
}

function baseOption() {
  const c = themeColors()
  return {
    // NO update animation. Motion is a rAF axis-slide (see renderFrame), NOT an ECharts
    // data tween — a data tween interpolates points BY INDEX, so when the window shifts
    // (drop oldest, append newest) every point morphs toward its neighbour's value and
    // the whole line jumps in Y. With animation off, a plotted point holds its Y and the
    // moving axis just carries it leftward. Initial draw is instant (seed fills the window).
    animation: false as const,
    // Nudge overlapping end-labels apart (all queues share y=0 in the idle state →
    // four "0" would stack on the right edge otherwise).
    labelLayout: { moveOverlap: 'shiftY' as const },
    grid: { left: 8, right: 40, top: 16, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => fmt(v) },
    legend: { show: false, selected: {} as Record<string, boolean> },
    xAxis: {
      type: 'time' as const,
      // Explicit numeric [now-span, now] window (not data extent) — the rAF loop advances
      // both edges every frame for a smooth continuous slide, independent of when data
      // points actually arrive.
      ...currentWindow(Date.now()),
      // Keep ticks ≥1 min apart so labels stay minute-level even on the narrow
      // (phone, half-span) window — otherwise ticks can land on half-minute marks and
      // ECharts drops to a noisy `HH:mm:ss` format.
      minInterval: 60_000,
      // `day` level → a window crossing midnight (up to the 4h range) shows the date.
      // `second` still maps to HH:mm (no seconds) as a belt-and-suspenders fallback.
      axisLabel: { hideOverlap: true, color: c.axis, formatter: { second: '{HH}:{mm}', minute: '{HH}:{mm}', hour: '{HH}:{mm}', day: '{dd}.{MM}' } },
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
    // First tick backfills a full window of buckets (flat at the current backlog) so the
    // chart is full from frame one and slides; later ticks fold the reading into the
    // current time bucket (latest value = current depth) — bucketSnapshot.
    const p = plan()
    // Keep 2 extra buckets beyond the window: the seed/newest points would otherwise land
    // exactly on the edges and slide INSIDE, leaving a triangular gap at the left (and the
    // line ending short). Overshooting by ~2 buckets makes the line span past both edges so
    // ECharts clips it flush to the plot box. Cheap (+2 of ~12 points).
    const cap = p.pointCount + 2
    if (!seeded) {
      series.value = seedSeries(snapshot, now, p.bucketMs, cap)
      seeded = true
    } else {
      series.value = bucketSnapshot(series.value, snapshot, now, p.bucketMs, cap)
    }
    rows.value = legendRows(snapshot)
    total.value = totalBacklog(snapshot)
    // Push the updated bucket(s) with NO animation (animation:false) — settled points
    // never morph (only the live tip tracks the current reading). The rAF loop owns the
    // x-axis slide. Merge (not notMerge) keeps the fills/gradients.
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
/** The rAF axis-slide: every ~FRAME_MS push a fresh [now-span, now] window so the chart
 *  scrolls smoothly left. Runs only while playing (isReload); rAF also self-pauses when
 *  the tab is hidden. Reads the live `plan().windowMs`, so range/poll/breakpoint changes
 *  take effect on the next frame with no restart. */
function renderFrame() {
  rafId = 0
  if (!isReload.value || !chart.value) return
  const now = Date.now()
  // Paint interval = time for the axis to travel MIN_PAINT_PX, floored at MIN_FRAME_MS.
  // ms-per-px = windowMs / chart width; wide windows → long interval (rest), narrow →
  // short (fluid). getWidth() is the canvas width (plot area is a bit less — close enough).
  const widthPx = Math.max(1, chart.value.getWidth())
  const interval = Math.max(MIN_FRAME_MS, (plan().windowMs / widthPx) * MIN_PAINT_PX)
  if (now - lastFrameAt >= interval) {
    lastFrameAt = now
    chart.value.setOption({ xAxis: currentWindow(now) })
  }
  rafId = requestAnimationFrame(renderFrame)
}
function startRaf() {
  if (!rafId && typeof requestAnimationFrame !== 'undefined') rafId = requestAnimationFrame(renderFrame)
}
function stopRaf() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}
function scheduleNext() {
  const gen = pollGen
  timer = setTimeout(async () => {
    await tick()
    // Only the current generation reschedules — a chain superseded by start()/stop()
    // (e.g. a range change during an in-flight fetch) dies here.
    if (isReload.value && gen === pollGen) scheduleNext()
  }, plan().pollMs)
}
function start() {
  isReload.value = true
  pollGen++
  stopTimer()
  scheduleNext()
  startRaf()
}
function stop() {
  isReload.value = false
  pollGen++
  stopTimer()
  stopRaf() // freeze the slide for inspection while paused
  // Re-seed on the next resume: after a pause (or a fetch error) the retained window is
  // stale — resuming would append across the pause gap and draw a straight bridge over
  // it. Dropping `seeded` makes the resume rebuild a fresh full window at current backlog.
  seeded = false
}
function toggleReload() {
  if (isReload.value) stop()
  else start()
}
/** Pause polling + the axis-slide while the tab is hidden (no point burning CPU/fetches
 *  off-screen), and resume on return. Keeps `isReload` (the ▶/⏸ state) untouched; drops
 *  `seeded` so the return re-seeds a fresh window rather than bridging the hidden gap. */
function onVisibility() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    pollGen++
    stopTimer()
    stopRaf()
    seeded = false
  } else if (isReload.value) {
    pollGen++
    stopTimer()
    scheduleNext()
    startRaf()
  }
}
/** Re-seed a fresh full window after any span/step change (range, poll cadence, or the
 *  phone/desktop breakpoint). redraw() rebuilds baseOption (new axis span); a repaint
 *  fires immediately so the change shows even while paused; if running, start()
 *  reschedules the poll loop + slide at the new step. */
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
          {{ title }} — сейчас в очереди {{ fmt(total) }}
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

    <!-- Honest hint: on a phone we show half the selected span (the axis reads ~5 min
         while the selector says «10 минут») so the narrow axis isn't cramped. -->
    <p
      v-if="isNarrow"
      class="mb-2 text-[11px] text-(--ui-color-base-4)"
    >
      На телефоне показана половина выбранного окна.
    </p>

    <!-- Explain the metric up front: the exact misread is "these look like counts of
         processed items". The line is the CURRENT queue length, not throughput. -->
    <p class="mb-3 text-xs text-(--ui-color-base-3)">
      Высота линии — сколько задач <strong>сейчас</strong> в очереди (ждут + в работе),
      а не сколько уже обработано. Чем выше, тем больше скопилось необработанного.
    </p>

    <!-- Chart spans the FULL card width (wider is easier to read a live trend); the
         legend table sits below it rather than stealing horizontal room. -->
    <div class="flex flex-col gap-4">
      <!-- Canvas chart has no accessible text; expose the current total as a label
           (the legend table below carries the per-queue detail). -->
      <div
        ref="chartEl"
        role="img"
        :aria-label="`График длины очередей: сколько задач сейчас ждут и в работе. Всего в очереди: ${total}`"
        class="h-80 w-full sm:h-96"
      />

      <div class="w-full max-w-2xl">
        <div class="grid grid-cols-[minmax(0,1fr)_repeat(4,3rem)] gap-x-1.5 border-b border-(--ui-color-design-tinted-na-stroke) pb-1.5 text-[11px] font-semibold text-(--ui-color-base-3)">
          <span>Очередь</span>
          <span class="text-center">ждут</span>
          <span class="text-center">в работе</span>
          <span class="text-center">готово</span>
          <span class="text-center">ошибки</span>
        </div>
        <button
          v-for="row in legendView"
          :key="row.name"
          type="button"
          :aria-pressed="!hidden[row.name]"
          class="grid w-full grid-cols-[minmax(0,1fr)_repeat(4,3rem)] items-center gap-x-1.5 border-b border-(--ui-color-design-tinted-na-stroke) py-1.5 text-left text-sm tabular-nums transition-opacity last:border-b-0 hover:opacity-80"
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
        <!-- Disambiguate the columns: the first two are the live snapshot (what the chart
             plots), the last two are running totals — the part that reads as "processed". -->
        <p class="mt-2 text-[11px] leading-snug text-(--ui-color-base-4)">
          «Ждут» и «в работе» — сейчас (их сумма = высота линии). «Готово» и «ошибки» —
          счётчики уже обработанных задач, а не текущая очередь.
        </p>
      </div>
    </div>
  </B24Card>
</template>
