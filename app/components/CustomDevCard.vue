<script setup lang="ts">
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import { useMetrikaGoal } from '~/composables/useMetrikaGoal'

// «Нужна доработка под ваш процесс?» — premium b24ui copilot card offering custom
// Bitrix24 development (ИП Шевчик, partner). Self-contained/portable: the copy and
// the ИП Шевчик URLs are the same across the ecosystem, so they're baked in;
// only the Metrika goal names are props (a repo may track its own). Uses the
// shared <HoldRevealQr> for the mobile QR (→ the site, no #hash). `relative
// overflow-hidden` on the card lets the QR overlay fill it.
withDefaults(defineProps<{
  /** Metrika goal fired on CTA click (default `custom_dev_click`). Override only
   *  if a repo tracks the custom-dev CTA under a different goal name. */
  clickGoal?: string
  /** Metrika goal fired once when the mobile QR is revealed (default `custom_dev_qr_reveal`). */
  qrRevealGoal?: string
}>(), {
  clickGoal: 'custom_dev_click',
  qrRevealGoal: 'custom_dev_qr_reveal'
})

const { reachGoal } = useMetrikaGoal()

// ИП Шевчик partner site — CTA scrolls to the brief (#brief); the QR points at the
// bare site (a QR to an anchor is pointless).
const BRIEF_URL = 'https://offer.bx-shef.by/#brief'
const SITE_URL = 'https://offer.bx-shef.by/'
</script>

<template>
  <B24Card
    variant="filled-copilot"
    :b24ui="{
      root: 'relative overflow-hidden edge-dark rounded-2xl bg-[radial-gradient(110.42%_110.42%_at_-10.42%_31.25%,var(--ui-color-copilot-bg-content-3)_0%,var(--ui-color-copilot-bg-content-2)_58.65%,var(--ui-color-copilot-bg-content-1)_100%)]',
      header: 'p-5 sm:p-6',
      body: 'px-5 sm:px-6',
      footer: 'p-5 sm:p-6'
    }"
  >
    <template #header>
      <div class="flex flex-col gap-1.5">
        <span class="text-[11px] font-medium uppercase tracking-wide opacity-70">
          ИП Шевчик · Партнёр Bitrix24
        </span>
        <div class="text-(length:--ui-font-size-2xl)/[normal] font-(--ui-font-weight-semi-bold)">
          Нужна доработка под ваш процесс?
        </div>
      </div>
    </template>

    <p class="text-(length:--ui-font-size-md)/[1.5] opacity-90">
      Дорабатываем приложения и автоматизируем Bitrix24 под вашу задачу — от небольших
      правок до интеграций с банками и 1С.
    </p>

    <template #footer>
      <div class="flex flex-col gap-4">
        <B24Button
          label="Обсудить доработку"
          :to="BRIEF_URL"
          target="_blank"
          rel="noopener noreferrer"
          color="air-boost"
          size="md"
          @click="reachGoal(clickGoal)"
        >
          <template #trailing>
            <ArrowRightLIcon class="size-4" />
          </template>
        </B24Button>

        <HoldRevealQr
          :url="SITE_URL"
          :goal="qrRevealGoal"
          caption="offer.bx-shef.by"
          hint="QR сайта"
          dark
        />
      </div>
    </template>
  </B24Card>
</template>
