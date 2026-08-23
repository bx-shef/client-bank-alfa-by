<script setup lang="ts">
import { computed } from 'vue'
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date'
import { isIsoDay, toIsoDay } from '~/utils/dayValue'

// Поле выбора ОДНОГО дня на штатном `B24Calendar` (#588). Наружу — обычная строка `ГГГГ-ММ-ДД`
// (или пустая), внутрь — тип календаря; так вызывающие не тянут `@internationalized/date`.
//
// ⚠ Заведён общим, а не написан в двух местах: календарей в приложении два — забор выписки за день
// и период очистки, — и родного `type="date"` у обоих было мало по разным причинам. У забора нужна
// граница «не в будущем», у очистки нативное поле показывало формат операционной системы (в портале
// это бывает `mm/dd/yyyy`) и молча принимало день, которого нет.
//
// ⚠ Пустое значение поддержано намеренно: у очистки пустая граница значит «с самого начала» / «по
// сегодня», и подставлять туда сегодняшнее число значило бы менять смысл настройки за человека.

const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  /** Верхняя граница выбора. По умолчанию — сегодня (нельзя выбрать будущее). */
  max?: string
  /** Нижняя граница выбора. Пусто ⇒ без ограничения снизу. */
  min?: string
  /** Показывать кнопку «Очистить» (для необязательных границ периода). */
  clearable?: boolean
}>(), { max: '', min: '', clearable: false })

/** Строка → значение календаря; кривая или пустая строка ⇒ ничего не выбрано. */
function toCalendar(iso: string): CalendarDate | undefined {
  if (!isIsoDay(iso)) return undefined
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new CalendarDate(y, m, d)
}

const value = computed({
  get: () => toCalendar(model.value),
  // ⚠ Календарь отдаёт `CalendarDate` в СВОЁМ часовом поясе; строку собираем из его же полей
  // (`toIsoDay`), а не через `Date.toISOString()` — иначе у пояса восточнее UTC выбранный день
  // уезжал бы на предыдущий.
  set: (v) => { model.value = v ? toIsoDay({ year: v.year, month: v.month, day: v.day }) : '' }
})

const maxValue = computed(() => toCalendar(props.max) ?? today(getLocalTimeZone()))
const minValue = computed(() => toCalendar(props.min))
</script>

<template>
  <div class="space-y-2">
    <B24Calendar
      v-model="value"
      :max-value="maxValue"
      :min-value="minValue"
      size="sm"
      color="air-primary"
      data-testid="day-calendar"
    />
    <div
      v-if="clearable && model"
      class="flex justify-end"
    >
      <B24Button
        size="xs"
        color="air-tertiary-no-accent"
        data-testid="day-clear"
        @click="model = ''"
      >
        Очистить
      </B24Button>
    </div>
  </div>
</template>
