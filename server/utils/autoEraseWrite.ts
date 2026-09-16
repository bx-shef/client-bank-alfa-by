// Транспорт автоудаления дел по ОДНОМУ порталу (#722) над инъектируемыми `call`/`batch`.
// Чистые правила — `app/utils/autoEraseActivities.ts`; здесь только ввод-вывод и границы объёма.
//
// ⚠ ПОЧЕМУ НЕ ПЕРЕИСПОЛЬЗУЕТСЯ `eraseActivities` ЦЕЛИКОМ. У ручной очистки отбор задаёт человек и
// он же видит число перед нажатием, поэтому её обход оптимизирован под «показать ровно то, что
// удалим» (страницы, потолок совпадений, `capped` на экран). Здесь отбор один и тот же, свидетеля
// нет, а лишняя страница стоит запроса из лимита портала. Общим осталось то, что обязано быть
// общим и вынесено, а не скопировано: подтверждение нашего `ORIGINATOR_ID` и возраста в ОТВЕТЕ
// (`selectAutoErasable`) и методы REST.
//
// ⚠ ОБХОД БЕЗ `start`, И ЭТО НЕ ЛЕНЬ. Мы УДАЛЯЕМ то, что прочитали, поэтому смещение постранично
// уезжает под нами: удалив первые 50 из 300, мы сдвигаем весь остаток на 50 позиций назад, и
// `start=50` пропустит ровно столько же строк. Ручная очистка этого не замечает, потому что сперва
// собирает ВСЕ идентификаторы и лишь потом удаляет. Здесь дешевле и честнее другое: всегда читать
// ПЕРВУЮ страницу, удалять её и читать снова — выборка сама подтягивается, а порядок `ID ASC`
// делает обход детерминированным.

import {
  buildAutoEraseFilter,
  selectAutoErasable,
  type AutoEraseCutoff,
  type AutoErasePortalResult,
  type AutoEraseRow,
  MAX_AUTO_ERASE_PER_PORTAL
} from '../../app/utils/autoEraseActivities'
import type { RestBatch, RestCall } from './companyLookup'
import { ACTIVITY_DELETE_METHOD } from '../../app/utils/todoActivity'
import { ACTIVITY_LIST_METHOD } from './activityMarkerLookup'

/** Размер страницы `crm.activity.list` — задаётся порталом, не нами. */
const ACTIVITY_PAGE = 50

/** Поля, которые нужны автоудалению. `DESCRIPTION` НЕ запрашиваем — отбора по счетам здесь нет. */
const SELECT = ['ID', 'ORIGINATOR_ID', 'CREATED']

function rowsOf(resp: Record<string, unknown>): AutoEraseRow[] {
  const result = resp?.result
  if (!Array.isArray(result)) return []
  return result.map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: row.ID != null ? String(row.ID) : '',
      originatorId: row.ORIGINATOR_ID != null ? String(row.ORIGINATOR_ID) : '',
      created: row.CREATED != null ? String(row.CREATED) : ''
    }
  })
}

function totalOf(resp: Record<string, unknown>): number {
  const t = Number(resp?.total)
  return Number.isFinite(t) && t >= 0 ? t : 0
}

/**
 * Удалить у портала дела старше границы. Возвращает, сколько удалено и сколько ещё подпадает.
 *
 * ⚠ Останавливаемся на первой странице, где не оказалось НИ ОДНОГО удаляемого дела. Это не
 * оптимизация, а единственный способ не зациклиться: если портал отдаёт строки, которые наша
 * вторая граница отбрасывает (чужой `ORIGINATOR_ID`, нечитаемая дата, а главное — молча
 * проигнорированный фильтр даты), повторное чтение первой страницы вернуло бы их же вечно.
 *
 * ⚠ Падение батча НЕ проваливает прогон по порталу: чаще всего это дело, которое человек удалил
 * руками, и остановиться правильнее, чем продолжать вслепую. Настоящий остаток спрашиваем у
 * портала, а не вычитаем — внутри оборвавшегося чанка часть команд могла примениться.
 */
export async function autoEraseForPortal(
  cutoff: AutoEraseCutoff,
  call: RestCall,
  batch: RestBatch,
  cap = MAX_AUTO_ERASE_PER_PORTAL
): Promise<AutoErasePortalResult> {
  const filter = buildAutoEraseFilter(cutoff)
  const listParams = { filter, select: SELECT, order: { ID: 'ASC' }, start: 0 }

  let deleted = 0
  let stopped = false
  while (deleted < cap && !stopped) {
    const page = await call(ACTIVITY_LIST_METHOD, listParams)
    const doomed = selectAutoErasable(rowsOf(page), cutoff).map(r => r.id)
    if (doomed.length === 0) break
    const chunk = doomed.slice(0, Math.min(ACTIVITY_PAGE, cap - deleted))
    try {
      await batch(chunk.map(id => ({ method: ACTIVITY_DELETE_METHOD, params: { id } })))
      deleted += chunk.length
    } catch {
      stopped = true
    }
  }

  // ⚠ Остаток берём У ПОРТАЛА тем же фильтром: он и есть ответ на «сколько ещё предстоит», и
  // только он переживает оборвавшийся чанк без вранья.
  const after = await call(ACTIVITY_LIST_METHOD, { ...listParams, select: ['ID'] })
  return { deleted, remaining: totalOf(after) }
}
