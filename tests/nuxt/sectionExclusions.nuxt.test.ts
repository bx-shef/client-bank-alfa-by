import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SectionExclusions from '~/components/settings/SectionExclusions.vue'

// Раздел «Исключения»: списки, любой из которых пропускает операцию ЦЕЛИКОМ.
//
// ⚠ Списка НАШИХ счетов здесь нет, и тест держит именно его ОТСУТСТВИЕ. Он дублировал «Паузу»
// подключения, причём хуже неё: гейт исключений стоит в `crm-sync`, то есть уже ПОСЛЕ похода в
// банк, а пауза останавливает опрос до него и не тратит лимит запросов. Последним оправданием
// оставалась файловая загрузка — отпало: файл выписки выгружается ПО ОДНОМУ счёту (шапка несёт
// один `^Acc=…^`), и тот, кто его грузит, сам выбирает, по какому. Вернуть поле «для симметрии
// с контрагентами» — первое, что придёт в голову следующему, поэтому запрет явный.
describe('SectionExclusions', () => {
  it('поля НАШИХ счетов нет — для своих счетов есть «Пауза» подключения', async () => {
    const wrapper = await mountSuspended(SectionExclusions)
    expect(wrapper.find('[data-testid="exclude-accounts"]').exists()).toBe(false)
    expect(wrapper.text(), 'вернулась подпись снятого поля').not.toContain('Свои счета')
  })

  it('остаются два списка: чужие счета и текст назначения', async () => {
    const wrapper = await mountSuspended(SectionExclusions)
    expect(wrapper.find('[data-testid="exclude-counterparty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="exclude-patterns"]').exists()).toBe(true)
  })

  it('подпись чужих счетов называет сторону и примеры, а не безликое «по счетам»', async () => {
    // ⚠ Владелец, глядя на прежние подписи, спросил «зачем их два» — они отличались одним словом в
    // конце длинной строки, а плейсхолдер у обоих был «BY00...». Теперь сторона названа первой.
    const wrapper = await mountSuspended(SectionExclusions)
    const text = wrapper.text()
    expect(text).toContain('Чужие счета')
    expect(text, 'вернулась безликая подпись').not.toContain('Не загружать по счетам')
    const cp = wrapper.find('[data-testid="exclude-counterparty"]').attributes('placeholder') ?? ''
    expect(cp).toMatch(/налогов|банк|эквайринг/i)
  })
})
