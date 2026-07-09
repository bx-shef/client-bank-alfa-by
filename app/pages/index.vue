<script setup lang="ts">
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import {
  LANDING_DESCRIPTION,
  LANDING_HERO_NOTE,
  LANDING_PAIN_RESULT,
  LANDING_STEPS,
  LANDING_FEATURES,
  LANDING_INTEGRATORS,
  LANDING_DEMO,
  LANDING_BANK_CONNECT,
  LANDING_FORMATS,
  LANDING_MARKET_URL,
  LANDING_MARKET_PROMO
} from '~/utils/landing'
import { B24_BOOKING_URL } from '~/utils/booking'

definePageMeta({ layout: 'landing' })

useCardGlow()
const { reachGoal } = useMetrikaGoal()

const steps = LANDING_STEPS
const features = LANDING_FEATURES
// Банки и форматы — «tech-строка» под hero (как «Работает с моделями» на Lp).
const formats = LANDING_FORMATS

// Bank online-connection info cards (demo section). Accent → literal Tailwind class
// strings (kept literal so the content scanner picks them up); one per BankConnect.
const bankConnect = LANDING_BANK_CONNECT
const BANK_ACCENT: Record<'cyan' | 'green', { card: string, pill: string, name: string }> = {
  cyan: {
    card: 'border-[rgb(var(--color-accent-primary-ch)/0.35)] bg-gradient-to-br from-[rgb(var(--color-accent-primary-ch)/0.16)] to-transparent',
    pill: 'text-[rgb(var(--color-accent-primary-ch))] bg-[rgb(var(--color-accent-primary-ch)/0.14)] border border-[rgb(var(--color-accent-primary-ch)/0.35)]',
    name: 'text-[rgb(var(--color-accent-primary-ch))]'
  },
  green: {
    card: 'border-[rgb(var(--color-accent-success-ch)/0.35)] bg-gradient-to-br from-[rgb(var(--color-accent-success-ch)/0.16)] to-transparent',
    pill: 'text-[rgb(var(--color-accent-success-ch))] bg-[rgb(var(--color-accent-success-ch)/0.14)] border border-[rgb(var(--color-accent-success-ch)/0.35)]',
    name: 'text-[rgb(var(--color-accent-success-ch))]'
  }
}
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
                label="Попробовать демо"
                href="#demo"
                :external="true"
                :no-rel="true"
                color="air-secondary-no-accent"
                size="xl"
                @click="reachGoal('demo_open')"
              />
              <B24Button
                label="Назначить созвон"
                :to="B24_BOOKING_URL"
                target="_blank"
                color="air-tertiary-no-accent"
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

    <!-- ДЕМО: попробуйте на своей выписке -->
    <section
      id="demo"
      class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]"
    >
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-12 sm:mb-14">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            {{ LANDING_DEMO.title }}
          </h2>
          <p class="text-lg text-white/65">
            {{ LANDING_DEMO.subtitle }}
          </p>
        </div>
        <!-- Онлайн-подключение к банкам — яркие инфо-блоки (вместо интерактивных песочниц). -->
        <div class="grid gap-4 sm:grid-cols-2 mb-6">
          <div
            v-for="bank in bankConnect"
            :key="bank.name"
            data-glow-card
            data-testid="bank-connect"
            class="relative overflow-hidden rounded-2xl border p-6 sm:p-7 transition-colors"
            :class="BANK_ACCENT[bank.accent].card"
          >
            <span
              class="inline-block rounded-full px-3 py-1 text-xs font-mono font-medium mb-4"
              :class="BANK_ACCENT[bank.accent].pill"
            >{{ bank.tag }}</span>
            <h3
              class="text-2xl sm:text-3xl font-bold leading-tight mb-2"
              :class="BANK_ACCENT[bank.accent].name"
            >
              {{ bank.name }}
            </h3>
            <p class="text-sm sm:text-base text-white/70 leading-relaxed">
              {{ bank.text }}
            </p>
          </div>
        </div>

        <LandingDemo />
        <p class="mt-4 text-sm text-white/45">
          {{ LANDING_DEMO.note }}
        </p>

        <!-- Обязательный посыл про кастом-доработку под клиента (на его сервере). -->
        <div
          data-glow-card
          class="mt-6 rounded-2xl border border-[rgb(var(--color-accent-primary-ch)/0.25)] bg-[rgb(var(--color-accent-primary-ch)/0.05)] p-6 sm:p-7 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6"
        >
          <p class="text-base sm:text-lg text-white/85 leading-relaxed flex-1">
            {{ LANDING_DEMO.customDev }}
          </p>
          <B24Button
            :label="LANDING_DEMO.customDevCta"
            href="#brief"
            :external="true"
            :no-rel="true"
            color="air-primary"
            size="lg"
            class="shrink-0"
            @click="reachGoal('demo_custom_dev')"
          />
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

    <!-- ПРИЛОЖЕНИЕ В МАРКЕТЕ — бесплатная точка входа (self-install): ссылка на
         листинг Маркета + мобильный QR. Вторичный путь: CTA намеренно ослаблен до
         `air-secondary-no-accent`, чтобы не конкурировать по весу с платным
         primary «Оставить заявку» (стратегия «платный-first»; так же ослаблена
         дублирующая ссылка на Маркет в hero). Тексты — LANDING_MARKET_PROMO
         (docs/POSITIONING.md). -->
    <section class="px-[22px] lg:px-8 pt-[8px] pb-[56px] sm:pb-[72px]">
      <div class="max-w-[600px] mx-auto">
        <AppInBitrixCard
          :eyebrow="LANDING_MARKET_PROMO.eyebrow"
          :title="LANDING_MARKET_PROMO.title"
          :text="LANDING_MARKET_PROMO.text"
          :cta-label="LANDING_MARKET_PROMO.cta"
          :url="LANDING_MARKET_URL"
          cta-color="air-secondary-no-accent"
          click-goal="market_card_click"
        />
      </div>
    </section>

    <!-- ИНТЕГРАТОРАМ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--color-accent-partner-ch)/0.15)] to-[rgb(var(--color-accent-special-ch)/0.08)] p-8 sm:p-10">
          <h2 class="text-2xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Интеграторам Bitrix24
          </h2>
          <p class="text-base sm:text-lg text-white/75 max-w-3xl leading-relaxed mb-6">
            {{ LANDING_INTEGRATORS }}
          </p>
          <B24Button
            label="Условия для партнёров"
            to="/partners"
            color="air-secondary-no-accent"
            size="lg"
            @click="reachGoal('partners_open')"
          >
            <template #trailing>
              <ArrowRightLIcon class="size-5" />
            </template>
          </B24Button>
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
