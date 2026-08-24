import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DayField from '~/components/DayField.vue'
import DayRangeField from '~/components/DayRangeField.vue'

// Поле выбора одного дня (#592). Проверяем ГРАНИЦУ и преобразование
// строка↔календарь — то, ради чего компонент и заведён общим на два места.
describe('DayField', () => {
  it('поле ввода и кнопка календаря на месте', async () => {
    // ⚠ Проверяем именно ПОЛЕ, а не развёрнутый календарь: раскладка сменилась на `B24InputDate`
    // с календарём в поповере — дату можно и впечатать, и выбрать, а два развёрнутых календаря
    // в разделе очистки съедали экран целиком.
    const wrapper = await mountSuspended(DayField, { props: { modelValue: '2026-08-17' } })
    expect(wrapper.find('[data-testid="day-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="day-calendar-open"]').exists()).toBe(true)
  })

  it('дата показывается в русском формате, а не в американском', async () => {
    // ⚠ Замерено: без явной `locale` поле рисует `mm/dd/yyyy`. Это ровно та беда, из-за которой мы
    // ушли от нативного `type="date"` — «08/09» и «09.08» читаются как разные дни, а у периода
    // очистки действие необратимо.
    const wrapper = await mountSuspended(DayField, { props: { modelValue: '' } })
    expect(wrapper.text().replace(/\s+/g, '')).toContain('дд.мм.гггг')
  })

  it('кривое значение не роняет поле — просто ничего не выбрано', async () => {
    // ⚠ Модель приходит извне (из настроек портала), и мусор в ней — обычное дело: строка
    // хранится как есть. Падение здесь означало бы пустой раздел настроек вместо формы.
    const wrapper = await mountSuspended(DayField, { props: { modelValue: '31.02.2026' } })
    expect(wrapper.find('[data-testid="day-input"]').exists()).toBe(true)
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

describe('DayRangeField', () => {
  it('период — одно поле на две границы', async () => {
    const wrapper = await mountSuspended(DayRangeField, { props: { from: '2026-08-01', to: '2026-08-17' } })
    expect(wrapper.find('[data-testid="day-range-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="day-range-calendar-open"]').exists()).toBe(true)
  })

  it('«Очистить» появляется при ЛЮБОЙ заполненной границе и сбрасывает обе', async () => {
    // ⚠ Именно при любой: период с одной границей — законное состояние («с 1 августа по сегодня»),
    // и кнопка, требующая заполнить обе, не дала бы его отменить.
    const empty = await mountSuspended(DayRangeField, { props: { from: '', to: '' } })
    expect(empty.find('[data-testid="day-range-clear"]').exists()).toBe(false)
    const half = await mountSuspended(DayRangeField, { props: { from: '2026-08-01', to: '' } })
    expect(half.find('[data-testid="day-range-clear"]').exists()).toBe(true)
    await half.find('[data-testid="day-range-clear"]').trigger('click')
    expect(half.emitted('update:from')?.at(-1)).toEqual([''])
    // ⚠ `update:to` здесь НЕ ждём: там уже было пусто, и Vue не эмитит присваивание того же
    // значения. Ожидание обоих событий на полупустом периоде — ровно та ошибка, которую я и
    // допустил: тест краснел на исправном компоненте и увёл диагностику в несуществующую
    // «запись в модель из шаблона не работает».
    const both = await mountSuspended(DayRangeField, { props: { from: '2026-08-01', to: '2026-08-17' } })
    await both.find('[data-testid="day-range-clear"]').trigger('click')
    expect(both.emitted('update:from')?.at(-1)).toEqual([''])
    expect(both.emitted('update:to')?.at(-1)).toEqual([''])
  })
})
