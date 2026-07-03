<script setup lang="ts">
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import ContactDetailsIcon from '@bitrix24/b24icons-vue/outline/ContactDetailsIcon'
import {
  LANDING_TITLE,
  LANDING_DESCRIPTION,
  LANDING_HERO_NOTE,
  LANDING_PAIN_RESULT,
  LANDING_STEPS,
  LANDING_FEATURES,
  LANDING_INTEGRATORS
} from '~/utils/landing'
import { B24_BOOKING_URL } from '~/utils/booking'

const { reachGoal } = useMetrikaGoal()

const steps = LANDING_STEPS
const features = LANDING_FEATURES

const cardOpen = ref(false)
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-(--ui-container) flex-col px-6 py-16">
    <!-- HERO -->
    <section class="flex flex-col items-center pt-8 text-center sm:pt-16">
      <h1 class="max-w-3xl text-3xl font-semibold sm:text-5xl">
        {{ LANDING_TITLE }}
      </h1>
      <p class="mt-5 max-w-2xl text-base text-(--b24ui-color-text-secondary) sm:text-lg">
        {{ LANDING_DESCRIPTION }}
      </p>

      <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
        <B24Button
          label="Оставить заявку на установку"
          href="#brief"
          size="lg"
          color="air-primary"
          @click="reachGoal('cta_hero')"
        >
          <template #trailing>
            <ArrowRightLIcon class="size-5" />
          </template>
        </B24Button>
        <B24Button
          label="Назначить созвон"
          :to="B24_BOOKING_URL"
          target="_blank"
          size="lg"
          color="air-secondary-no-accent"
          @click="reachGoal('booking_click')"
        />
      </div>
      <p class="mt-4 text-sm text-(--b24ui-color-text-secondary) opacity-80">
        {{ LANDING_HERO_NOTE }}
      </p>
    </section>

    <!-- БОЛЬ → РЕЗУЛЬТАТ -->
    <section class="mt-24 grid gap-5 sm:grid-cols-2">
      <div class="rounded-2xl border border-(--b24ui-color-design-tinted-na-stroke) p-7">
        <div class="text-xs font-medium uppercase tracking-wider text-(--b24ui-color-text-secondary)">
          Было
        </div>
        <p class="mt-3 text-base sm:text-lg">
          {{ LANDING_PAIN_RESULT.before }}
        </p>
      </div>
      <div class="rounded-2xl border border-(--b24ui-color-accent-main-primary) bg-(--b24ui-color-bg-content-secondary) p-7">
        <div class="text-xs font-medium uppercase tracking-wider text-(--b24ui-color-accent-main-primary)">
          Стало
        </div>
        <p class="mt-3 text-base sm:text-lg">
          {{ LANDING_PAIN_RESULT.after }}
        </p>
      </div>
    </section>

    <!-- КАК ЭТО РАБОТАЕТ -->
    <section class="mt-24">
      <h2 class="text-2xl font-semibold sm:text-3xl">
        Как это работает
      </h2>
      <ol class="mt-8 grid gap-5 sm:grid-cols-3">
        <li
          v-for="s in steps"
          :key="s.step"
          class="rounded-2xl border border-(--b24ui-color-design-tinted-na-stroke) p-6"
        >
          <div class="font-mono text-2xl font-semibold text-(--b24ui-color-accent-main-primary)">
            {{ s.step }}
          </div>
          <h3 class="mt-3 text-lg font-medium">
            {{ s.title }}
          </h3>
          <p class="mt-2 text-sm text-(--b24ui-color-text-secondary)">
            {{ s.text }}
          </p>
        </li>
      </ol>
    </section>

    <!-- ПОЧЕМУ МЫ -->
    <section class="mt-24">
      <h2 class="text-2xl font-semibold sm:text-3xl">
        Почему мы
      </h2>
      <ul class="mt-8 grid gap-5 sm:grid-cols-2">
        <li
          v-for="feature in features"
          :key="feature.title"
          data-testid="feature-card"
          class="rounded-2xl border border-(--b24ui-color-design-tinted-na-stroke) p-6"
        >
          <h3 class="text-lg font-medium">
            {{ feature.title }}
          </h3>
          <p class="mt-2 text-sm text-(--b24ui-color-text-secondary)">
            {{ feature.description }}
          </p>
        </li>
      </ul>
    </section>

    <!-- ИНТЕГРАТОРАМ -->
    <section class="mt-24">
      <div class="rounded-3xl border border-(--b24ui-color-design-tinted-na-stroke) bg-(--b24ui-color-bg-content-secondary) p-8 sm:p-10">
        <h2 class="text-2xl font-semibold sm:text-3xl">
          Интеграторам Bitrix24
        </h2>
        <p class="mt-4 max-w-3xl text-base text-(--b24ui-color-text-secondary) sm:text-lg">
          {{ LANDING_INTEGRATORS }}
        </p>
      </div>
    </section>

    <!-- ФОРМА ЗАЯВКИ -->
    <section
      id="brief"
      class="mt-24 scroll-mt-8"
    >
      <div class="mx-auto max-w-3xl">
        <h2 class="text-center text-2xl font-semibold sm:text-3xl">
          Оставить заявку на установку
        </h2>
        <p class="mt-3 text-center text-base text-(--b24ui-color-text-secondary)">
          Ответим в течение рабочего дня.
        </p>
        <div class="mt-8">
          <BriefForm />
        </div>
      </div>
    </section>

    <!-- ВИЗИТКА -->
    <div class="mt-16 flex justify-center">
      <B24Button
        label="Визитка"
        :icon="ContactDetailsIcon"
        color="air-tertiary-no-accent"
        @click="cardOpen = true"
      />
    </div>

    <BuildFooter />

    <BusinessCardModal
      :open="cardOpen"
      @close="cardOpen = false"
    />
  </main>
</template>
