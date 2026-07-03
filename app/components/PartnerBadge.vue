<script setup lang="ts">
// Партнёрский бейдж под dark vibecode-стилистику.
// Брендбук обязывает партнёров ставить логотип «Партнёр Битрикс24»
// вверху на заметном месте. Текстовая версия здесь — для production
// замените на официальный SVG из партнёрского кабинета.
</script>

<template>
  <a
    href="https://www.bitrix24.by/partners/"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border transition"
    :class="[
      'border-[rgb(var(--color-accent-partner-ch)/0.6)]',
      'bg-[rgb(var(--color-accent-partner-ch)/0.12)]',
      'hover:bg-[rgb(var(--color-accent-partner-ch)/0.2)]'
    ]"
    aria-label="Партнёр Битрикс24"
  >
    <span class="text-[rgb(var(--color-accent-primary-ch))] font-bold text-[14px] leading-none">Битрикс24</span>
    <span class="text-[10px] uppercase tracking-[0.14em] font-semibold text-[rgb(var(--color-base-0-ch)/0.7)]">Партнёр</span>
  </a>
</template>
