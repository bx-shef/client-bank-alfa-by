<script setup lang="ts">
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import {
  LANDING_DESCRIPTION,
  LANDING_HERO_NOTE,
  LANDING_PAIN_RESULT,
  LANDING_STEPS,
  LANDING_FEATURES,
  LANDING_INTEGRATORS,
  LANDING_FORMATS,
  LANDING_MARKET_URL
} from '~/utils/landing'
import { B24_BOOKING_URL } from '~/utils/booking'

definePageMeta({ layout: 'landing' })

useCardGlow()
const { reachGoal } = useMetrikaGoal()

const steps = LANDING_STEPS
const features = LANDING_FEATURES
// Банки и форматы — «tech-строка» под hero (как «Работает с моделями» на Lp).
const formats = LANDING_FORMATS
</script>

<template>
  <div>
    <!-- HERO -->
    <section
      id="hero"
      class="hero-fade-in relative overflow-hidden px-[22px] lg:px-8 pt-[80px] sm:pt-[120px] pb-[64px] sm:pb-[96px]"
    >
      <HeroGraph />
      <div class="relative z-10 max-w-[1080px] mx-auto">
        <div class="flex flex-col lg:flex-row lg:items-center gap-10 lg:gap-12">
          <!-- Фото — первое на мобильном, правая колонка на desktop -->
          <div class="shrink-0 flex justify-start lg:justify-end order-first lg:order-last">
            <img
              src="/igor.jpg"
              alt="Игорь Шевчик"
              width="240"
              height="240"
              class="size-44 sm:size-52 lg:size-60 rounded-full object-cover border-2 border-[rgb(var(--color-accent-primary-ch)/0.45)] shadow-[0_0_64px_rgba(0,212,255,0.20)]"
              loading="eager"
            >
          </div>

          <!-- Текст -->
          <div class="flex flex-col items-start gap-5 flex-1 lg:max-w-[620px]">
            <PartnerBadge />

            <h1 class="text-4xl sm:text-6xl lg:text-7xl font-bold leading-[1.05] tracking-tight text-white">
              Импорт выписки клиент-банка в <span class="text-[rgb(var(--color-accent-primary-ch))]">Bitrix24</span>
            </h1>

            <p class="text-lg sm:text-xl max-w-[560px] text-white/70 leading-relaxed">
              {{ LANDING_DESCRIPTION }}
            </p>

            <div class="flex flex-wrap items-center gap-3">
              <B24Button
                label="Оставить заявку на установку"
                href="#brief"
                :external="true"
                :no-rel="true"
                color="air-primary"
                size="xl"
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
                color="air-secondary-no-accent"
                size="xl"
                @click="reachGoal('booking_click')"
              />
              <B24Button
                label="Открыть в Маркете Bitrix24"
                :to="LANDING_MARKET_URL"
                target="_blank"
                color="air-tertiary-no-accent"
                size="xl"
                @click="reachGoal('market_click')"
              />
            </div>

            <p class="text-sm text-white/50">
              {{ LANDING_HERO_NOTE }}
            </p>
          </div>
        </div>

        <!-- Банки/форматы -->
        <div class="mt-12 sm:mt-16 flex flex-col items-start gap-3">
          <div class="text-xs uppercase tracking-[0.18em] text-white/40 font-mono">
            Банки и форматы
          </div>
          <div class="flex flex-wrap items-center justify-start gap-x-6 sm:gap-x-8 gap-y-2 text-white/60">
            <template
              v-for="(f, i) in formats"
              :key="f"
            >
              <span class="font-mono text-sm tracking-tight">{{ f }}</span>
              <span
                v-if="i < formats.length - 1"
                class="size-1 rounded-full bg-white/20"
              />
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- БОЛЬ → РЕЗУЛЬТАТ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto grid gap-5 md:grid-cols-2">
        <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-7">
          <div class="text-xs uppercase tracking-[0.14em] font-mono text-white/45 mb-3">
            Было
          </div>
          <p class="text-base sm:text-lg text-white/80 leading-relaxed">
            {{ LANDING_PAIN_RESULT.before }}
          </p>
        </div>
        <div
          data-glow-card
          class="rounded-2xl border border-[rgb(var(--color-accent-success-ch)/0.3)] bg-[rgb(var(--color-accent-success-ch)/0.05)] p-7"
        >
          <div class="text-xs uppercase tracking-[0.14em] font-mono text-[rgb(var(--color-accent-success-ch))] mb-3">
            Стало
          </div>
          <p class="text-base sm:text-lg text-white/90 leading-relaxed">
            {{ LANDING_PAIN_RESULT.after }}
          </p>
        </div>
      </div>
    </section>

    <!-- КАК ЭТО РАБОТАЕТ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-12 sm:mb-14">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Как это работает
          </h2>
          <p class="text-lg text-white/65">
            Три шага — от выписки банка до платежа в вашей CRM.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div
            v-for="s in steps"
            :key="s.step"
            data-glow-card
            class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 hover:border-white/25 transition-colors"
          >
            <div class="text-3xl font-bold font-mono text-[rgb(var(--color-accent-primary-ch))] mb-3 leading-none">
              {{ s.step }}
            </div>
            <div class="font-bold text-lg text-white mb-2">
              {{ s.title }}
            </div>
            <div class="text-sm text-white/60 leading-relaxed">
              {{ s.text }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ПОЧЕМУ МЫ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-12 sm:mb-14">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Почему мы
          </h2>
          <p class="text-lg text-white/65">
            Бесплатное приложение закрывает импорт. Установку в ваш контур и настройку под процессы берём на себя.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div
            v-for="feature in features"
            :key="feature.title"
            data-testid="feature-card"
            data-glow-card
            class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 hover:border-white/25 transition-colors"
          >
            <h3 class="text-xl font-bold text-white leading-tight mb-2">
              {{ feature.title }}
            </h3>
            <p class="text-sm sm:text-base text-white/65 leading-relaxed">
              {{ feature.description }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- ИНТЕГРАТОРАМ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--color-accent-partner-ch)/0.15)] to-[rgb(var(--color-accent-special-ch)/0.08)] p-8 sm:p-10">
          <h2 class="text-2xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Интеграторам Bitrix24
          </h2>
          <p class="text-base sm:text-lg text-white/75 max-w-3xl leading-relaxed">
            {{ LANDING_INTEGRATORS }}
          </p>
        </div>
      </div>
    </section>

    <!-- ФОРМА -->
    <section
      id="brief"
      class="px-[22px] lg:px-8 py-[56px] sm:py-[80px]"
    >
      <div class="max-w-[900px] mx-auto">
        <div class="rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--color-accent-partner-ch)/0.15)] to-[rgb(var(--color-accent-special-ch)/0.08)] py-8 sm:p-12">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3 px-8 sm:px-0">
            Оставить заявку на установку
          </h2>
          <p class="text-lg text-white/70 mb-8 px-8 sm:px-0">
            Ответим в течение рабочего дня.
          </p>
          <BriefForm />
        </div>
      </div>
    </section>

    <MobileBriefCta />
  </div>
</template>
