<script setup lang="ts">
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_WIDTH, helpSliderPlace } from '~/config/b24'

// Контекстная ссылка в справку (#576 п.2): «Что это значит?» рядом с тем местом, где человек
// застрял.
//
// ⚠ Открывается НАСТОЯЩИМ слайдером портала, а не новой вкладкой: настройки уже открыты слайдером,
// и уводить из них человека в браузер значит потерять несохранённую форму. Слайдер ложится поверх и
// закрывается крестиком портала — работа остаётся на месте.
//
// ⚠ Фолбэк обычной навигацией обязателен: вне портала слайдера нет, а внутри портал может отказать
// во ВЛОЖЕННОМ слайдере (справку зовут из уже открытого). Без него кнопка молча ничего не делала бы
// — ровно тот отказ, который снаружи неотличим от поломки.
const props = withDefaults(defineProps<{
  /** Якорь раздела справки (`FaqEntry.id`). */
  anchor: string
  label?: string
}>(), { label: 'Что это значит?' })

const { openAppSlider } = useB24()

async function open(): Promise<void> {
  const opened = await openAppSlider(helpSliderPlace(props.anchor), {
    width: APP_SLIDER_WIDTH,
    title: 'Справка'
  })
  if (!opened) await navigateTo({ path: '/help', hash: `#${props.anchor}` })
}
</script>

<template>
  <button
    type="button"
    data-testid="help-link"
    :data-anchor="anchor"
    class="text-sm underline underline-offset-2 opacity-70 hover:opacity-100"
    @click="open"
  >
    {{ label }}
  </button>
</template>
