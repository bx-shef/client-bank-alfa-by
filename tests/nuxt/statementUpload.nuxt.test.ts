import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import StatementUpload from '~/components/StatementUpload.vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = (rel: string) => join(import.meta.dirname, '..', 'fixtures', rel)

/** Уронить файл в дропзону: компонент читает `dataTransfer.files`, другого входа у него нет. */
async function drop(wrapper: Awaited<ReturnType<typeof mountSuspended>>, name: string, bytes: Buffer) {
  const file = new File([new Uint8Array(bytes)], name, { type: 'text/plain' })
  await wrapper.find('[data-testid="dropzone"]').trigger('drop', { dataTransfer: { files: [file] } })
  // Разбор пакета уходит в макрозадачи (между файлами стоит yield) — даём им отработать.
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r))
  await wrapper.vm.$nextTick()
}

// Канал отзывов серверный — включаем мокой, иначе виджеты не рисуются и проверять нечего.
vi.mock('~/composables/useFeedback', () => ({
  useFeedback: () => ({
    enabled: ref(true),
    ensureEnabled: vi.fn(async () => {}),
    submit: vi.fn(async () => true),
    alreadyRated: () => false,
    rememberRated: () => {}
  })
}))

// Render/wiring test. The parse itself (windows-1251 decode → operations, dedup,
// validation) is covered on real fixtures in tests/importUpload.test.ts; the
// drag-drop parse flow is verified visually (screenshots with a fixture file).
describe('StatementUpload', () => {
  it('renders the dropzone and pick button, no preview before any file', async () => {
    const wrapper = await mountSuspended(StatementUpload)
    expect(wrapper.find('[data-testid="dropzone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pick"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-input"]').exists()).toBe(true)
    // No results yet → no file list, no summary, no clear button.
    expect(wrapper.find('[data-testid="file-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="clear"]').exists()).toBe(false)
  })

  // ⚠ #44: предпросмотр обязан показывать то, что ПОПАДЁТ В CRM. Первая редакция правки читала
  // настройки, но никто их не ЗАГРУЖАЛ — синглтон на фрейме `/import` свежий (форма настроек тут
  // не монтируется), поэтому `directions` навсегда оставались дефолтом, фильтр был мёртв, а строка
  // «Не будут загружены» не появлялась никогда. Проверяем именно ЗАПРОС настроек: тест, который
  // подсовывает значения в синглтон напрямую, обошёл бы отсутствующий `load()` и дал ложное зелёное.
  it('запрашивает настройки портала — иначе фильтр направлений мёртв (#44)', async () => {
    const { useChatSettings } = await import('~/composables/useChatSettings')
    const singleton = useChatSettings()
    const spy = vi.spyOn(singleton, 'load').mockResolvedValue(undefined)
    try {
      await mountSuspended(StatementUpload)
      expect(spy, 'без load() настройки остаются дефолтными и фильтр не работает').toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('the file input accepts only .txt and allows multiple', async () => {
    const wrapper = await mountSuspended(StatementUpload)
    const input = wrapper.find('[data-testid="file-input"]')
    expect(input.attributes('accept')).toContain('.txt')
    expect(input.attributes('multiple')).toBeDefined()
  })

  it('без загрузок блок «Результат обработки» не рисуется, а восстановление ключей инертно', async () => {
    // `onMounted` поднимает ключи из sessionStorage (#417). Вне портала фрейм-токена нет, опрос
    // не идёт, и мусор в хранилище не должен ронять монтирование.
    sessionStorage.setItem('cba.import.batches', '{"не":"массив"}')
    const wrapper = await mountSuspended(StatementUpload)
    expect(wrapper.find('[data-testid="batch-results"]').exists()).toBe(false)
  })

  /**
   * ⚠ «Не удалось разобрать» обязано означать РОВНО «ни один файл не разобрался». Блок висел
   * `v-else-if` на предпросмотре, поэтому выписка целиком из выключенного настройкой направления
   * (#44) давала пустой предпросмотр — и приложение показывало предупреждение о формате рядом с
   * зелёным «разобрано: 2» и строкой «выключены расходы», отправляя человека чинить исправный
   * файл вместо настройки. Найдено владельцем на боевом портале.
   */
  it('выключенное направление — это не «не удалось разобрать» (#44)', async () => {
    const { useChatSettings } = await import('~/composables/useChatSettings')
    const singleton = useChatSettings()
    const spy = vi.spyOn(singleton, 'load').mockResolvedValue(undefined)
    const before = singleton.settings.chat.rules.directions
    singleton.settings.chat.rules.directions = ['credit'] // расходы выключены
    try {
      const wrapper = await mountSuspended(StatementUpload)
      await drop(wrapper, 'debits.txt', readFileSync(fixture('paritet/settlement-byn.txt')))

      expect(wrapper.find('[data-testid="skipped-by-direction"]').exists(), 'пропуск по настройке обязан быть назван').toBe(true)
      expect(wrapper.find('[data-testid="all-failed"]').exists(), 'разобранный файл не «не удалось разобрать»').toBe(false)
    } finally {
      singleton.settings.chat.rules.directions = before
      spy.mockRestore()
    }
  })

  it('а вот нераспознанный формат предупреждение показывает', async () => {
    const wrapper = await mountSuspended(StatementUpload)
    await drop(wrapper, 'garbage.txt', Buffer.from('это не выписка\nвообще\n', 'utf8'))
    expect(wrapper.find('[data-testid="all-failed"]').exists()).toBe(true)
  })

  it('без разбора и без итога виджетов отзыва нет — спрашивать не о чем (#499)', async () => {
    // Виджет «разбор» появляется только когда что-то разобралось, виджет «загрузка» — только когда
    // карточка итога вообще есть. Пустой экран не должен спрашивать «результат помог?».
    sessionStorage.removeItem('cba.import.batches')
    const wrapper = await mountSuspended(StatementUpload)
    expect(wrapper.findAllComponents({ name: 'FeedbackWidget' })).toHaveLength(0)
  })
})
