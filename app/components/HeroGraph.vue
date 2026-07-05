<script setup lang="ts">
// Hero background: a network of outer nodes feeding IMPULSES into one central
// hub (все импульсы входят в центр). Outer nodes drift with a light force-sim
// (gravity toward hub + mutual repulsion + repulsion from the photo zone); the
// hub is pinned at the gravity center. Along every spoke, bright pulses travel
// inward; each arrival triggers an expanding ring at the hub.
//
// Performance: physics runs every frame (cheap — ~11 nodes, ~22 pulses), the
// canvas draw is throttled to ~30fps. The whole loop is paused when the tab is
// hidden, the canvas is offscreen (IntersectionObserver), or the user prefers
// reduced motion (then a single static frame is drawn).
//
// Parametrised so different pages can theme it: `rgb` sets the accent colour
// channel (default primary cyan; /partners passes a violet palette), and
// `photo=false` disables the photo-repel zone on pages without a hero portrait.
const props = withDefaults(defineProps<{
  rgb?: string
  photo?: boolean
}>(), {
  rgb: '0, 212, 255',
  photo: true
})

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
let inView = true
let lastFrame = 0
let motionMql: MediaQueryList | null = null
let tPrev = 0

const FRAME_MS = 1000 / 30

// Force-sim tuning (outer nodes only; the hub is pinned).
const GRAVITY_K = 0.0016
const REPULSION = 5200
const DAMPING = 0.86
const NOISE = 0.04
const BOUNDARY_PAD = 48
const PHOTO_REPEL_R = 165
// Photo center inside the max-w-[1080px] hero container (desktop):
// px-8(32) + text max-w-[620px](620) + lg:gap-12(48) + half-photo(120) = 820
const PHOTO_CONTAINER_OFFSET_X = 820
const PHOTO_RELATIVE_Y = 0.40
const PERTURB_IMPULSE = 2.4
const PERTURB_MIN_MS = 4000
const PERTURB_JITTER_MS = 3000

// Pulse travel speed in edge-fraction per second, plus how many are in flight
// per spoke at once (staggered) — this is the "много импульсов" knob.
const PULSE_SPEED = 0.55
const PULSES_PER_EDGE = 2

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
  hub?: boolean
}

const TIERS: Record<Tier, { r: number, glow: number, glowA: number, nodeA: number, labelA: number, font: string, dy: number }> = {
  1: { r: 6, glow: 30, glowA: 0.22, nodeA: 0.95, labelA: 0.85, font: 'bold 12px "Roboto Mono", monospace', dy: 24 },
  2: { r: 4, glow: 18, glowA: 0.14, nodeA: 0.68, labelA: 0.55, font: '10px "Roboto Mono", monospace', dy: 18 },
  3: { r: 3, glow: 13, glowA: 0.10, nodeA: 0.46, labelA: 0.34, font: '9px "Roboto Mono", monospace', dy: 16 }
}

// Product-flavoured nodes: banks + statement + CRM entities all flow into B24.
const NODES_SRC: { id: string, label: string, tier: Tier, hub?: boolean }[] = [
  { id: 'b24', label: 'Bitrix24', tier: 1, hub: true },
  { id: 'alfa', label: 'Альфа', tier: 2 },
  { id: 'prior', label: 'Приор', tier: 2 },
  { id: 'statement', label: 'Выписка', tier: 2 },
  { id: 'deal', label: 'Сделка', tier: 3 },
  { id: 'invoice', label: 'Счёт', tier: 3 },
  { id: 'order', label: 'Заказ', tier: 3 },
  { id: 'payment', label: 'Оплата', tier: 3 },
  { id: 'company', label: 'Контрагент', tier: 3 },
  { id: 'chat', label: 'Чат', tier: 3 },
  { id: '1c', label: '1С', tier: 3 }
]

interface Pulse {
  from: number // node index (outer endpoint)
  t: number // 0 at outer node, 1 at hub
  speed: number
}

interface Ring {
  r: number
  alpha: number
}

let nodes: Node[] = []
let hub: Node | null = null
let outerIdx: number[] = [] // indices of non-hub nodes
let pulses: Pulse[] = []
let rings: Ring[] = []

// Pre-baked node glow sprites (one per tier). The glow is a static radial
// gradient — baking it once into an offscreen canvas and drawImage-ing it each
// frame avoids ~330 createRadialGradient calls/sec (perf on weak mobiles).
let glowSprites: Record<Tier, HTMLCanvasElement> | null = null

function buildGlowSprites() {
  const make = (glow: number, glowA: number): HTMLCanvasElement => {
    const s = document.createElement('canvas')
    const size = Math.ceil(glow * 2)
    s.width = s.height = size
    const g = s.getContext('2d')
    if (g) {
      const grd = g.createRadialGradient(glow, glow, 0, glow, glow, glow)
      grd.addColorStop(0, `rgba(${props.rgb}, ${glowA})`)
      grd.addColorStop(1, `rgba(${props.rgb}, 0)`)
      g.fillStyle = grd
      g.beginPath()
      g.arc(glow, glow, glow, 0, Math.PI * 2)
      g.fill()
    }
    return s
  }
  glowSprites = {
    1: make(TIERS[1].glow, TIERS[1].glowA),
    2: make(TIERS[2].glow, TIERS[2].glowA),
    3: make(TIERS[3].glow, TIERS[3].glowA)
  }
}

function init() {
  if (!canvas.value) return
  resize()

  nodes = NODES_SRC.map(n => ({
    ...n,
    x: w * 0.5 + (Math.random() - 0.5) * w * 0.6,
    y: h * 0.5 + (Math.random() - 0.5) * h * 0.6,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    r: TIERS[n.tier].r
  }))
  hub = nodes.find(n => n.hub) ?? nodes[0] ?? null
  outerIdx = nodes.map((n, i) => (n.hub ? -1 : i)).filter(i => i >= 0)

  // Seed pulses staggered along each spoke so the flow looks continuous.
  pulses = []
  for (const i of outerIdx) {
    for (let k = 0; k < PULSES_PER_EDGE; k++) {
      pulses.push({ from: i, t: -(k / PULSES_PER_EDGE) - Math.random() * 0.3, speed: PULSE_SPEED })
    }
  }
  rings = []
  nextPerturb = Date.now() + 2500
}

function resize() {
  if (!canvas.value) return
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    if (!canvas.value) return
    w = canvas.value.width = canvas.value.offsetWidth
    h = canvas.value.height = canvas.value.offsetHeight
    if (prefersReduced && ctx) draw()
  })
}

function tick(dt: number) {
  const now = Date.now()

  // Hub pinned in an open area so the convergence + arrival rings stay visible,
  // NOT behind the hero photo: below-right of it on desktop, top-right (beside
  // the top-left photo) on mobile.
  const cx = w > 900 ? w * 0.72 : w * 0.80
  const cy = w > 900 ? h * 0.74 : h * 0.13
  if (hub) {
    hub.x = cx
    hub.y = cy
    hub.vx = hub.vy = 0
  }

  if (now > nextPerturb) {
    for (const i of outerIdx) {
      const n = nodes[i]!
      n.vx += (Math.random() - 0.5) * PERTURB_IMPULSE
      n.vy += (Math.random() - 0.5) * PERTURB_IMPULSE
    }
    nextPerturb = now + PERTURB_MIN_MS + Math.random() * PERTURB_JITTER_MS
  }

  // Photo repel zone. Desktop: photo in the right column of the max-w-[1080px]
  // container. Mobile: photo is top-left (order-first, justify-start, size-44).
  const photoX = w > 900 ? Math.max(0, (w - 1080) / 2) + PHOTO_CONTAINER_OFFSET_X : w * 0.28
  const photoY = w > 900 ? h * PHOTO_RELATIVE_Y : h * 0.20

  // Outer-node forces: gravity toward hub, mutual repulsion, photo repulsion.
  for (let a = 0; a < outerIdx.length; a++) {
    const na = nodes[outerIdx[a]!]!
    na.vx += (cx - na.x) * GRAVITY_K
    na.vy += (cy - na.y) * GRAVITY_K
    na.vx += (Math.random() - 0.5) * NOISE
    na.vy += (Math.random() - 0.5) * NOISE

    if (props.photo) {
      const pdx = na.x - photoX
      const pdy = na.y - photoY
      const pdist = Math.sqrt(pdx * pdx + pdy * pdy) + 0.01
      if (pdist < PHOTO_REPEL_R) {
        const pf = Math.pow((PHOTO_REPEL_R - pdist) / PHOTO_REPEL_R, 2) * 5
        na.vx += (pdx / pdist) * pf
        na.vy += (pdy / pdist) * pf
      }
    }

    for (let b = a + 1; b < outerIdx.length; b++) {
      const nb = nodes[outerIdx[b]!]!
      const dx = nb.x - na.x
      const dy = nb.y - na.y
      const d2 = dx * dx + dy * dy + 0.01
      const d = Math.sqrt(d2)
      const f = REPULSION / d2
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      na.vx -= fx
      na.vy -= fy
      nb.vx += fx
      nb.vy += fy
    }
  }

  // Keep a minimum stand-off from the hub so spokes have length.
  const MIN_R = w > 900 ? 120 : 90
  for (const i of outerIdx) {
    const n = nodes[i]!
    const dx = n.x - cx
    const dy = n.y - cy
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    if (d < MIN_R) {
      const f = (MIN_R - d) * 0.06
      n.vx += (dx / d) * f
      n.vy += (dy / d) * f
    }
  }

  for (const i of outerIdx) {
    const n = nodes[i]!
    n.vx *= DAMPING
    n.vy *= DAMPING
    n.x += n.vx
    n.y += n.vy
    if (n.x < BOUNDARY_PAD) n.vx += (BOUNDARY_PAD - n.x) * 0.12
    if (n.x > w - BOUNDARY_PAD) n.vx -= (n.x - (w - BOUNDARY_PAD)) * 0.12
    if (n.y < BOUNDARY_PAD) n.vy += (BOUNDARY_PAD - n.y) * 0.12
    if (n.y > h - BOUNDARY_PAD) n.vy -= (n.y - (h - BOUNDARY_PAD)) * 0.12
  }

  // Advance pulses toward the hub; on arrival spawn a ring and recycle.
  for (const p of pulses) {
    p.t += p.speed * dt
    if (p.t >= 1) {
      p.t -= 1 + Math.random() * 0.25 // restart with a little jitter
      rings.push({ r: 0, alpha: 0.5 })
    }
  }

  // Expand and fade hub rings (arrival "splash").
  for (const r of rings) {
    r.r += 60 * dt
    r.alpha -= 0.8 * dt
  }
  rings = rings.filter(r => r.alpha > 0)
}

function draw() {
  ctx.clearRect(0, 0, w, h)
  const CH = props.rgb
  if (!hub) return

  // Spokes — faint lines from each outer node to the hub.
  ctx.lineWidth = 1
  for (const i of outerIdx) {
    const n = nodes[i]!
    ctx.beginPath()
    ctx.moveTo(n.x, n.y)
    ctx.lineTo(hub.x, hub.y)
    ctx.strokeStyle = `rgba(${CH}, 0.08)`
    ctx.stroke()
  }

  // Hub rings (arrival pulses).
  for (const r of rings) {
    ctx.beginPath()
    ctx.arc(hub.x, hub.y, r.r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${CH}, ${Math.max(0, r.alpha)})`
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.lineWidth = 1

  // Pulses — bright dots with a short fading tail, travelling toward the hub.
  for (const p of pulses) {
    if (p.t < 0 || p.t > 1) continue
    const n = nodes[p.from]!
    const x = n.x + (hub.x - n.x) * p.t
    const y = n.y + (hub.y - n.y) * p.t
    const TAIL = 5
    for (let s = TAIL; s >= 1; s--) {
      const tt = Math.max(0, p.t - s * 0.03)
      const tx = n.x + (hub.x - n.x) * tt
      const ty = n.y + (hub.y - n.y) * tt
      ctx.beginPath()
      ctx.arc(tx, ty, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${CH}, ${0.05 + (0.10 * (TAIL - s)) / TAIL})`
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(x, y, 2.1, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${CH}, 0.95)`
    ctx.fill()
  }

  // Nodes — glow (pre-baked sprite) + core + label (hub is brightest).
  for (const n of nodes) {
    const t = TIERS[n.tier]
    const sprite = glowSprites?.[n.tier]
    if (sprite) ctx.drawImage(sprite, n.x - t.glow, n.y - t.glow)

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
  // dt in seconds, clamped so a background tab resuming doesn't jump the sim.
  const dt = tPrev ? Math.min(0.05, (now - tPrev) / 1000) : 0.016
  tPrev = now
  tick(dt)
  if (now - lastFrame < FRAME_MS) return
  lastFrame = now
  draw()
}

function start() {
  if (isRunning) return
  isRunning = true
  lastFrame = 0
  tPrev = 0
  animId = requestAnimationFrame(loop)
}

function stop() {
  cancelAnimationFrame(animId)
  isRunning = false
}

function sync() {
  if (!prefersReduced && !document.hidden && inView) start()
  else stop()
}

function onVisibility() {
  sync()
}

function onMotionChange(e: MediaQueryListEvent) {
  prefersReduced = e.matches
  sync()
  if (prefersReduced) draw()
}

onMounted(() => {
  if (!canvas.value) return
  const c = canvas.value.getContext('2d')
  if (!c) return
  ctx = c
  motionMql = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  prefersReduced = motionMql?.matches ?? false
  buildGlowSprites()
  init()
  draw()

  document.addEventListener('visibilitychange', onVisibility)
  motionMql?.addEventListener('change', onMotionChange)
  ro = new ResizeObserver(resize)
  ro.observe(canvas.value)

  io = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? true
    sync()
  }, { threshold: 0.01 })
  io.observe(canvas.value)

  sync()
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
