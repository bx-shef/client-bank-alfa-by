import { describe, expect, it } from 'vitest'
import {
  CHAT_PREVIEW_SECTIONS,
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS,
  sectionForReadiness,
  showsChatPreview,
  type SettingsSectionId
} from '../app/utils/settingsSections'
import type { ReadinessItem } from '../app/utils/setupReadiness'

describe('разделы настроек (#530)', () => {
  it('список и идентификаторы не разъезжаются', () => {
    // ⚠ Две коллекции одного и того же — классический способ добавить раздел в навигацию и забыть
    // про него в разборе адреса (или наоборот): ссылка тогда молча открывает не тот экран.
    expect(SETTINGS_SECTIONS.map(s => s.id)).toEqual([...SETTINGS_SECTION_IDS])
    expect(new Set(SETTINGS_SECTION_IDS).size).toBe(SETTINGS_SECTION_IDS.length)
  })

  it('у каждого раздела есть название и подсказка', () => {
    // Подсказка — не украшение: по одному названию «Смарт-процессы» не понять, надо ли туда идти.
    for (const s of SETTINGS_SECTIONS) {
      expect(s.label.length, `${s.id}: пустое название`).toBeGreaterThan(2)
      expect(s.hint.length, `${s.id}: пустая подсказка`).toBeGreaterThan(5)
    }
  })

  it('подключение банка идёт ПЕРВЫМ', () => {
    // ⚠ Не вкусовщина: на нём держится весь онлайн-импорт, а жило оно в углу, который никто не
    // открывал — на живом прогоне админ его просто не нашёл. Порядок здесь — часть починки.
    expect(SETTINGS_SECTIONS[0]!.id).toBe('bank')
    expect(DEFAULT_SETTINGS_SECTION).toBe('bank')
  })

  it('неизвестный раздел открывает раздел по умолчанию, а не пустой экран', () => {
    // ⚠ Ссылка из старого письма или опечатка не должны давать пустую страницу: человек решит,
    // что сломалось приложение, а не адрес.
    expect(resolveSettingsSection('chats')).toBe('chats')
    expect(resolveSettingsSection(' chats ')).toBe('chats')
    expect(resolveSettingsSection('нетакого')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(resolveSettingsSection('')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(resolveSettingsSection(undefined)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(resolveSettingsSection(null)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(resolveSettingsSection(42)).toBe(DEFAULT_SETTINGS_SECTION)
    // Строка запроса может прийти массивом (`?section=a&section=b`) — берём первое значение.
    expect(resolveSettingsSection(['exclusions', 'chats'])).toBe('exclusions')
    expect(resolveSettingsSection([])).toBe(DEFAULT_SETTINGS_SECTION)
  })

  it('предпросмотр чата — только там, где он про ЭТИ правила', () => {
    // ⚠ Сводка «что попадёт в чат» рядом с картой распознавания отвечала бы на вопрос, которого
    // на экране не задавали, и читалась бы как последствие правок распознавания.
    expect(showsChatPreview('chats')).toBe(true)
    expect(showsChatPreview('exclusions')).toBe(true)
    expect(showsChatPreview('bank')).toBe(false)
    expect(showsChatPreview('recognition')).toBe(false)
    for (const id of CHAT_PREVIEW_SECTIONS) {
      expect(SETTINGS_SECTION_IDS as readonly string[]).toContain(id)
    }
  })

  it('каждая строка готовности ведёт в раздел, где её и чинят', () => {
    // ⚠ Инвариант, а не таблица ради таблицы: экран готовности НАЗЫВАЛ раздел словами, а идти
    // туда человек должен был сам. Ключи берём из production-типа — забыли новый вид проверки,
    // и он молча остался бы без ссылки.
    const keys: ReadinessItem['key'][] = ['my-company', 'bank', 'chat', 'error-chat', 'recognition', 'smart-process', 'poll']
    for (const key of keys) {
      const target = sectionForReadiness(key)
      if (target !== null) {
        expect(SETTINGS_SECTION_IDS as readonly string[], `${key} ведёт в несуществующий раздел`).toContain(target)
      }
    }
    expect(sectionForReadiness('bank')).toBe('bank')
    expect(sectionForReadiness('poll'), 'опрос настраивается там же, где подключение').toBe('bank')
    expect(sectionForReadiness('error-chat'), 'оба чата — в одном разделе').toBe('chats')
    // ⚠ «Моя компания» чинится в КАРТОЧКЕ КОМПАНИИ, а не в настройках приложения: ссылка «в
    // раздел» была бы ложью и увела бы человека не туда.
    expect(sectionForReadiness('my-company')).toBeNull()
    expect(sectionForReadiness('нетакого')).toBeNull()
  })

  it('каждый идентификатор разобран сам в себя', () => {
    for (const id of SETTINGS_SECTION_IDS) {
      expect(resolveSettingsSection(id)).toBe(id satisfies SettingsSectionId)
    }
  })
})
