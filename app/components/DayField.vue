<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date'
import CalendarIcon from '@bitrix24/b24icons-vue/outline/CalendarIcon'
import { isIsoDay, toIsoDay } from '~/utils/dayValue'

// Поле выбора ОДНОГО дня (#592). Наружу — обычная строка `ГГГГ-ММ-ДД` (или пустая), внутрь — тип
// календаря, поэтому вызывающие не тянут `@internationalized/date`.
//
// ⚠ Раскладка — штатная пара `B24InputDate` + `B24Calendar` в поповере (пример «As a date picker»
// в документации b24ui), а НЕ развёрнутый календарь. Развёрнутый занимал экран целиком: в разделе
// очистки два таких календаря съедали всю страницу, а сама форма уезжала за сгиб — то есть настройку
// не видно из-за поля ввода к ней. Плюс с одним лишь календарём дату нельзя ВПЕЧАТАТЬ, а
// бухгалтер, знающий число, набирает его быстрее, чем листает месяцы назад.
//
// ⚠ Заведено общим компонентом, а не написано в двух местах: календарей в приложении два — забор
// выписки за день и период очистки, — и родного `type="date"` у обоих было мало по РАЗНЫМ причинам.
// У забора нужна граница «не в будущем», у очистки нативное поле показывало формат операционной
// системы (в портале сплошь `mm/dd/yyyy`) и молча принимало день, которого нет.
//
// ⚠ Пустое значение поддержано намеренно: у очистки пустая граница значит «с самого начала» / «по
// сегодня», и подставлять туда сегодняшнее число значило бы менять смысл настройки за человека.

const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  /** Верхняя граница выбора. По умолчанию — сегодня (будущее выбрать нельзя). */
  max?: string
  /** Нижняя граница выбора. Пусто ⇒ без ограничения снизу. */
  min?: string
  /** Показывать кнопку «Очистить» (для необязательных границ периода). */
  clearable?: boolean
}>(), { max: '', min: '', clearable: false })

const inputDate = useTemplateRef<{ inputsRef?: { $el?: HTMLElement }[] }>('inputDate')

/** Строка → значение календаря; кривая или пустая строка ⇒ ничего не выбрано. */
function toCalendar(iso: string): CalendarDate | undefined {
  if (!isIsoDay(iso)) return undefined
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new CalendarDate(y, m, d)
}

const value = computed({
  get: () => toCalendar(model.value) ?? null,
  // ⚠ Строку собираем из полей календаря (`toIsoDay`), а не через `Date.toISOString()` — иначе у
  // пояса восточнее UTC выбранный день уезжал бы на предыдущий.
  set: (v) => { model.value = v ? toIsoDay({ year: v.year, month: v.month, day: v.day }) : '' }
})

const maxValue = computed(() => toCalendar(props.max) ?? today(getLocalTimeZone()))
const minValue = computed(() => toCalendar(props.min))
</script>

<template>
  <div class="flex items-center gap-2">
    <B24InputDate
      ref="inputDate"
      v-model="value"
      :max-value="maxValue"
      :min-value="minValue"
      size="sm"
      locale="ru"
      data-testid="day-input"
    >
      <template #trailing>
        <B24Popover :reference="inputDate?.inputsRef?.[3]?.$el">
          <B24Button
            color="air-tertiary-no-accent"
            size="sm"
            :icon="CalendarIcon"
            aria-label="Выбрать дату в календаре"
            class="px-0"
            data-testid="day-calendar-open"
          />

          <template #content>
            <B24Calendar
              v-model="value"
              class="p-2"
              :max-value="maxValue"
              :min-value="minValue"
              data-testid="day-calendar"
            />
          </template>
        </B24Popover>
      </template>
    </B24InputDate>

    <B24Button
      v-if="clearable && model"
      size="xs"
      color="air-tertiary-no-accent"
      data-testid="day-clear"
      @click="model = ''"
    >
      Очистить
    </B24Button>
  </div>
</template>
