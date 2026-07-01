<script setup lang="ts">
/**
 * QueueMonitor — живой график длины (backlog) очередей BullMQ на Vue 3 + ECharts.
 *
 * Порт примера shef.rabbitmq:statistic (оригинал — коммерческий amCharts4) на
 * бесплатную ECharts (Apache-2.0). Под нашу реальность: источник — снапшот
 * GET /api/queues (без истории/rate'ов), поэтому временной ряд строим на клиенте —
 * каждый опрос добавляет точку `[время, backlog]` в скользящее окно (см.
 * app/utils/queueChart.ts, docs/QUEUES.md). ECharts грузится динамически (только на
 * этой странице, вне лендинг-бандла) в onMounted — клиентский рендер.
 */
import { ref, shallowRef, computed, onMounted, onBeforeUnmount } from 'vue'
import type { ECharts } from 'echarts'
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
  /** Загрузчик снапшота очередей (например, GET /api/queues или демо-генератор). */
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

const INTERVALS = [2, 5, 10, 30]

const chartEl = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
// ECharts loaded lazily (client-only); kept out of the SSG landing bundle.
let echarts: typeof import('echarts') | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let ro: ResizeObserver | null = null

const interval = ref(props.intervalSec)
const isReload = ref(props.autoStart)
const error = ref('')
const total = ref(0)
const rows = ref<QueueLegendRow[]>([])
const hidden = ref<Record<string, boolean>>({})
const series = ref<SeriesPoints>(emptySeries())

const nf = new Intl.NumberFormat('ru')
const fmt = (v: number): string => nf.format(v)

const enabled = ref(true)

function baseOption() {
  return {
    animation: true,
    animationDurationUpdate: 200,
    grid: { left: 8, right: 40, top: 16, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => fmt(v) },
    legend: { show: false, selected: {} as Record<string, boolean> },
    xAxis: {
      type: 'time' as const,
      axisLabel: { hideOverlap: true, formatter: { second: '{HH}:{mm}:{ss}', minute: '{HH}:{mm}', hour: '{HH}:{mm}' } },
      splitLine: { show: true, lineStyle: { opacity: 0.25 } }
    },
    yAxis: { type: 'value' as const, min: 0, minInterval: 1, axisLabel: { inside: true }, splitLine: { lineStyle: { opacity: 0.25 } } },
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
  // Area fill under the "main" queue (crm-sync) — analog of the example's isMain.
  if (meta.main && echarts) {
    s.areaStyle = {
      opacity: 0.2,
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
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
    series.value = appendSnapshot(series.value, snapshot, Date.now(), props.maxPoints)
    rows.value = legendRows(snapshot)
    total.value = totalBacklog(snapshot)
    // Update only the series data (ECharts diffs + animates the change).
    chart.value?.setOption({ series: QUEUE_META.map(m => ({ id: m.name, data: series.value[m.name] })) })
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
  timer = setTimeout(async () => {
    await tick()
    if (isReload.value) scheduleNext()
  }, interval.value * 1000)
}
function start() {
  isReload.value = true
  stopTimer()
  scheduleNext()
}
function stop() {
  isReload.value = false
  stopTimer()
}
function toggleReload() {
  if (isReload.value) stop()
  else start()
}
function changeInterval(v: number) {
  interval.value = v
  if (isReload.value) start()
}
function toggleLine(row: QueueLegendRow) {
  hidden.value = { ...hidden.value, [row.name]: !hidden.value[row.name] }
  chart.value?.dispatchAction({ type: 'legendToggleSelect', name: row.label })
}

const legendView = computed<QueueLegendRow[]>(() => rows.value.length ? rows.value : legendRows({ enabled: true, queues: {} }))

onMounted(async () => {
  echarts = await import('echarts')
  if (!chartEl.value) return
  chart.value = echarts.init(chartEl.value)
  redraw()
  ro = new ResizeObserver(() => chart.value?.resize())
  ro.observe(chartEl.value)
  await tick()
  if (props.autoStart) start()
})

onBeforeUnmount(() => {
  stopTimer()
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="qm-card">
    <div class="qm-header">
      <h3 class="qm-title">
        {{ title }} — в очередях {{ fmt(total) }}
      </h3>
      <div class="qm-actions">
        <button
          class="qm-btn"
          type="button"
          @click="toggleReload"
        >
          {{ isReload ? '⏸ пауза' : '▶ запуск' }}
        </button>
        <select
          class="qm-select"
          :value="interval"
          @change="changeInterval(Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="v in INTERVALS"
            :key="v"
            :value="v"
          >
            каждые {{ v }} сек
          </option>
        </select>
      </div>
    </div>

    <div
      v-if="!enabled"
      class="qm-note"
    >
      Очереди выключены (нет <code>REDIS_URL</code>).
    </div>
    <div
      v-if="error"
      class="qm-error"
    >
      {{ error }}
    </div>

    <div class="qm-body">
      <div
        ref="chartEl"
        class="qm-chart"
      />

      <div class="qm-legend">
        <div class="qm-legend-row qm-legend-head">
          <span class="qm-col-name">Очередь</span>
          <span class="qm-col-val">ждут</span>
          <span class="qm-col-val">работа</span>
          <span class="qm-col-val">готово</span>
          <span class="qm-col-val">ошибки</span>
        </div>
        <div
          v-for="row in legendView"
          :key="row.name"
          class="qm-legend-row"
          :class="{ hidden: hidden[row.name] }"
        >
          <span
            class="qm-col-name"
            @click="toggleLine(row)"
          >
            <i
              class="qm-dot"
              :style="{ background: row.color }"
            />{{ row.label }}
          </span>
          <span class="qm-col-val">{{ fmt(row.waiting) }}</span>
          <span class="qm-col-val">{{ fmt(row.active) }}</span>
          <span class="qm-col-val">{{ fmt(row.completed) }}</span>
          <span
            class="qm-col-val"
            :class="{ 'qm-fail': row.failed > 0 }"
          >{{ fmt(row.failed) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qm-card { border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; font-size: 14px; color: #111827; }
.qm-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #eee; }
.qm-title { margin: 0; font-size: 16px; font-weight: 600; }
.qm-actions { display: flex; gap: 8px; }
.qm-btn, .qm-select { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; cursor: pointer; }
.qm-note { margin: 8px 16px; padding: 8px 12px; border-radius: 6px; background: #fffbeb; color: #92400e; }
.qm-error { margin: 8px 16px; padding: 8px 12px; border-radius: 6px; background: #fef2f2; color: #b91c1c; }
.qm-body { display: flex; gap: 8px; padding: 12px; flex-wrap: wrap; }
.qm-chart { flex: 1 1 60%; min-width: 320px; min-height: 320px; }
.qm-legend { flex: 1 1 30%; min-width: 280px; }
.qm-legend-row { display: flex; align-items: center; padding: 6px 4px; border-bottom: 1px solid #f0f0f0; }
.qm-legend-head { font-weight: 600; color: #6b7280; }
.qm-legend-head .qm-col-val { font-size: 12px; }
.qm-legend-row.hidden { opacity: 0.4; }
.qm-col-name { flex: 1 1 auto; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.qm-legend-head .qm-col-name { cursor: default; }
.qm-col-name:hover { color: #2563eb; }
.qm-col-val { flex: 0 0 56px; text-align: center; }
.qm-fail { color: #b91c1c; font-weight: 600; }
.qm-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
</style>
