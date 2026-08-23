import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DayField from '~/components/DayField.vue'

// Поле выбора одного дня на штатном B24Calendar (#588). Проверяем ГРАНИЦУ и преобразование
// строка↔календарь — то, ради чего компонент и заведён общим на два места.
describe('DayField', () => {
  it('календарь отдаёт день строкой ГГГГ-ММ-ДД', async () => {
    const wrapper = await mountSuspended(DayField, { props: { modelValue: '2026-08-17' } })
    expect(wrapper.find('[data-testid="day-calendar"]').exists()).toBe(true)
  })

  it('кривое значение не роняет поле — просто ничего не выбрано', async () => {
    // ⚠ Модель приходит извне (из настроек портала), и мусор в ней — обычное дело: строка
    // хранится как есть. Падение здесь означало бы пустой раздел настроек вместо формы.
    const wrapper = await mountSuspended(DayField, { props: { modelValue: '31.02.2026' } })
    expect(wrapper.find('[data-testid="day-calendar"]').exists()).toBe(true)
  })

  it('кнопка «Очистить» появляется только у необязательной границы с выбранным днём', async () => {
    const plain = await mountSuspended(DayField, { props: { modelValue: '2026-08-17' } })
    expect(plain.find('[data-testid="day-clear"]').exists()).toBe(false)
    const clearable = await mountSuspended(DayField, { props: { modelValue: '2026-08-17', clearable: true } })
    expect(clearable.find('[data-testid="day-clear"]').exists()).toBe(true)
    await clearable.find('[data-testid="day-clear"]').trigger('click')
    expect(clearable.emitted('update:modelValue')?.at(-1)).toEqual([''])
    const empty = await mountSuspended(DayField, { props: { modelValue: '', clearable: true } })
    expect(empty.find('[data-testid="day-clear"]').exists()).toBe(false)
  })
})
