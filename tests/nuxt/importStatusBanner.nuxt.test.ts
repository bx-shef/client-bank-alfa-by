import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import ImportStatusBanner from '~/components/ImportStatusBanner.vue'
import type { ImportRunSummary } from '~/types/importStatus'

function make(over: Partial<ImportRunSummary>): ImportRunSummary {
  return { state: 'ok', lastSyncAt: null, operations: 0, activitiesCreated: 0, chatNotified: 0, errors: [], ...over }
}

describe('ImportStatusBanner', () => {
  it('ok: relative-time headline, operations count (correct plural) and the CRM/chat chain', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: {
        status: make({
          state: 'ok',
          lastSyncAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          operations: 3,
          activitiesCreated: 3,
          chatNotified: 2
        })
      }
    })
    await nextTick()
    const text = wrapper.text()
    expect(text).toContain('Обновлено')
    expect(text).toContain('+3 новые операции') // grammatically correct for 2–4
    expect(text).toContain('Записано в CRM')
    expect(text).toContain('2 в чат')
  })

  it('ok with zero operations: "Новых операций нет" and no chain line', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: { status: make({ state: 'ok', lastSyncAt: new Date().toISOString(), operations: 0 }) }
    })
    await nextTick()
    expect(wrapper.text()).toContain('Новых операций нет')
    expect(wrapper.text()).not.toContain('Записано в CRM')
  })

  it('error: shows the error and a "Проверить настройки" action', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: { status: make({ state: 'error', errors: ['Банк не ответил'] }) }
    })
    expect(wrapper.text()).toContain('Ошибка синхронизации')
    expect(wrapper.text()).toContain('Банк не ответил')
    expect(wrapper.text()).toContain('Проверить настройки')
  })

  it('never: shows the "not run yet" label', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: { status: make({ state: 'never' }) }
    })
    expect(wrapper.text()).toContain('Ещё не запускалась')
  })
})
