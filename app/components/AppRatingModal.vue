<script setup lang="ts">
import { watch } from 'vue'
import LikeIcon from '@bitrix24/b24icons-vue/main/LikeIcon'
import { useAppRating } from '~/composables/useAppRating'

// Reusable in-portal «оцените приложение» modal. Drop it on any in-portal page and drive it with a
// `trigger` that flips true at a moment the user has clearly seen the app's value (e.g. after a
// successful statement import). The SHOW decision, throttle and manual-verification logic all live
// server-side (portal_app_rating) — this component only reacts to it. See docs/APP_RATING.md.
//
// Flow: trigger → check() (GET /api/app-rating) → if show, render + stamp prompted_at (throttles the
// next prompt for RATING_REPROMPT_DAYS) → «Оценить» opens the Market detail page (stamps opened_at)
// or «Не сейчас» hides it. Inert outside a portal / when b24MarketCode is unset.
const props = defineProps<{
  /** Flip to true once the user has clearly benefited (a completed import). Triggers the check. */
  trigger?: boolean
}>()

const { show, check, markPrompted, openMarket, dismiss } = useAppRating()

// When the trigger becomes true, ask the server whether to prompt (once — check() self-guards).
watch(
  () => props.trigger,
  (on) => {
    if (on) void check()
  },
  { immediate: true }
)

// The moment the modal actually shows, stamp prompted_at so it won't reappear for the interval —
// even if the user just closes it. (markPrompted is fire-and-forget.)
watch(show, (isOpen) => {
  if (isOpen) markPrompted()
})

// B24Modal is controllable via v-model:open; closing via overlay/escape/close-button routes here.
function onOpenChange(open: boolean): void {
  if (!open) dismiss()
}
</script>

<template>
  <B24Modal
    :open="show"
    title="Нравится приложение?"
    description="Оцените нас в Маркете — это помогает развивать продукт и занимает минуту."
    :unmount-on-hide="true"
    @update:open="onOpenChange"
  >
    <template #body>
      <div class="flex flex-col items-center gap-4 text-center">
        <!-- Короткая подсказка, как именно выставляется оценка в интерфейсе Маркета.
             Ленивая загрузка: картинка тянется только при первом открытии (unmount-on-hide). -->
        <img
          src="/app-rating-demo.gif"
          alt="Как поставить оценку приложению в Маркете Bitrix24"
          width="320"
          height="204"
          loading="lazy"
          decoding="async"
          class="h-auto w-full max-w-[320px] rounded-lg border border-(--ui-color-base-5)"
        >
        <p class="text-sm text-(--ui-color-base-3)">
          Честная оценка (даже критичная) очень помогает нам. Спасибо!
        </p>
      </div>
    </template>

    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <B24Button
          label="Не сейчас"
          color="air-tertiary-no-accent"
          @click="close"
        />
        <B24Button
          :icon="LikeIcon"
          label="Оценить"
          color="air-primary"
          @click="openMarket"
        />
      </div>
    </template>
  </B24Modal>
</template>
