<script setup lang="ts">
const canvas = ref<HTMLCanvasElement | null>(null)
let animId = 0
let resizeRaf = 0
let ctx: CanvasRenderingContext2D
let w = 0
let h = 0
let nextPerturb = 0
let ro: ResizeObserver
let io: IntersectionObserver | null = null
let prefersReduced = false
let isRunning = false
let inView = true // канвас в зоне видимости (IntersectionObserver)
let lastFrame = 0
let motionMql: MediaQueryList | null = null

// Троттлинг РЕНДЕРА до ~30fps: draw (canvas-градиенты/текст) — дорогая часть,
// вдвое меньше нагрузки. Физика (tick) идёт каждый кадр — движение не вялое.
const FRAME_MS = 1000 / 30

type Tier = 1 | 2 | 3

interface Node {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  tier: Tier
}

// Визуальная иерархия по уровням: 1 — главный (Битрикс24), 2 — вторичные
// (AI/MCP/REST), 3 — остальные. Разные радиус, яркость, размер шрифта.
const TIERS: Record<Tier, { r: number, glow: number, glowA: number, nodeA: number, labelA: number, font: string, dy: number }> = {
  1: { r: 5, glow: 24, glowA: 0.20, nodeA: 0.90, labelA: 0.82, font: 'bold 11px "Roboto Mono", monospace', dy: 21 },
  2: { r: 4, glow: 18, glowA: 0.14, nodeA: 0.66, labelA: 0.52, font: '10px "Roboto Mono", monospace', dy: 18 },
  3: { r: 3, glow: 13, glowA: 0.10, nodeA: 0.44, labelA: 0.30, font: '9px "Roboto Mono", monospace', dy: 16 }
}

// Force simulation tuning knobs — change here, not inline
const GRAVITY_K = 0.0014 // attraction strength toward gravity center
const REPULSION = 4800 // node-to-node repulsion constant
const SPRING_K = 0.018 // edge spring stiffness
const SPRING_LEN = 145 // edge rest length in px
const DAMPING = 0.855 // velocity decay per tick (0 = instant stop)
const NOISE = 0.045 // random walk noise added each tick
const BOUNDARY_PAD = 55 // how far nodes stay from canvas edges
const PHOTO_REPEL_R = 165 // repulsion radius around photo zone in px
// Horizontal offset of photo center inside max-w-[1080px] container:
// px-8(32) + text max-w-[620px](620) + lg:gap-12(48) + half-photo(120) = 820
const PHOTO_CONTAINER_OFFSET_X = 820
const PHOTO_RELATIVE_Y = 0.40 // photo vertical center as fraction of canvas height
const PERTURB_IMPULSE = 4 // velocity kick magnitude during periodic shake
const PERTURB_MIN_MS = 3500 // min ms between shakes
const PERTURB_JITTER_MS = 2500 // random extra ms added on top

const NODES_SRC: { id: string, label: string, tier: Tier }[] = [
  { id: 'b24', label: 'Битрикс24', tier: 1 },
  { id: 'ai', label: 'AI', tier: 2 },
  { id: 'mcp', label: 'MCP', tier: 2 },
  { id: 'rest', label: 'REST API', tier: 2 },
  { id: 'crm', label: 'CRM', tier: 3 },
  { id: 'claude', label: 'Claude', tier: 3 },
  { id: 'openai', label: 'OpenAI', tier: 3 },
  { id: 'tasks', label: 'Задачи', tier: 3 },
  { id: 'catalog', label: 'Каталог', tier: 3 },
  { id: 'webhook', label: 'Webhooks', tier: 3 },
  { id: 'sdk', label: 'b24jssdk', tier: 3 },
  { id: 'b24ui', label: 'b24ui', tier: 3 },
  { id: 'integration', label: 'Интеграции', tier: 3 }
]

const EDGES: [string, string][] = [
  ['b24', 'crm'], ['b24', 'tasks'], ['b24', 'catalog'],
  ['b24', 'sdk'], ['b24', 'rest'], ['b24', 'webhook'],
  ['b24', 'b24ui'], ['b24', 'integration'],
  ['ai', 'claude'], ['ai', 'openai'], ['ai', 'b24'],
  ['mcp', 'ai'], ['mcp', 'b24'], ['mcp', 'rest'],
  ['rest', 'integration'], ['sdk', 'b24ui'], ['sdk', 'ai']
]

let nodes: Node[] = []
let nodeMap = new Map<string, Node>()

function init() {
  if (!canvas.value) return
  resize()

  nodes = NODES_SRC.map(n => ({
    ...n,
    x: w * 0.5 + (Math.random() - 0.5) * w * 0.70,
    y: h * 0.5 + (Math.random() - 0.5) * h * 0.65,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    r: TIERS[n.tier].r
  }))
  nodeMap = new Map(nodes.map(n => [n.id, n]))
  nextPerturb = Date.now() + 2500
}

function resize() {
  if (!canvas.value) return
  // RAF debounce: coalesces burst resize events into a single update
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    if (!canvas.value) return
    w = canvas.value.width = canvas.value.offsetWidth
    h = canvas.value.height = canvas.value.offsetHeight
    // Resize сбрасывает содержимое canvas — при reduced-motion перерисуем кадр.
    if (prefersReduced && ctx) draw()
  })
}

function tick() {
  const now = Date.now()

  if (now > nextPerturb) {
    for (const n of nodes) {
      n.vx += (Math.random() - 0.5) * PERTURB_IMPULSE
      n.vy += (Math.random() - 0.5) * PERTURB_IMPULSE
    }
    nextPerturb = now + PERTURB_MIN_MS + Math.random() * PERTURB_JITTER_MS
  }

  // Gravity center — right of center on desktop, top-right on mobile
  const cx = w > 900 ? w * 0.70 : w * 0.75
  const cy = w > 900 ? h * 0.58 : h * 0.22

  // Photo zone repulsion (desktop only — off-screen sentinel on mobile)
  const photoX = w > 900 ? Math.max(0, (w - 1080) / 2) + PHOTO_CONTAINER_OFFSET_X : -9999
  const photoY = h * PHOTO_RELATIVE_Y

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!
    a.vx += (cx - a.x) * GRAVITY_K
    a.vy += (cy - a.y) * GRAVITY_K
    a.vx += (Math.random() - 0.5) * NOISE
    a.vy += (Math.random() - 0.5) * NOISE

    // Repel from photo zone
    const pdx = a.x - photoX
    const pdy = a.y - photoY
    const pdist = Math.sqrt(pdx * pdx + pdy * pdy) + 0.01
    if (pdist < PHOTO_REPEL_R) {
      const pf = Math.pow((PHOTO_REPEL_R - pdist) / PHOTO_REPEL_R, 2) * 5
      a.vx += (pdx / pdist) * pf
      a.vy += (pdy / pdist) * pf
    }

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = dx * dx + dy * dy + 0.01
      const d = Math.sqrt(d2)
      const f = REPULSION / d2
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  for (const [sId, tId] of EDGES) {
    const s = nodeMap.get(sId)
    const t = nodeMap.get(tId)
    if (!s || !t) continue
    const dx = t.x - s.x
    const dy = t.y - s.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = (d - SPRING_LEN) * SPRING_K
    const fx = (dx / d) * f
    const fy = (dy / d) * f
    s.vx += fx
    s.vy += fy
    t.vx -= fx
    t.vy -= fy
  }

  for (const n of nodes) {
    n.vx *= DAMPING
    n.vy *= DAMPING
    n.x += n.vx
    n.y += n.vy
    if (n.x < BOUNDARY_PAD) n.vx += (BOUNDARY_PAD - n.x) * 0.12
    if (n.x > w - BOUNDARY_PAD) n.vx -= (n.x - (w - BOUNDARY_PAD)) * 0.12
    if (n.y < BOUNDARY_PAD) n.vy += (BOUNDARY_PAD - n.y) * 0.12
    if (n.y > h - BOUNDARY_PAD) n.vy -= (n.y - (h - BOUNDARY_PAD)) * 0.12
  }
}

function draw() {
  ctx.clearRect(0, 0, w, h)
  const CH = '0, 212, 255'

  // Edges
  ctx.lineWidth = 1
  for (const [sId, tId] of EDGES) {
    const s = nodeMap.get(sId)
    const t = nodeMap.get(tId)
    if (!s || !t) continue
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(t.x, t.y)
    ctx.strokeStyle = `rgba(${CH}, 0.10)`
    ctx.stroke()
  }

  // Nodes — параметры по уровню иерархии (TIERS)
  for (const n of nodes) {
    const t = TIERS[n.tier]
    const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, t.glow)
    grd.addColorStop(0, `rgba(${CH}, ${t.glowA})`)
    grd.addColorStop(1, `rgba(${CH}, 0)`)
    ctx.beginPath()
    ctx.arc(n.x, n.y, t.glow, 0, Math.PI * 2)
    ctx.fillStyle = grd
    ctx.fill()

    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${CH}, ${t.nodeA})`
    ctx.fill()

    ctx.font = t.font
    ctx.fillStyle = n.tier === 1 ? `rgba(${CH}, ${t.labelA})` : `rgba(255,255,255,${t.labelA})`
    ctx.textAlign = 'center'
    ctx.fillText(n.label, n.x, n.y + t.dy)
  }
}

function loop(now: number) {
  animId = requestAnimationFrame(loop)
  // Физика — каждый кадр (дёшево при n=13): сохраняет «живость» движения.
  tick()
  // Рендер троттлим до ~30fps: draw (градиенты/текст) — дорогая часть,
  // вдвое меньше нагрузки и без визуальной вялости.
  if (now - lastFrame < FRAME_MS) return
  lastFrame = now
  draw()
}

// Один владелец цикла: isRunning защищает от двойного RAF при быстрых
// переходах (иначе два параллельных loop ускорили бы анимацию).
function start() {
  if (isRunning) return
  isRunning = true
  lastFrame = 0
  animId = requestAnimationFrame(loop)
}

function stop() {
  cancelAnimationFrame(animId)
  isRunning = false
}

// Анимация крутится только когда все условия за: движение не урезано,
// вкладка видна и канвас в зоне видимости (экономия батареи/CPU).
function sync() {
  if (!prefersReduced && !document.hidden && inView) start()
  else stop()
}

// Пауза анимации, когда вкладка не видна — экономит батарею/CPU на мобильных.
function onVisibility() {
  sync()
}

// Реакция на смену системной настройки «уменьшить движение» без перезагрузки.
function onMotionChange(e: MediaQueryListEvent) {
  prefersReduced = e.matches
  sync()
  if (prefersReduced) draw() // оставляем один статичный кадр
}

onMounted(() => {
  if (!canvas.value) return
  const c = canvas.value.getContext('2d')
  if (!c) return // 2D-контекст недоступен — тихо пропускаем фон
  ctx = c
  motionMql = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  prefersReduced = motionMql?.matches ?? false
  init()
  draw() // первый кадр сразу (и единственный — при reduced-motion)

  document.addEventListener('visibilitychange', onVisibility)
  motionMql?.addEventListener('change', onMotionChange)
  ro = new ResizeObserver(resize)
  ro.observe(canvas.value)

  // IntersectionObserver — анимировать только пока канвас в зоне видимости.
  io = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? true
    sync()
  }, { threshold: 0.01 })
  io.observe(canvas.value)

  sync() // старт, если условия за (видно + не reduced)
})

onUnmounted(() => {
  stop()
  cancelAnimationFrame(resizeRaf)
  ro?.disconnect()
  io?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  motionMql?.removeEventListener('change', onMotionChange)
})
</script>

<template>
  <canvas
    ref="canvas"
    class="absolute inset-0 w-full h-full pointer-events-none select-none"
    aria-hidden="true"
  />
</template>
