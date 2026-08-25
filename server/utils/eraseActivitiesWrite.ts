// Транспорт «стереть дела, созданные приложением» (#576 п.4) над инъектируемыми `call`/`batch`.
// Чистые правила отбора — `app/utils/eraseActivities.ts`; здесь только ввод-вывод и границы объёма.
//
// ЗАМЕРЕНО НА ЖИВОМ ПОРТАЛЕ (2026-08-22), и от этого зависит вся конструкция:
//   · `crm.activity.list` с фильтром `ORIGINATOR_ID` отдаёт наши дела постранично по 50 и несёт
//     `total` — то есть «сколько попадёт под удаление» можно показать ДО удаления одним запросом;
//   · фильтр диапазона `>=DEADLINE`/`<=DEADLINE` работает;
//   · `crm.activity.delete` РАЗРЕШЁН в батче (пробный вызов вернул ошибку КОМАНДЫ «Activity is not
//     found», а не `ERROR_BATCH_METHOD_NOT_ALLOWED`). Без этого 400 дел удалялись бы по одному при
//     лимите 2 запроса в секунду — три минуты, то есть не в HTTP-запросе, а в очереди.
//
// ⚠ Общий батч-транспорт ОСТАНАВЛИВАЕТСЯ на первой упавшей команде (`isHaltOnError: true`), и для
// чтения это верно. Для удаления — нет: дело, уже удалённое человеком вручную, оборвало бы весь
// остаток пачки. Поэтому здесь падение чанка НЕ считается провалом операции: мы прекращаем удалять
// и берём правду из портала — перечитываем `total` тем же фильтром. Сколько именно применилось
// внутри оборвавшегося чанка, знать не нужно и не надо: единственное честное число — сколько
// осталось СЕЙЧАС, и его называет сам портал.

import {
  buildEraseListFilter,
  selectDeletable,
  type ActivityRow,
  type EraseSelection
} from '../../app/utils/eraseActivities'
import type { RestBatch, RestCall } from './companyLookup'
// ⚠ Оба метода берутся из СУЩЕСТВУЮЩИХ источников, а не объявляются здесь заново. Свои копии в
// `app/utils/eraseActivities.ts` были дублями: Nuxt авто-импортит весь `app/utils/**` в ОДНО
// плоское пространство имён, и `ACTIVITY_DELETE_METHOD` там уже был (`todoActivity.ts`) — какая из
// двух побеждала, зависело от порядка импортов, а разойтись они могли молча (находка ревью).
import { ACTIVITY_DELETE_METHOD } from '../../app/utils/todoActivity'
import { ACTIVITY_LIST_METHOD } from './activityMarkerLookup'

/** Размер страницы `crm.activity.list` — задаётся порталом, не нами. */
export const ACTIVITY_PAGE = 50

/**
 * Потолок дел, стираемых ЗА ОДИН вызов.
 *
 * ⚠ Это не «сколько всего можно стереть», а сколько влезает в один HTTP-запрос: удаление идёт
 * пачками по 50 при лимите 2 запроса в секунду, плюс столько же запросов на сбор идентификаторов.
 * Больше — и запрос упрётся в `proxy_read_timeout` nginx, а человек увидит 504 на НЕОБРАТИМОМ
 * действии, не понимая, применилось ли оно. Остаток честно называется в ответе, и кнопка жмётся
 * ещё раз — это лучше, чем таймаут посреди удаления.
 */
export const MAX_ERASE_PER_REQUEST = 300

/** Что вернула операция. */
export interface EraseOutcome {
  /** Сколько дел удалено этим вызовом. */
  deleted: number
  /** Сколько ещё подпадает под тот же отбор (правда из портала, а не наша арифметика). */
  remaining: number
}

function rowsOf(resp: Record<string, unknown>): ActivityRow[] {
  const result = resp?.result
  if (!Array.isArray(result)) return []
  return result.map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: row.ID != null ? String(row.ID) : '',
      originatorId: row.ORIGINATOR_ID != null ? String(row.ORIGINATOR_ID) : '',
      originId: row.ORIGIN_ID != null ? String(row.ORIGIN_ID) : '',
      // `DESCRIPTION` приходит ТОЛЬКО когда мы его запросили (фильтр по счёту контрагента, #591);
      // иначе поля в ответе нет, и это честная пустая строка.
      description: row.DESCRIPTION != null ? String(row.DESCRIPTION) : ''
    }
  })
}

/**
 * Поля `select` для `crm.activity.list`. `DESCRIPTION` добавляется ТОЛЬКО при фильтре по счёту
 * контрагента (#591): из него `counterpartyAccountOf` достаёт счёт. В общем пути его не тащим —
 * описание объёмное (назначение, реквизиты), а на счёт по НАШЕЙ стороне оно не нужно.
 */
function listSelect(selection: EraseSelection): string[] {
  const base = ['ID', 'ORIGINATOR_ID', 'ORIGIN_ID']
  return selection.counterpartyAccounts.length > 0 ? [...base, 'DESCRIPTION'] : base
}

/** Сколько дел ВСЕГО попадает под фильтр портала (до нашего точного отбора по счёту). */
function totalOf(resp: Record<string, unknown>): number {
  const t = Number(resp?.total)
  return Number.isFinite(t) && t >= 0 ? t : 0
}

/**
 * Посчитать, сколько дел попадёт под удаление, НИЧЕГО не удаляя.
 *
 * ⚠ Отдельная функция и отдельный маршрут, а не флаг «сухой прогон» у стирания. Флаг означал бы,
 * что один неверный булев в клиенте превращает показ в удаление; здесь подсчёт СТРУКТУРНО не умеет
 * удалять — он не знает метода.
 *
 * ⚠ Когда отбор по счетам пуст, ответ портала (`total`) уже и есть искомое число, и страницы
 * листать незачем. Когда счета заданы — точное сравнение делаем мы (см. шапку `eraseActivities`),
 * поэтому страницы приходится пройти. Потолок тот же, что у стирания: показать «более 300» честнее,
 * чем считать пять минут.
 */
export async function countErasableActivities(
  selection: EraseSelection,
  call: RestCall,
  cap = MAX_ERASE_PER_REQUEST
): Promise<{ count: number, capped: boolean }> {
  const filter = buildEraseListFilter(selection.period)
  const select = listSelect(selection)
  const first = await call(ACTIVITY_LIST_METHOD, {
    filter, select, order: { ID: 'ASC' }, start: 0
  })
  const total = totalOf(first)

  // ⚠ `selectDeletable` применяется ВСЕГДА, в том числе когда отбора по счетам нет.
  //
  // Прежняя версия в этом случае возвращала сырой `total` портала, не заглянув в строки, — и это
  // расходилось с собственным правилом модуля «не доверяй фильтру запроса, перепроверь ответ»
  // (находка ревью). Цена расхождения не абстрактная: показанное «будет стёрто 300» считалось бы
  // ОДНИМ правилом, а удалялось бы по ДРУГОМУ — строки без `id` и без нашей метки подсчёт бы
  // засчитал, а стирание отбросило. Человек увидел бы «удалено 287 из 300» на необратимом
  // действии и не понял бы, что произошло. Лишние страницы стоят до шести запросов при потолке в
  // 300 — несопоставимо дешевле, чем расхождение двух чисел.
  let matched = selectDeletable(rowsOf(first), selection).length
  let start = ACTIVITY_PAGE
  while (start < total && matched < cap) {
    const page = await call(ACTIVITY_LIST_METHOD, {
      filter, select, order: { ID: 'ASC' }, start
    })
    matched += selectDeletable(rowsOf(page), selection).length
    start += ACTIVITY_PAGE
  }
  // ⚠ `capped` означает «под отбор попадает БОЛЬШЕ, чем мы стираем за раз», и здесь он честно
  // консервативен: обход прекращается, как только набрано `cap`, поэтому оставшиеся страницы могли
  // бы не дать ни одного совпадения. Ошибка в эту сторону безопасна — «и более» приглашает нажать
  // ещё раз, а лишнее нажатие ничего не портит; обратная ошибка молча оставила бы дела.
  return { count: Math.min(matched, cap), capped: matched >= cap && start < total }
}

/**
 * Удалить дела, попадающие под отбор. Возвращает, сколько удалено и сколько осталось.
 *
 * ⚠ Удаляются ТОЛЬКО строки, прошедшие `selectDeletable`, то есть подтвердившие наш
 * `ORIGINATOR_ID` В ОТВЕТЕ портала. Фильтр запроса — наш код и может содержать ошибку; эта
 * проверка смотрит на то, что вернул портал, и превращает такую ошибку в пустой результат вместо
 * удаления чужих звонков и встреч.
 */
export async function eraseActivities(
  selection: EraseSelection,
  call: RestCall,
  batch: RestBatch,
  cap = MAX_ERASE_PER_REQUEST
): Promise<EraseOutcome> {
  const filter = buildEraseListFilter(selection.period)
  const listParams = { filter, select: listSelect(selection), order: { ID: 'ASC' }, start: 0 }

  const first = await call(ACTIVITY_LIST_METHOD, listParams)
  const total = totalOf(first)
  const ids: string[] = selectDeletable(rowsOf(first), selection).map(r => r.id)
  let start = ACTIVITY_PAGE
  while (start < total && ids.length < cap) {
    const page = await call(ACTIVITY_LIST_METHOD, { ...listParams, start })
    ids.push(...selectDeletable(rowsOf(page), selection).map(r => r.id))
    start += ACTIVITY_PAGE
  }
  const doomed = ids.slice(0, cap)

  let deleted = 0
  for (let i = 0; i < doomed.length; i += ACTIVITY_PAGE) {
    const chunk = doomed.slice(i, i + ACTIVITY_PAGE)
    try {
      await batch(chunk.map(id => ({ method: ACTIVITY_DELETE_METHOD, params: { id } })))
      deleted += chunk.length
    } catch {
      // ⚠ Не проваливаем операцию: чаще всего это дело, уже удалённое человеком вручную, и
      // остановиться здесь правильнее, чем продолжать вслепую. Настоящее число назовёт портал ниже.
      break
    }
  }

  // ⚠ Остаток берём У ПОРТАЛА, а не вычитаем. Внутри оборвавшегося чанка часть команд могла
  // примениться, и наша арифметика соврала бы ровно в том случае, когда человеку важнее всего
  // понимать, что произошло.
  const after = await call(ACTIVITY_LIST_METHOD, { ...listParams, select: ['ID'] })
  return { deleted, remaining: totalOf(after) }
}
