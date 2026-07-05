<script setup lang="ts">
import Bitrix24Icon from '@bitrix24/b24icons-vue/common-service/Bitrix24Icon'
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// «app in Bitrix24» promo card (light/dark-auto cyan card). Content is per-app —
// each Marketplace listing has its own copy — so it comes via props. On mobile it
// carries the shared <HoldRevealQr> (fingerprint → QR of the listing). Portable:
// no dependency on repo-specific config; drop it into any bx-shef landing.
withDefaults(defineProps<{
  eyebrow: string
  title: string
  text: string
  ctaLabel: string
  /** Marketplace listing URL — CTA target and QR content. */
  url: string
  /** Label under the QR (default «Маркет Bitrix24»). */
  qrCaption?: string
  /** Hint noun after «Удерживайте — » (default «QR Маркета»). */
  qrHint?: string
  clickGoal?: string
  qrRevealGoal?: string
}>(), {
  qrCaption: 'Маркет Bitrix24',
  qrHint: 'QR Маркета',
  clickGoal: 'market_click',
  qrRevealGoal: 'market_qr_reveal'
})

const { reachGoal } = useMetrikaGoal()
</script>

<template>
  <div class="relative overflow-hidden rounded-2xl border border-cyan-400/40 bg-cyan-400/[0.04] p-5 dark:bg-cyan-400/[0.06] sm:p-6">
    <div class="mb-3 flex items-center gap-2">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-600 dark:text-cyan-300">
        <Bitrix24Icon class="size-5" />
      </span>
      <span class="text-[11px] font-medium uppercase tracking-wide text-cyan-700/80 dark:text-cyan-300/80">
        {{ eyebrow }}
      </span>
    </div>
    <h2 class="mb-1.5 text-lg font-semibold text-gray-900 dark:text-white">
      {{ title }}
    </h2>
    <p class="mb-4 text-sm leading-relaxed text-gray-600 dark:text-white/65">
      {{ text }}
    </p>
    <B24Button
      :label="ctaLabel"
      :to="url"
      target="_blank"
      rel="noopener noreferrer"
      color="air-primary"
      size="md"
      @click="reachGoal(clickGoal)"
    >
      <template #trailing>
        <ArrowRightLIcon class="size-4" />
      </template>
    </B24Button>

    <div class="mt-4">
      <HoldRevealQr
        :url="url"
        :goal="qrRevealGoal"
        :caption="qrCaption"
        :hint="qrHint"
      />
    </div>
  </div>
</template>
