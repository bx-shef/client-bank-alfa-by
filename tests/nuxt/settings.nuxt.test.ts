import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import SettingsForm from '~/components/SettingsForm.vue'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '~/utils/settingsSections'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'

// Монтируем САМУ форму, а не страницу `/settings`: страница — тонкая оболочка (шапка + механика
// закрытия), и она покрыта отдельно в `appSlider.nuxt.test.ts`.
// Форма придерживает содержимое до конца цепочки onMounted (init + nextTick + checkAdmin + load) —
// прокручиваем её, чтобы форма отрисовалась.
async function mountReady(section: SettingsSectionId = 'bank') {
  const wrapper = await mountSuspended(SettingsForm, { props: { section } })
  await flushPromises()
  await nextTick()
  return wrapper
}

/**
 * Форма, открытая на разделе «Уведомления в чат».
 *
 * ⚠ Предпросмотр «что попадёт в чат» показывается ТОЛЬКО в разделах про чат (#530): рядом с картой
 * распознавания он отвечал бы на вопрос, которого на экране не задавали. Поэтому тесты про
 * предпросмотр обязаны сперва открыть тот раздел, в котором он вообще есть.
 */
async function mountOnChats() {
  const wrapper = await mountReady('chats')
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

// Настройки разбиты на РАЗДЕЛЫ (#530): на экране только активный, остальные размонтированы.
// Поэтому тест, трогающий поле другого раздела, сперва переключается на него — так же, как это
// делает человек: кликом по пункту навигации.
//
/**
 * Открыть раздел.
 *
 * ⚠ Здесь это СМЕНА ПРОПА, а не клик: с переездом раскладки слайдера навигация живёт на странице
 * `/settings`, а форма получает активный раздел пропом. Кликабельность пунктов и подсветка
 * проверяются там же, на странице (`settingsSections.nuxt.test.ts`), — дублировать их здесь
 * значило бы проверять чужую ответственность и краснеть от правок вёрстки страницы.
 */
async function openSection(wrapper: VueWrapper, label: string) {
  const found = SETTINGS_SECTIONS.find(sec => sec.label === label)
  expect(found, `раздела «${label}» нет в списке`).toBeTruthy()
  await wrapper.setProps({ section: found!.id })
  await flushPromises()
  await nextTick()
}

describe('форма настроек', () => {
  it('renders the grouped sections and one preview row per operation', async () => {
    const wrapper = await mountReady()
    const text = wrapper.text()
    // ⚠ Заголовка «Настройки» здесь БОЛЬШЕ НЕТ, и это правильно: экран открывается слайдером
    // портала, заголовок несёт его шапка (`app/pages/settings.vue`). Форма, дублирующая его,
    // давала два одинаковых заголовка подряд. Проверять его здесь — держаться за прежнюю оболочку.
    //
    // ⚠ Названия ВСЕХ разделов видны всегда — они в полосе навигации. В этом и была суть #530:
    // раньше про существование настройки узнавали, только раскрыв её секцию.
    // ⚠ Проверка «видны все разделы» переехала в тест СТРАНИЦЫ: с новой раскладкой слайдера
    // список разделов живёт на ней (`settingsSections.nuxt.test.ts` проверяет и состав, и то,
    // что до каждого можно дойти кликом). Здесь форме доступен только активный раздел.
    // А поля — только активного раздела. По умолчанию открыт банк (см. `settingsSections.ts`).
    expect(text).not.toContain('Чат ошибок импорта')

    await openSection(wrapper, 'Уведомления в чат')
    expect(wrapper.text()).toContain('Чат ошибок импорта')
    expect(previewRows(wrapper)).toHaveLength(MOCK_STATEMENT.items.length)
  })

  // ⚠ #44: дефолт СМЕНИЛСЯ на оба направления. Пока галки управляли только чатом, молчаливый по
  // умолчанию чат был осторожностью; теперь та же настройка решает, будет ли операция ЗАГРУЖЕНА, и
  // прежний дефолт означал бы, что свежеустановленное приложение молча не переносит расходы.
  it('по умолчанию переносим ОБА направления — #44', async () => {
    const wrapper = await mountOnChats()
    const rows = previewRows(wrapper)
    expect(rows[creditIdx]!.text()).toContain('в чат')
    expect(rows[debitIdx]!.text()).toContain('в чат')
  })

  it('сводка считает, сколько операций дойдёт до чата (по умолчанию — все) — #44', async () => {
    const wrapper = await mountOnChats()
    expect(wrapper.find('[data-testid="preview-summary"]').text())
      .toContain(`В чат попадёт ${MOCK_STATEMENT.items.length} из ${MOCK_STATEMENT.items.length}`)
  })

  // ⚠ Сводка обязана следовать настройке, а не быть константой: выключив приходы, админ должен
  // увидеть уменьшившееся число ещё до сохранения — это и есть смысл предпросмотра.
  it('выключенное направление уменьшает сводку — #44', async () => {
    const wrapper = await mountOnChats()
    useChatSettings().settings.chat.rules.directions = ['debit']
    await nextTick()
    expect(wrapper.find('[data-testid="preview-summary"]').text())
      .toContain(`В чат попадёт ${MOCK_STATEMENT.items.length - creditCount} из ${MOCK_STATEMENT.items.length}`)
  })

  it('disabling "Приходы" hides the credit in the preview', async () => {
    const wrapper = await mountOnChats()
    useChatSettings().settings.chat.rules.directions = ['debit']
    await nextTick()
    // ⚠ #44: выключенное направление больше НЕ «скрыто в чате» — операция не импортируется вовсе.
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('направление выключено')
  })

  it('excluding a purpose pattern marks the matching op as NOT imported (§2 A2)', async () => {
    const wrapper = await mountOnChats()
    useChatSettings().settings.chat.rules.excludePurposePatterns = [MOCK_STATEMENT.items[creditIdx]!.purpose]
    await nextTick()
    // ⚠ Причина непереноса НАЗЫВАЕТСЯ (#44): исключения и направление чинятся в разных полях формы,
    // поэтому у них разные бейджи — а сводка считает и то, и другое одним числом «не импортируется».
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('исключена')
    expect(wrapper.find('[data-testid="preview-summary"]').text()).toContain('не импортируется')
  })

  it('обе галки сняты — не импортируется НИЧЕГО, и список это показывает — #44', async () => {
    const wrapper = await mountOnChats()
    useChatSettings().settings.chat.rules.directions = []
    await nextTick()
    // ⚠ Список остаётся видимым: он и объясняет, что именно не поедет. Прежде эта проверка
    // утверждала «операции всё равно импортируются, просто молча» — теперь это неверно.
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('ни одна операция не будет перенесена в CRM')
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('направление выключено')
    expect(wrapper.find('[data-testid="preview-summary"]').text())
      .toContain(`${MOCK_STATEMENT.items.length} — не импортируется`)
  })

  // Drive the real UI controls (not just the singleton) so the component wiring
  // — directionModel get/set on B24Switch, the textarea→settings watch — is covered.
  it('toggling the "Приходы" switch off silences the credit in chat (UI wiring)', async () => {
    const wrapper = await mountOnChats()
    const sw = wrapper.find('[data-testid="notify-credit"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await nextTick()
    // ⚠ #44: направление — гейт ЗАГРУЗКИ. Список остаётся (он показывает, что не поедет), но
    // бейдж больше не обещает запись без оповещения.
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(true)
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('направление выключено')
  })

  it('typing an exclude pattern marks the matching op NOT imported (UI wiring)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Исключения')
    const textarea = wrapper.find('textarea[data-testid="exclude-patterns"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue(MOCK_STATEMENT.items[creditIdx]!.purpose)
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('исключена')
  })

  // Auto-distribution gate (§2 mutation slice): the switch binds settings.autoDistribute
  // and only shows the "will mutate CRM" warning when ON (fail-safe default off).
  it('renders the auto-distribution section, off by default with no warning', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
    expect(wrapper.find('[data-testid="auto-distribute"]').exists()).toBe(true)
    // The absent warning (driven by v-if="settings.autoDistribute") is what pins "off by default".
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(false)
  })

  it('enabling auto-distribution reveals the CRM-mutation warning', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').text()).toContain('изменять данные в CRM')
  })

  it('disabling auto-distribution again removes the warning (v-if teardown, not v-show)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
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
    await openSection(wrapper, 'Авто-проведение')
    expect(wrapper.find('[data-testid="auto-distribute-warning"]').exists()).toBe(true)
  })

  it('toggling the auto-distribution switch flips settings.autoDistribute (UI wiring)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
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
    await openSection(wrapper, 'Авто-проведение')
    const input = wrapper.find('input[data-testid="invoice-paid-stage"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('DT31_11:P')
  })

  it('paid-invoice-stage input appears only when auto-distribution is on', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
    expect(wrapper.find('[data-testid="invoice-paid-stage"]').exists()).toBe(false) // hidden while OFF
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="invoice-paid-stage"]').exists()).toBe(true)
  })

  it('typing a paid-invoice stage sets allocation.invoicePaidStageId; clearing removes it (UI wiring)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
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

  it('trigger-code field appears only when auto-distribution is on and shows the canonical CODE (#79)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
    expect(wrapper.find('[data-testid="trigger-code"]').exists()).toBe(false) // hidden while OFF
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    expect(wrapper.find('[data-testid="trigger-code"]').exists()).toBe(true)
    // The canonical code the app registers at install is surfaced so the admin knows what to enter.
    expect(wrapper.find('[data-testid="trigger-code-field"]').text()).toContain('cba_payment_received')
  })

  it('typing a trigger code sets allocation.triggerCode; clearing removes it (#79 UI wiring)', async () => {
    const wrapper = await mountReady()
    await openSection(wrapper, 'Авто-проведение')
    useChatSettings().settings.autoDistribute = true
    await nextTick()
    const input = wrapper.find('input[data-testid="trigger-code"]')
    expect(input.exists()).toBe(true)
    await input.setValue('  cba_payment_received ')
    await nextTick()
    expect(useChatSettings().settings.allocation.triggerCode).toBe('cba_payment_received') // trimmed
    await input.setValue('   ')
    await nextTick()
    expect('triggerCode' in useChatSettings().settings.allocation).toBe(false) // blank → key removed
  })
})
