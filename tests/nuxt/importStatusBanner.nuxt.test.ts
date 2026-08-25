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
    // #37: заголовок «Последние движения», а не «Обновлено» (путало с частотой опроса).
    expect(text).toContain('Последние движения')
    expect(text).toContain('+3 движения по счёту') // правильное склонение для 2–4
    expect(text).toContain('Записаны в CRM')
    // #37: явно «уведомления в чат», а не голое «2 в чат» (читалось как «часть не в CRM»).
    expect(text).toContain('2 уведомления в чат')
  })

  it('ok with zero operations: "Новых движений нет" and no chain line', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: { status: make({ state: 'ok', lastSyncAt: new Date().toISOString(), operations: 0 }) }
    })
    await nextTick()
    expect(wrapper.text()).toContain('Новых движений по счёту нет')
    expect(wrapper.text()).not.toContain('Записаны в CRM')
  })

  it('ok с одной операцией и одним уведомлением — правильное склонение (#37)', async () => {
    const wrapper = await mountSuspended(ImportStatusBanner, {
      props: {
        status: make({ state: 'ok', lastSyncAt: new Date().toISOString(), operations: 1, chatNotified: 1 })
      }
    })
    await nextTick()
    const text = wrapper.text()
    expect(text).toContain('+1 движение по счёту')
    expect(text).toContain('1 уведомление в чат')
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
