<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date'
import CalendarIcon from '@bitrix24/b24icons-vue/outline/CalendarIcon'
import { isIsoDay, toIsoDay } from '~/utils/dayValue'

// Период из двух дней одним полем (#592), штатная пара `B24InputDate range` + `B24Calendar range`
// (пример «As a date range picker» в документации b24ui).
//
// ⚠ Одно поле вместо двух — не косметика. Два отдельных календаря показывали два одинаковых месяца
// рядом, и по ним нельзя было увидеть ПЕРИОД: человек выбирал начало, терял его из виду, выбирал
// конец в соседнем календаре и получал перевёрнутый период, о котором узнавал из предупреждения
// внизу. Диапазон в одном календаре подсвечивает выбранное между границами и перевёрнутым быть не
// может по построению.
//
// ⚠ Наружу — по-прежнему ДВЕ строки `ГГГГ-ММ-ДД` (или пустые). Пустая граница у очистки значит
// «с самого начала» / «по сегодня», и это настоящая настройка, а не «ещё не выбрал»: свести её к
// обязательному диапазону значило бы решить за человека, с какого дня стирать.

const from = defineModel<string>('from', { default: '' })
const to = defineModel<string>('to', { default: '' })

const inputDate = useTemplateRef<{ inputsRef?: { $el?: HTMLElement }[] }>('inputDate')

function toCalendar(iso: string): CalendarDate | undefined {
  if (!isIsoDay(iso)) return undefined
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new CalendarDate(y, m, d)
}

function toIso(v: CalendarDate | undefined): string {
  return v ? toIsoDay({ year: v.year, month: v.month, day: v.day }) : ''
}

const value = computed({
  // ⚠ Именно `undefined`, а не `null`: незаполненную границу диапазона `DateRange` описывает
  // отсутствием значения, и `null` тип не принимает.
  get: () => ({ start: toCalendar(from.value), end: toCalendar(to.value) }),
  set: (v) => {
    from.value = toIso(v?.start as CalendarDate | undefined)
    to.value = toIso(v?.end as CalendarDate | undefined)
  }
})

/** Будущее выбрать нельзя: дел, созданных завтра, не бывает. */
const maxValue = computed(() => today(getLocalTimeZone()))
const filled = computed(() => from.value !== '' || to.value !== '')

// Сброс обеих границ. Отдельной функцией просто ради читаемости шаблона — присваивание моделей
// прямо в обработчике тоже работает (проверено мутацией).
function clear(): void {
  from.value = ''
  to.value = ''
}
</script>

<template>
  <div class="flex items-center gap-2">
    <B24InputDate
      ref="inputDate"
      v-model="value"
      range
      :max-value="maxValue"
      size="sm"
      data-testid="day-range-input"
    >
      <template #trailing>
        <B24Popover :reference="inputDate?.inputsRef?.[0]?.$el">
          <B24Button
            color="air-tertiary-no-accent"
            size="sm"
            :icon="CalendarIcon"
            aria-label="Выбрать период в календаре"
            class="px-0"
            data-testid="day-range-calendar-open"
          />

          <template #content>
            <B24Calendar
              v-model="value"
              class="p-2"
              range
              :number-of-months="2"
              :max-value="maxValue"
              data-testid="day-range-calendar"
            />
          </template>
        </B24Popover>
      </template>
    </B24InputDate>

    <B24Button
      v-if="filled"
      size="xs"
      color="air-tertiary-no-accent"
      data-testid="day-range-clear"
      @click="clear"
    >
      Очистить
    </B24Button>
  </div>
</template>
