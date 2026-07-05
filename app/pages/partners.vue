<script setup lang="ts">
import ArrowRightLIcon from '@bitrix24/b24icons-vue/outline/ArrowRightLIcon'
import {
  PARTNERS_TITLE,
  PARTNERS_DESCRIPTION,
  PARTNERS_MODEL,
  PARTNERS_LADDER,
  PARTNERS_SPLIT,
  PARTNERS_LIMITS,
  PARTNERS_BRIEF
} from '~/utils/partners'
import { pageTitle } from '~/utils/landing'
import { B24_BOOKING_URL } from '~/utils/booking'

definePageMeta({ layout: 'landing' })

useCardGlow()
const { reachGoal } = useMetrikaGoal()

// Page-specific SEO/social so shares of /partners don't fall back to the
// home-page title/description supplied by app.vue.
useSeoMeta({
  title: pageTitle(PARTNERS_TITLE),
  description: PARTNERS_DESCRIPTION,
  ogTitle: pageTitle(PARTNERS_TITLE),
  ogDescription: PARTNERS_DESCRIPTION,
  twitterTitle: pageTitle(PARTNERS_TITLE),
  twitterDescription: PARTNERS_DESCRIPTION
})

const ladder = PARTNERS_LADDER
const model = PARTNERS_MODEL
</script>

<template>
  <div>
    <!-- HERO -->
    <section
      id="hero"
      class="hero-fade-in relative overflow-hidden px-[22px] lg:px-8 pt-[80px] sm:pt-[120px] pb-[48px] sm:pb-[64px]"
    >
      <div class="relative z-10 max-w-[1080px] mx-auto flex flex-col items-start gap-5">
        <div class="text-xs uppercase tracking-[0.18em] text-white/40 font-mono">
          Партнёрам
        </div>
        <h1 class="text-4xl sm:text-6xl lg:text-7xl font-bold leading-[1.05] tracking-tight text-white">
          Интеграторам <span class="text-[rgb(var(--color-accent-primary-ch))]">Bitrix24</span>
        </h1>
        <p class="text-lg sm:text-xl max-w-[640px] text-white/70 leading-relaxed">
          {{ PARTNERS_DESCRIPTION }}
        </p>

        <div class="flex flex-wrap items-center gap-3">
          <B24Button
            label="Обсудить сотрудничество"
            href="#partner-brief"
            :external="true"
            :no-rel="true"
            color="air-primary"
            size="xl"
            @click="reachGoal('partner_cta')"
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
            @click="reachGoal('partner_booking')"
          />
        </div>

        <div class="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-white/60">
          <template
            v-for="(m, i) in model"
            :key="m"
          >
            <span class="font-mono text-sm tracking-tight">{{ m }}</span>
            <span
              v-if="i < model.length - 1"
              class="size-1 rounded-full bg-white/20"
            />
          </template>
        </div>
      </div>
    </section>

    <!-- ЛЕСТНИЦА ПРОДАЖ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-10 sm:mb-12">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Что можно продать клиенту
          </h2>
          <p class="text-lg text-white/65">
            Партнёр продаёт весь пакет от своего имени; платную часть выполняем мы.
          </p>
        </div>

        <div class="overflow-x-auto rounded-2xl border border-white/10">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="text-xs uppercase tracking-[0.1em] font-mono text-white/45">
                <th class="p-4 font-medium">
                  Уровень
                </th>
                <th class="p-4 font-medium">
                  Что получает клиент
                </th>
                <th class="p-4 font-medium">
                  Кто делает
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in ladder"
                :key="row.level"
                class="border-t border-white/10 align-top"
              >
                <td class="p-4 font-bold text-white whitespace-nowrap">
                  {{ row.level }}
                </td>
                <td class="p-4 text-sm text-white/70">
                  {{ row.client }}
                </td>
                <td class="p-4 whitespace-nowrap">
                  <span
                    class="inline-block text-xs font-bold px-2.5 py-1 rounded-md"
                    :class="row.paid === 'free'
                      ? 'bg-white/10 text-white/60'
                      : 'bg-[rgb(var(--color-accent-partner-ch)/0.25)] text-white/90'"
                  >{{ row.who }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- РАЗДЕЛЕНИЕ РАБОТ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-10 sm:mb-12">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Кто что делает
          </h2>
          <p class="text-lg text-white/65">
            Всё глубже базовой настройки Marketplace-версии — на нас.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div
            data-glow-card
            class="rounded-2xl border border-white/10 bg-white/[0.03] p-6"
          >
            <h3 class="text-xl font-bold text-white mb-3">
              Партнёр — сам
            </h3>
            <ul class="flex flex-col gap-2">
              <li
                v-for="item in PARTNERS_SPLIT.partner"
                :key="item"
                class="text-sm sm:text-base text-white/65 leading-relaxed pl-4 relative"
              >
                <span
                  aria-hidden="true"
                  class="absolute left-0 text-white/30"
                >·</span>{{ item }}
              </li>
            </ul>
          </div>
          <div
            data-glow-card
            class="rounded-2xl border border-[rgb(var(--color-accent-partner-ch)/0.3)] bg-[rgb(var(--color-accent-partner-ch)/0.06)] p-6"
          >
            <h3 class="text-xl font-bold text-white mb-3">
              Мы — субподряд
            </h3>
            <ul class="flex flex-col gap-2">
              <li
                v-for="item in PARTNERS_SPLIT.us"
                :key="item"
                class="text-sm sm:text-base text-white/75 leading-relaxed pl-4 relative"
              >
                <span
                  aria-hidden="true"
                  class="absolute left-0 text-[rgb(var(--color-accent-partner-ch))]"
                >·</span>{{ item }}
              </li>
            </ul>
          </div>
        </div>

        <!-- Границы обещаний -->
        <div class="mt-5 rounded-2xl border-l-2 border-[rgb(var(--color-accent-warning-ch))] bg-[rgb(var(--color-accent-warning-ch)/0.06)] p-6">
          <div class="text-xs uppercase tracking-[0.14em] font-mono text-[rgb(var(--color-accent-warning-ch))] mb-2">
            Границы обещаний
          </div>
          <p class="text-base text-white/80 leading-relaxed">
            {{ PARTNERS_LIMITS }}
          </p>
        </div>
      </div>
    </section>

    <!-- МИНИ-БРИФ -->
    <section class="px-[22px] lg:px-8 py-[56px] sm:py-[72px]">
      <div class="max-w-[1080px] mx-auto">
        <div class="max-w-[720px] mb-10 sm:mb-12">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Что нужно, чтобы передать проект
          </h2>
          <p class="text-lg text-white/65">
            Короткий бриф на клиента — и мы подхватываем платную часть.
          </p>
        </div>
        <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
          <ul class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            <li
              v-for="item in PARTNERS_BRIEF"
              :key="item"
              class="text-sm sm:text-base text-white/70 leading-relaxed pl-4 relative"
            >
              <span
                aria-hidden="true"
                class="absolute left-0 text-[rgb(var(--color-accent-primary-ch))]"
              >·</span>{{ item }}
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ФОРМА -->
    <section
      id="partner-brief"
      class="px-[22px] lg:px-8 py-[56px] sm:py-[80px]"
    >
      <div class="max-w-[900px] mx-auto">
        <div class="rounded-3xl border border-white/10 bg-gradient-to-br from-[rgb(var(--color-accent-partner-ch)/0.15)] to-[rgb(var(--color-accent-special-ch)/0.08)] py-8 sm:p-12">
          <h2 class="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3 px-8 sm:px-0">
            Обсудить сотрудничество
          </h2>
          <p class="text-lg text-white/70 mb-8 px-8 sm:px-0">
            Оставьте заявку — расскажем про условия субподряда и ответим в течение рабочего дня.
          </p>
          <BriefForm />
        </div>
      </div>
    </section>

    <MobileBriefCta
      brief-id="partner-brief"
      label="Обсудить сотрудничество"
      goal="partner_sticky_cta"
    />
  </div>
</template>
