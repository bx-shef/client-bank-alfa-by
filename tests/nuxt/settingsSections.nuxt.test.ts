import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import SettingsForm from '~/components/SettingsForm.vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'
import { SETTINGS_SECTIONS, showsChatPreview, type SettingsSectionId } from '~/utils/settingsSections'

// Проводка разделов настроек (#530).
//
// ⚠ Заведён по итогам мутационного прогона: старый набор доказывал ровно две вещи — что пункт
// навигации кликабелен и что клик меняет разметку. Всё остальное проходило зелёным: раздел можно
// было опустошить, экран готовности убрать, заголовок заклинить на первом разделе, предпросмотр
// показать везде, `?section=` не читать. То есть тесты не защищали ни одного обещания #530.

async function mountReady() {
  const wrapper = await mountSuspended(SettingsForm)
  await flushPromises()
  await nextTick()
  return wrapper
}

async function openSection(wrapper: VueWrapper, label: string) {
  const nav = wrapper.find('[data-testid="settings-nav"]')
  const trigger = nav.findAll('button').find(b => b.text().trim() === label)
  expect(trigger, `раздела «${label}» нет в навигации`).toBeTruthy()
  await trigger!.trigger('click')
  await flushPromises()
  await nextTick()
}

beforeEach(() => {
  Object.assign(useChatSettings().settings, defaultPortalSettings())
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

/** Якорь содержимого каждого раздела — узел, по которому видно, что раздел не пустой. */
const ANCHOR: Record<SettingsSectionId, string> = {
  bank: '[data-testid="bank-connect"]',
  chats: '[data-testid="notify-chat"]',
  distribution: '[data-testid="provision-sp"]',
  exclusions: '[data-testid="exclude-accounts"]',
  auto: '[data-testid="auto-distribute"]',
  recognition: '[data-testid="recognition-map"]',
  cleanup: '[data-testid="erase-activities"]'
}

describe('разделы настроек — проводка (#530)', () => {
  it('состав разделов ЗАКРЕПЛЁН — раздел не исчезает молча', () => {
    // ⚠ Сверка двух коллекций друг с другом (в юнит-тесте модуля) их не удерживает: они спокойно
    // уменьшаются вместе. А исчезнувший раздел — это недостижимая настройка, то есть ровно та
    // болезнь, ради которой #530 и делался. Список закрыт так же, как каналы лога и цели Makefile.
    expect([...SETTINGS_SECTIONS.map(s => s.id)].sort())
      .toEqual(['auto', 'bank', 'chats', 'cleanup', 'distribution', 'exclusions', 'recognition'])
  })

  it.each(SETTINGS_SECTIONS.map(s => [s.label, s.id, s.hint] as const))(
    'раздел «%s»: своё содержимое, свой заголовок, экран готовности',
    async (label, id, hint) => {
      const wrapper = await mountReady()
      await openSection(wrapper, label)

      // Содержимое — иначе раздел можно опустошить, и никто не заметит.
      expect(wrapper.find(ANCHOR[id]).exists(), `раздел «${label}» пуст`).toBe(true)
      // Заголовок и подсказка привязаны к АКТИВНОМУ разделу, а не к первому в списке.
      expect(wrapper.find('[data-testid="section-title"]').text()).toBe(label)
      expect(wrapper.find('[data-testid="section-hint"]').text()).toBe(hint)
      // ⚠ Требование issue дословно: готовность остаётся на КАЖДОМ экране.
      expect(wrapper.find('[data-testid="setup-readiness"]').exists(), 'пропала готовность').toBe(true)
      // Предпросмотр чата — только там, где он про эти правила.
      expect(wrapper.find('[data-testid="preview-list"]').exists(), `предпросмотр не на своём месте в «${label}»`)
        .toBe(showsChatPreview(id))
      // Подсвечен ровно ОДИН пункт, и именно открытый.
      const active = wrapper.find('[data-testid="settings-nav"]').findAll('[aria-current]')
      expect(active).toHaveLength(1)
      expect(active[0]!.text().trim()).toBe(label)
    }
  )

  it('посещённый раздел НЕ перемонтируется при возврате', async () => {
    // ⚠ Это и есть проверка `KeepAlive`, ради которого разделы вынесены в компоненты, — и
    // проверять надо ИМЕННО тождество экземпляра, а не сохранность введённого текста. Первая
    // редакция этого теста вводила черновик и требовала его после возврата; мутация «KeepAlive →
    // div» проходила ЗЕЛЁНОЙ, потому что черновик и так зеркалится в настройки, а новый экземпляр
    // сеется из них же. То есть тест доказывал не то, что заявлял.
    //
    // ⚠ Цена перемонтирования не косметическая: раздел банка при монтировании сверяет счета, а
    // сверка ходит В БАНК. Переключение вкладок туда-обратно било бы по его лимитам запросом,
    // которого никто не просил.
    const wrapper = await mountReady()
    const uid = () => wrapper.findComponent({ name: 'SettingsSectionExclusions' }).vm.$.uid
    await openSection(wrapper, 'Исключения')
    const first = uid()
    await openSection(wrapper, 'Уведомления в чат')
    await openSection(wrapper, 'Исключения')
    expect(uid(), 'раздел пересоздан — KeepAlive не работает').toBe(first)
  })

  it('уход в другой раздел и возврат не теряет черновик', async () => {
    // Отдельно от предыдущего: черновик держится зеркалированием в настройки, а не кэшем.
    const wrapper = await mountReady()
    await openSection(wrapper, 'Исключения')
    await wrapper.find('textarea[data-testid="exclude-accounts"]').setValue('BY00 ЧЕРНОВИК')
    await openSection(wrapper, 'Уведомления в чат')
    await openSection(wrapper, 'Исключения')
    expect((wrapper.find('textarea[data-testid="exclude-accounts"]').element as HTMLTextAreaElement).value)
      .toBe('BY00 ЧЕРНОВИК')
  })

  it('поле «не загружать по счетам» реально пишет в настройки', async () => {
    // Зеркальный тест к уже существующему на «по теме платежа»: без него поле могло никуда не
    // писаться, и мутация «убрать watch» проходила зелёной.
    const wrapper = await mountReady()
    await openSection(wrapper, 'Исключения')
    await wrapper.find('textarea[data-testid="exclude-accounts"]').setValue('BY11\nBY22')
    expect(useChatSettings().settings.chat.rules.excludeAccounts).toEqual(['BY11', 'BY22'])
  })

  it('поля «Исключений» пересеваются после перечитывания настроек', async () => {
    // ⚠ Сценарий «Отмена»: настройки перечитаны с сервера, а раздел лежит в кэше `KeepAlive` и
    // `onMounted` второй раз не позовут. Без пересева в поле оставался бы отменённый текст, и
    // первое же нажатие клавиши вернуло бы его в настройки — то есть отмена тихо не срабатывала.
    const wrapper = await mountReady()
    await openSection(wrapper, 'Исключения')
    await wrapper.find('textarea[data-testid="exclude-accounts"]').setValue('ОТМЕНЁННОЕ')
    await openSection(wrapper, 'Уведомления в чат')
    // Сервер вернул свою копию (эмулируем то, что делает cs.load()).
    useChatSettings().settings.chat.rules.excludeAccounts = ['BY-СЕРВЕРНОЕ']
    await openSection(wrapper, 'Исключения')
    expect((wrapper.find('textarea[data-testid="exclude-accounts"]').element as HTMLTextAreaElement).value)
      .toBe('BY-СЕРВЕРНОЕ')
  })

  it('строка готовности ведёт в свой раздел одним кликом', async () => {
    // ⚠ Ради этого и написан разбор `?section=`: без ссылки экран готовности НАЗЫВАЛ раздел
    // словами, а искать его в полосе человек должен был сам.
    const wrapper = await mountReady()
    const goto = wrapper.find('[data-testid="readiness-goto-chat"]')
    if (!goto.exists()) return // вне портала готовность инертна — тогда проверять нечего
    await goto.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="section-title"]').text()).toBe('Уведомления в чат')
  })
})

describe('раздел из адреса (#530)', () => {
  it.each([
    ['exclusions', 'Исключения'],
    ['recognition', 'Карта распознавания'],
    ['нетакого', 'Подключение банка']
  ])('?section=%s открывает «%s»', async (query, expected) => {
    // ⚠ Чтение адреса — единственное, что делает глубокую ссылку рабочей (её даёт и экран
    // готовности, и письмо), и мутация «не читать `?section=`» проходила зелёной: все названия
    // разделов и так видны в полосе, поэтому проверка по тексту страницы бесполезна — нужен
    // именно заголовок активного раздела.
    const wrapper = await mountSuspended(SettingsForm, { route: `/settings?section=${query}` })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="section-title"]').text()).toBe(expected)
  })
})
