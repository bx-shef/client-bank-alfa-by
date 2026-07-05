<script setup lang="ts">
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// Mobile hold-to-reveal QR (the bx-shef «fingerprint» pattern). Drop it inside a
// card that is `relative overflow-hidden`; while the fingerprint button is held,
// an overlay fills that card with a QR of `url`. Desktop never sees it
// (sm:hidden) and never loads `qrcode`. Reusable across the ecosystem — accent
// is the brand token `--color-accent-primary-ch`; `dark` tunes the overlay for
// an always-dark card (vs a light/dark-auto one).
//
// Overlay scoping: the overlay is `absolute inset-0`, so it fills the NEAREST
// POSITIONED ancestor. Make the card you want covered `relative overflow-hidden`
// and do NOT wrap this component in another `relative` element, or the overlay
// collapses onto that wrapper instead of the card.
const props = withDefaults(defineProps<{
  /** QR target URL (treated as static — changing it regenerates the QR). */
  url: string
  /** Metrika goal fired once on first reveal (optional). */
  goal?: string
  /** Small label under the QR (e.g. the domain); omit to hide it. */
  caption?: string
  /** Short noun after «Удерживайте — » and in the aria-label, e.g. «QR сайта». */
  hint?: string
  /** True when the enclosing card is always dark (skip the light-theme styling). */
  dark?: boolean
  /** Trigger layout: 'row' (hint left, button right — the promo cards) or
   *  'stack' (button on top, hint centered below — the business-card modal). */
  orientation?: 'row' | 'stack'
}>(), { goal: '', caption: '', hint: 'QR', dark: false, orientation: 'row' })

const { reachGoal } = useMetrikaGoal()

const qrUrl = ref('')
const showQr = ref(false)
let revealed = false

// `qrcode` is dynamically imported and the QR generated LAZILY — only on the
// first hold — so the (~15-25KB gzipped) chunk never loads for the majority who
// never open the QR, in any context (standalone or the B24 portal). Idempotent.
async function ensureQr() {
  if (qrUrl.value) return
  try {
    const QRCode = (await import('qrcode')).default
    qrUrl.value = await QRCode.toDataURL(props.url, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a1220', light: '#ffffff' }
    })
  } catch {
    // QR stays '' → the user sees a skeleton; non-critical.
  }
}

// Drop the cached QR if the URL changes (reusable-component hygiene; current
// callers pass a static url, but don't silently keep a stale QR).
watch(() => props.url, () => {
  qrUrl.value = ''
})

// Hold-to-reveal: pointer capture keeps the event on the button even if the
// finger drifts, so release reliably hides the QR again.
function startQr(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  showQr.value = true
  ensureQr()
  if (!revealed && props.goal) {
    revealed = true
    reachGoal(props.goal)
  }
}

function stopQr() {
  showQr.value = false
}
</script>

<template>
  <!-- Overlay fills the enclosing card (which MUST be `relative overflow-hidden`).
       Mobile only — on desktop the card's own CTA is the action. -->
  <div
    v-if="showQr"
    class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 sm:hidden"
    :class="dark ? 'bg-[#0a1220]/95' : 'bg-white/95 dark:bg-[#0a1220]/95'"
  >
    <div
      class="font-mono text-[10px] uppercase tracking-[0.18em]"
      :class="dark ? 'text-white/45' : 'text-gray-500 dark:text-white/45'"
    >
      Сканируйте
    </div>
    <div class="rounded-2xl bg-white p-3 shadow-lg">
      <img
        v-if="qrUrl"
        :src="qrUrl"
        :alt="caption ? `QR-код: ${caption}` : 'QR-код'"
        class="block size-[180px]"
      >
      <div
        v-else
        class="size-[180px] animate-pulse rounded bg-black/5"
      />
    </div>
    <div
      v-if="caption"
      class="font-mono text-xs"
      :class="dark ? 'text-white/55' : 'text-gray-500 dark:text-white/55'"
    >
      {{ caption }}
    </div>
  </div>

  <!-- Trigger. 'row': hint left, button right (right-thumb zone). 'stack':
       button on top, hint centered below (flex-col-reverse keeps DOM order). -->
  <div
    class="relative z-30 flex sm:hidden"
    :class="orientation === 'stack'
      ? 'flex-col-reverse items-center gap-2'
      : 'items-center justify-between gap-3'"
  >
    <span
      class="font-mono text-[11px]"
      :class="[
        dark ? 'text-white/50' : 'text-gray-500 dark:text-white/50',
        orientation === 'stack' ? 'text-center' : ''
      ]"
    >
      {{ showQr ? 'Отпустите' : `Удерживайте — ${hint}` }}
    </span>
    <button
      type="button"
      class="flex size-16 shrink-0 touch-none select-none items-center justify-center rounded-full border transition-all duration-200 active:scale-95"
      :class="dark
        ? (showQr
          ? 'border-[rgb(var(--color-accent-primary-ch)/0.6)] bg-[rgb(var(--color-accent-primary-ch)/0.2)] text-[rgb(var(--color-accent-primary-ch))] shadow-[0_0_24px_rgb(var(--color-accent-primary-ch)/0.35)]'
          : 'border-[rgb(var(--color-accent-primary-ch)/0.3)] bg-[rgb(var(--color-accent-primary-ch)/0.1)] text-[rgb(var(--color-accent-primary-ch))]')
        : (showQr
          ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-600 shadow-[0_0_24px_rgba(34,211,238,0.35)] dark:text-cyan-300'
          : 'border-cyan-400/40 bg-cyan-400/10 text-cyan-600 dark:text-cyan-300')"
      :aria-label="`Показать ${hint} — удерживайте`"
      @pointerdown.prevent="startQr"
      @pointerup="stopQr"
      @pointercancel="stopQr"
      @contextmenu.prevent
    >
      <!-- Fingerprint (inline SVG — not in every b24icons version). -->
      <svg
        class="size-8"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4" />
        <path d="M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2" />
        <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
        <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
        <path d="M8.65 22c.21-.66.45-1.32.57-2" />
        <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
        <path d="M2 16h.01" />
        <path d="M21.8 16c.2-2 .131-5.354 0-6" />
        <path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2" />
      </svg>
    </button>
  </div>
</template>
