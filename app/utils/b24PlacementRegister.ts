// Чистый билдер `placement.bind` для точки `REST_APP_URI` (#19) — регистрации обработчика,
// который портал открывает по ссылке `/marketplace/view/<код>/` (см. `appUriLink.ts`).
//
// ⚠ Зеркалит `b24TriggerRegister.ts` намеренно: та же форма (чистый билдер + транспорт у
// вызывающего), те же два ограничения метода — нужен КОНТЕКСТ ПРИЛОЖЕНИЯ (iframe установки его
// даёт) и метод НЕЛЬЗЯ класть в батч (`ERROR_BATCH_METHOD_NOT_ALLOWED`), поэтому вызов
// standalone, отдельно от батча `event.bind`.
//
// ⚠ НО ИДЕМПОТЕНТНОСТЬ ЗДЕСЬ ДРУГАЯ, и это главное отличие от триггера. `crm.automation.trigger.add`
// на повторе просто обновляет имя; `placement.bind` у точки с одной регистрацией на повторе
// ОТКАЗЫВАЕТ — `ERROR_PLACEMENT_MAX_COUNT`. То есть на переустановке отказ штатен и означает «уже
// зарегистрировано», а не поломку. Считать его ошибкой — значит красить исправную установку в
// жёлтое (вердикт #410 разводит `ok`/`degraded` именно по таким признакам).
//
// ⚠ ИЗ ЭТОГО ЖЕ СЛЕДУЕТ ЛОВУШКА: сменить АДРЕС обработчика повторным `bind` нельзя — сначала
// `placement.unbind`. Пока этого не сделали, портал продолжает открывать СТАРЫЙ адрес, и снаружи
// это выглядит как «ссылка ведёт не туда» на свежем выкате. Поэтому адрес обработчика меняем
// только вместе с процедурой из `docs/APP_LINKS.md`, а не правкой константы.

import type { B24Call } from './b24EventBind'
import { APP_URI_PLACEMENT } from './appUriLink'

/** Ответ портала на повторную регистрацию точки, допускающей одну. */
export const PLACEMENT_ALREADY_BOUND = 'ERROR_PLACEMENT_MAX_COUNT'

/**
 * Построить вызов `placement.bind`, либо `null` при негодном адресе обработчика.
 *
 * ⚠ Адрес обязан быть АБСОЛЮТНЫМ и `https`. Относительный портал принял бы, но открывал бы его от
 * СВОЕГО домена — то есть обработчиком стала бы страница портала, а не наша. Тот же fail-safe, что
 * у привязки событий: без `NUXT_PUBLIC_SITE_URL` установка честно отказывается регистрировать,
 * вместо того чтобы зарегистрировать заведомо неверное.
 *
 * `TITLE` передаём, хотя у этой точки кнопки в интерфейсе нет: он виден в списке обработчиков
 * (`placement.get`), и без него оператор не поймёт, что за регистрация висит на портале.
 */
export function buildPlacementBindCall(handlerUrl: string, title: string): B24Call | null {
  const url = (handlerUrl ?? '').trim()
  if (!/^https:\/\/[^\s/]+\/\S*$/i.test(url)) return null
  const name = (title ?? '').trim()
  return {
    method: 'placement.bind',
    params: { PLACEMENT: APP_URI_PLACEMENT, HANDLER: url, ...(name ? { TITLE: name } : {}) }
  }
}

/** Снять регистрацию — единственный способ сменить адрес обработчика (см. шапку). */
export function buildPlacementUnbindCall(handlerUrl?: string): B24Call {
  const url = (handlerUrl ?? '').trim()
  return {
    method: 'placement.unbind',
    params: { PLACEMENT: APP_URI_PLACEMENT, ...(url ? { HANDLER: url } : {}) }
  }
}

/**
 * Отличить «уже зарегистрировано» от настоящего отказа.
 *
 * ⚠ Смотрим на КОД ошибки, а не на её текст: текст портал отдаёт локализованным и завтра он придёт
 * на другом языке. Код у Битрикс24 приезжает в разных обёртках (сырой конверт `{error}`, объект
 * ошибки SDK, просто строка), поэтому проверяем несколько форм — но именно код, не подстроку
 * человеческого описания.
 */
export function isPlacementAlreadyBound(err: unknown): boolean {
  if (typeof err === 'string') return err.includes(PLACEMENT_ALREADY_BOUND)
  if (!err || typeof err !== 'object') return false
  const o = err as Record<string, unknown>
  for (const key of ['error', 'code', 'name', 'message']) {
    const v = o[key]
    if (typeof v === 'string' && v.includes(PLACEMENT_ALREADY_BOUND)) return true
  }
  return false
}
