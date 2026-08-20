import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import AsyncSearchSelect from '~/components/AsyncSearchSelect.vue'

// Render/wiring test. The menu content (states / load-more) only renders while the
// combobox is open, which happy-dom won't drive, so here we cover what IS
// assertable: lazy mount (no fetch until first open) and selected-label
// persistence via selectedOption. The interactive states are covered by the
// composable tests + manual/visual verification in the consumer page.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AsyncSearchSelect', () => {
  it('does NOT fetch on mount — the default list loads lazily on first open', async () => {
    const fetcher = vi.fn(async () => ({ items: [{ value: 'c1', label: 'Отдел продаж' }], total: 1 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, placeholder: 'Выберите чат' }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).not.toHaveBeenCalled() // idle pickers don't hit the backend
    expect(wrapper.text()).toContain('Выберите чат') // placeholder while unselected
  })

  it('shows the selected option label without a fetch (persists across reload)', async () => {
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: {
        fetcher,
        modelValue: 'chat42',
        selectedOption: { value: 'chat42', label: 'АО Ромашка' }
      }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(wrapper.text()).toContain('АО Ромашка')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('emits update:selectedOption with the resolved row on selection change', async () => {
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      // seed the option so it's resolvable in displayItems without a fetch
      props: { fetcher, selectedOption: { value: 'chat7', label: 'Бухгалтерия' } }
    })
    await vi.advanceTimersByTimeAsync(10)

    await wrapper.setProps({ modelValue: 'chat7' }) // user picks the seeded chat
    await vi.advanceTimersByTimeAsync(10)
    const events = wrapper.emitted('update:selectedOption')
    expect(events?.at(-1)?.[0]).toEqual({ value: 'chat7', label: 'Бухгалтерия' })

    await wrapper.setProps({ modelValue: undefined }) // cleared
    await vi.advanceTimersByTimeAsync(10)
    expect(wrapper.emitted('update:selectedOption')?.at(-1)?.[0]).toBeUndefined()
  })

  it('does NOT emit when the value is unresolvable (protects a parent-known label)', async () => {
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, { props: { fetcher } })
    await vi.advanceTimersByTimeAsync(10)
    // Set a value with no matching row in displayItems (nothing seeded, nothing fetched).
    await wrapper.setProps({ modelValue: 'ghost' })
    await vi.advanceTimersByTimeAsync(10)
    // No emit for the unresolvable value → the parent's cached title stays intact.
    expect(wrapper.emitted('update:selectedOption')).toBeUndefined()
  })
})

describe('AsyncSearchSelect: сброс выбора', () => {
  it('приводит очищенную модель к ПУСТОЙ СТРОКЕ, а не к undefined', async () => {
    // Значение живёт в `PortalSettings`, где поле типизировано `string` и сравнивается
    // с `!== ''` («настроено ли приложение»). `undefined` это сравнение проходит — портал
    // после сброса чата считался бы настроенным, — а `JSON.stringify` вовсе выбрасывает
    // такой ключ из тела сохранения.
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, modelValue: 'chat42', clearable: true }
    })
    await wrapper.setProps({ modelValue: undefined })
    await nextTick()
    await nextTick()

    const emitted = wrapper.emitted('update:modelValue') as unknown[][] | undefined
    expect(emitted?.at(-1)?.[0]).toBe('')
  })

  it('null от компонента приводится к пустой строке так же, как undefined', async () => {
    // b24ui чистит значение своим `ComboboxCancel`; какой именно из двух «пустых» он отдаст,
    // деталь его реализации — гейт «настроено» не должен от неё зависеть.
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, modelValue: 'chat42', clearable: true }
    })
    await wrapper.setProps({ modelValue: null as never })
    await nextTick()
    await nextTick()

    const emitted = wrapper.emitted('update:modelValue') as unknown[][] | undefined
    expect(emitted?.at(-1)?.[0]).toBe('')
  })
})

describe('AsyncSearchSelect: сброс с клавиатуры', () => {
  it('кнопка очистки фокусируема И срабатывает по Enter/Space', async () => {
    // Штатная кнопка b24ui — `span` с `tabindex="-1"` и только click-обработчиком. Один
    // `tabindex: 0` сделал бы хуже, чем было: Tab остановился бы на элементе, который
    // объявляется обычным текстом и ничего не делает по клавише.
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, modelValue: 'chat42', clearable: true }
    })
    const clear = wrapper.find('[aria-label="Очистить"]')
    expect(clear.exists()).toBe(true)
    expect(clear.attributes('tabindex')).toBe('0')
    expect(clear.attributes('role')).toBe('button')

    await clear.trigger('keydown', { key: 'Enter' })
    await nextTick()
    const emitted = wrapper.emitted('update:modelValue') as unknown[][] | undefined
    expect(emitted?.at(-1)?.[0]).toBe('')
  })
})
