import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import SettingsPage from '~/pages/settings.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'

// The form withholds content until its onMounted admin-check chain (await init +
// nextTick + checkAdmin + load) resolves — flush it so the form is rendered.
async function mountReady() {
  const wrapper = await mountSuspended(SettingsPage)
  await flushPromises()
  await nextTick()
  return wrapper
}

// useChatSettings() is a module-level singleton — reset it between tests so order
// can't leak state. The preview reacts to the same singleton, so we drive the
// filter through it rather than through b24ui component internals. Outside the
// frame (test env: no window.name) the form is not admin-blocked and renders in
// preview mode (persistence is inert).
beforeEach(() => {
  Object.assign(useChatSettings().settings, defaultPortalSettings())
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

const creditIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'credit')
const debitIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'debit')
const creditCount = MOCK_STATEMENT.items.filter(i => i.direction === 'credit').length

function previewRows(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="preview-list"] li')
}

describe('settings page', () => {
  it('renders the heading, the grouped sections and one preview row per operation', async () => {
    const wrapper = await mountReady()
    const text = wrapper.text()
    expect(text).toContain('Настройки')
    expect(text).toContain('Уведомления в чат')
    expect(text).toContain('Чат для ошибок')
    expect(text).toContain('Исключения')
    expect(previewRows(wrapper)).toHaveLength(MOCK_STATEMENT.items.length)
  })

  it('renders the custom-development cross-sell card', async () => {
    const wrapper = await mountReady()
    expect(wrapper.text()).toContain('Нужна доработка под ваш процесс?')
  })

  it('by default announces credits and hides debits', async () => {
    const wrapper = await mountReady()
    const rows = previewRows(wrapper)
    expect(rows[creditIdx]!.text()).toContain('в чат')
    expect(rows[debitIdx]!.text()).toContain('скрыто')
  })

  it('summary counts how many operations reach the chat', async () => {
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="preview-summary"]').text())
      .toContain(`В чат попадёт ${creditCount} из ${MOCK_STATEMENT.items.length}`)
  })

  it('disabling "Приходы" hides the credit in the preview', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.chat.rules.directions = ['debit']
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('excluding a purpose pattern hides the matching credit (selective)', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.chat.rules.excludePurposePatterns = [MOCK_STATEMENT.items[creditIdx]!.purpose]
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('warns (and drops the list) when the rules hide everything', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.chat.rules.directions = []
    await nextTick()
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('в чат ничего не попадёт')
  })

  // Drive the real UI controls (not just the singleton) so the component wiring
  // — directionModel get/set on B24Switch, the textarea→settings watch — is covered.
  it('toggling the "Приходы" switch off hides the credit (UI wiring)', async () => {
    const wrapper = await mountReady()
    const sw = wrapper.find('[data-testid="notify-credit"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('в чат ничего не попадёт')
  })

  it('typing an exclude pattern hides the matching credit (UI wiring)', async () => {
    const wrapper = await mountReady()
    const textarea = wrapper.find('textarea[data-testid="exclude-patterns"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue(MOCK_STATEMENT.items[creditIdx]!.purpose)
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  // Auto-distribution gate (§2 mutation slice): the switch binds settings.autoDistribute
  // and only shows the "will mutate CRM" warning when ON (fail-safe default off).
  it('renders the auto-distribution section, off by default with no warning', async () => {
    const wrapper = await mountReady()
    expect(wrapper.text()).toContain('Авто-проведение оплат')
    expect(wrapper.find('[data-testid="auto-distribute"]').exists()).toBe(true)
    // The absent warning (driven by v-if="settings.autoDistribute") is what pins "off by default".
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(false)
  })

  it('enabling auto-distribution reveals the CRM-mutation warning', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').text()).toContain('изменять данные в CRM')
  })

  it('disabling auto-distribution again removes the warning (v-if teardown, not v-show)', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(true)
    useChatSettings().settings.autoDistribute = false
    await nextTick()
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(false)
  })

  it('reflects an already-loaded autoDistribute=true on first render (initial get-binding)', async () => {
    // Set the singleton BEFORE mount: outside the frame cs.load() is inert and does not
    // overwrite it, so the form must paint the warning from the loaded value on first render.
    useChatSettings().settings.autoDistribute = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(true)
  })

  it('toggling the auto-distribution switch flips settings.autoDistribute (UI wiring)', async () => {
    const wrapper = await mountReady()
    expect(useChatSettings().settings.autoDistribute).toBe(false)
    await wrapper.find('[data-testid="auto-distribute"]').trigger('click')
    await nextTick()
    expect(useChatSettings().settings.autoDistribute).toBe(true)
  })

  it('reflects an already-loaded stage in the input on first render (get-binding)', async () => {
    // Set BEFORE mount: outside the frame cs.load() is inert, so the input must paint
    // the loaded value via the computed getter (exercises the non-empty `get` path).
    useChatSettings().settings.autoDistribute = true
    useChatSettings().settings.allocation.invoicePaidStageId = 'DT31_11:P'
    const wrapper = await mountReady()
    const input = wrapper.find('input[data-testid="invoice-paid-stage"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('DT31_11:P')
  })

  it('paid-invoice-stage input appears only when auto-distribution is on', async () => {
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="invoice-paid-stage"]').exists()).toBe(false) // hidden while OFF
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="invoice-paid-stage"]').exists()).toBe(true)
  })

  it('typing a paid-invoice stage sets allocation.invoicePaidStageId; clearing removes it (UI wiring)', async () => {
    const wrapper = await mountReady()
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    const input = wrapper.find('input[data-testid="invoice-paid-stage"]')
    expect(input.exists()).toBe(true)
    await input.setValue('  DT31_11:P ')
    await nextTick()
    expect(useChatSettings().settings.allocation.invoicePaidStageId).toBe('DT31_11:P') // trimmed
    await input.setValue('   ')
    await nextTick()
    expect('invoicePaidStageId' in useChatSettings().settings.allocation).toBe(false) // blank → key removed
  })
})
