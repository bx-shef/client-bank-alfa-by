import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import FeedbackWidget from '~/components/FeedbackWidget.vue'

// Render/wiring test for the 👍/👎 feedback widget. The channel gate + sanitization + issue builder
// are covered in tests/feedback*.test.ts; here we drive the component through a mocked useFeedback.
const mockState = { enabled: true as boolean, submit: vi.fn(async () => true) }
/** Память «уже оценено» живёт в composable и переживает размонтирование виджета — здесь она
 *  моделируется тем же способом, каким работает настоящая (module-level Set). */
const rated = new Set<string>()

vi.mock('~/composables/useFeedback', () => ({
  useFeedback: () => ({
    enabled: ref(mockState.enabled),
    ensureEnabled: vi.fn(async () => {}),
    submit: mockState.submit,
    alreadyRated: (k?: string) => !!k && rated.has(k),
    rememberRated: (k?: string) => {
      if (k) rated.add(k)
    }
  })
}))

afterEach(() => {
  mockState.enabled = true
  mockState.submit = vi.fn(async () => true)
  rated.clear()
})

async function mountReady() {
  const wrapper = await mountSuspended(FeedbackWidget)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('FeedbackWidget', () => {
  it('renders nothing when the channel is disabled', async () => {
    mockState.enabled = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="feedback-widget"]').exists()).toBe(false)
  })

  it('renders 👍/👎 when enabled', async () => {
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="feedback-up"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="feedback-down"]').exists()).toBe(true)
    // No comment box until 👎 is clicked.
    expect(wrapper.find('[data-testid="feedback-comment"]').exists()).toBe(false)
  })

  it('👍 submits immediately and shows the thanks state', async () => {
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(mockState.submit).toHaveBeenCalledWith('up', undefined, { fileName: undefined })
    expect(wrapper.find('[data-testid="feedback-sent"]').exists()).toBe(true)
  })

  it('outside a portal (submit → false) shows the portal-only notice, not a fake success', async () => {
    mockState.submit = vi.fn(async () => false)
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="feedback-sent"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('только внутри портала')
  })

  it('👎 opens the comment box first, then submits with the comment', async () => {
    const wrapper = await mountReady()
    await wrapper.find('[data-testid="feedback-down"]').trigger('click')
    await nextTick()
    // First 👎 click only opens the box — no submit yet.
    expect(mockState.submit).not.toHaveBeenCalled()
    const box = wrapper.find('[data-testid="feedback-comment"]')
    expect(box.exists()).toBe(true)
    await box.setValue('счёт не распознан')
    // Click the «Отправить» B24Button (the only button labelled «Отправить» in the open box).
    const submitBtn = wrapper.findAll('button').find(b => b.text().includes('Отправить'))!
    await submitBtn.trigger('click')
    await flushPromises()
    await nextTick()
    expect(mockState.submit).toHaveBeenCalledWith('down', 'счёт не распознан', { fileName: undefined, fileContent: undefined })
    expect(wrapper.find('[data-testid="feedback-sent"]').exists()).toBe(true)
  })

  it('shows the file-attach consent ONLY when a fileText is available (in the 👎 box)', async () => {
    const noFile = await mountSuspended(FeedbackWidget)
    await flushPromises()
    await noFile.find('[data-testid="feedback-down"]').trigger('click')
    await nextTick()
    expect(noFile.find('[data-testid="feedback-attach"]').exists()).toBe(false)

    const withFile = await mountSuspended(FeedbackWidget, { props: { fileName: 'v.txt', fileText: 'ФАЙЛ' } })
    await flushPromises()
    await withFile.find('[data-testid="feedback-down"]').trigger('click')
    await nextTick()
    expect(withFile.find('[data-testid="feedback-attach"]').exists()).toBe(true)
  })

  it('👎 with consent ticked attaches the statement text; unticked sends no fileContent', async () => {
    // Unticked: fileText present but the box left unchecked → no fileContent.
    const off = await mountSuspended(FeedbackWidget, { props: { fileName: 'v.txt', fileText: 'СЕКЦИЯ' } })
    await flushPromises()
    await off.find('[data-testid="feedback-down"]').trigger('click')
    await nextTick()
    await off.findAll('button').find(b => b.text().includes('Отправить'))!.trigger('click')
    await flushPromises()
    expect(mockState.submit).toHaveBeenCalledWith('down', undefined, { fileName: 'v.txt', fileContent: undefined })

    // Ticked: toggle the consent checkbox, then submit → fileContent carries the statement text.
    mockState.submit = vi.fn(async () => true)
    const on = await mountSuspended(FeedbackWidget, { props: { fileName: 'v.txt', fileText: 'СЕКЦИЯ' } })
    await flushPromises()
    await on.find('[data-testid="feedback-down"]').trigger('click')
    await nextTick()
    await on.get('[role="checkbox"]').trigger('click')
    await nextTick()
    await on.findAll('button').find(b => b.text().includes('Отправить'))!.trigger('click')
    await flushPromises()
    expect(mockState.submit).toHaveBeenCalledWith('down', undefined, { fileName: 'v.txt', fileContent: 'СЕКЦИЯ' })
  })

  it('👍 never attaches the file even if the 👎 box was opened and consent ticked', async () => {
    const wrapper = await mountSuspended(FeedbackWidget, { props: { fileName: 'v.txt', fileText: 'СЕКЦИЯ' } })
    await flushPromises()
    await wrapper.find('[data-testid="feedback-down"]').trigger('click') // open box + show checkbox
    await nextTick()
    await wrapper.get('[role="checkbox"]').trigger('click') // consent ticked
    await nextTick()
    await wrapper.find('[data-testid="feedback-up"]').trigger('click') // instant 👍
    await flushPromises()
    // Positive rating must carry NO file, despite the ticked consent in the still-open 👎 box.
    expect(mockState.submit).toHaveBeenCalledWith('up', undefined, { fileName: 'v.txt', fileContent: undefined })
  })
})

describe('FeedbackWidget — повторная оценка того же предмета (#499)', () => {
  // Внутри строки операции виджет живёт в `B24Collapsible`, а тот ВЫГРУЖАЕТ содержимое при
  // сворачивании. «Спасибо за отзыв!» исчезало вместе со строкой, повторное раскрытие снова
  // предлагало кнопки — и второй 👍 заводил ВТОРОЙ issue о том же платеже, столько раз, сколько
  // строку свернули и развернули. Дедупа у счастливого пути нет (он только у outbox-ретрая).
  async function mountFor(subjectKey?: string) {
    const w = await mountSuspended(FeedbackWidget, { props: { subjectKey } })
    await flushPromises()
    await nextTick()
    return w
  }

  it('после оценки повторно смонтированный виджет уже не предлагает кнопки', async () => {
    const first = await mountFor('BY01|doc-1')
    await first.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()
    expect(mockState.submit).toHaveBeenCalledTimes(1)

    // Строку свернули и развернули — компонент создаётся заново.
    const second = await mountFor('BY01|doc-1')
    expect(second.find('[data-testid="feedback-up"]').exists()).toBe(false)
    expect(second.text()).toContain('Спасибо')
  })

  it('ДРУГОЙ платёж оценивается независимо', async () => {
    const first = await mountFor('BY01|doc-1')
    await first.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()

    const other = await mountFor('BY01|doc-2')
    expect(other.find('[data-testid="feedback-up"]').exists()).toBe(true)
  })

  it('виджет без предмета оценки не запоминается — «как вам вообще» можно сказать снова', async () => {
    const first = await mountFor()
    await first.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()

    const second = await mountFor()
    expect(second.find('[data-testid="feedback-up"]').exists()).toBe(true)
  })
})
