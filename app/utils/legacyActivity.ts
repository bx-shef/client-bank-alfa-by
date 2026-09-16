// Запасной носитель операции: СИСТЕМНОЕ дело `crm.activity.add` (#722).
//
// ЗАЧЕМ. Основной носитель — универсальное дело `crm.activity.todo.add` (#495). Метода нет на
// порталах, где он ещё не появился (старые коробочные сборки, сборки без обновления модуля CRM):
// портал отвечает `ERROR_METHOD_NOT_FOUND`, и до этой правки такой портал не записывал НИ ОДНОЙ
// операции — при полностью исправном подключении к банку, разборе выписки и найденной компании.
// Симптом при этом читался как поломка импорта, а чинился только обновлением Битрикса.
//
// ⚠ ЧТО ТЕРЯЕТСЯ, И ЭТО НАЗВАНО ЧЕСТНО. У системного дела НЕТ `colorId` — приход и расход перестают
// различаться цветом в ленте. Поэтому направление обязано читаться текстом, и оно читается: заголовок
// начинается словом «Приход»/«Расход» (`buildActivityTitle`), первая строка описания — им же. То есть
// на запасном пути теряется скорость взгляда, а не сведения: «всё вносим в описание» и есть замысел.
//
// ⚠ ОПИСАНИЕ — ТО ЖЕ САМОЕ, и это не экономия строк. Два билдера описания разошлись бы молча: на
// основном пути в карточку попадало бы одно, на запасном — другое, и заметить это можно было бы
// только на старом портале, куда мы и заглядываем реже всего. Общий `buildActivityDescription`
// делает расхождение невозможным по построению.
//
// ⚠ МАРКЕР — ТОТ ЖЕ, И ЭТО НЕСУЩЕЕ. `ORIGINATOR_ID`/`ORIGIN_ID` берутся из `todoActivity.ts`
// (`ACTIVITY_ORIGINATOR_ID`/`activityOriginId`), а НЕ собираются здесь заново из `ACTIVITY_ORIGIN`
// и `dedupKey`. Значения совпали бы и так — ровно поэтому расхождение было бы молчаливым: по этой
// паре ищут ЧЕТЫРЕ разных места (дедуп `crm-sync` перед записью, дозапись реестра и привязок
// `deferredWriteJobs`, стирание дел `eraseActivities`, самопроверка `verifyMarkerOnce`), и свой
// namespace на запасном пути означал бы, что портал не видит СВОИХ ЖЕ записей: каждый опрос писал
// бы дело заново, а «Очистка» не нашла бы ни одного из них. Отдельный код вида
// `…:legacy` тем более запрещён — он раскалывает историю портала пополам.
//
// ⚠ МАРКЕР ЗДЕСЬ АТОМАРЕН, и запасной путь этим ЛУЧШЕ основного. `crm.activity.add` принимает
// `ORIGINATOR_ID`/`ORIGIN_ID` В ТОМ ЖЕ вызове, который создаёт дело, поэтому окна «дело есть,
// маркера нет» не существует вовсе — ни компенсирующего удаления, ни риска дубля при падении
// процесса между двумя вызовами (см. `todoActivityWrite.ts`). Ровно этим свойством обладало
// настраиваемое дело из #259, ради него оно и выбиралось; отказались от него не из-за маркера, а
// потому что оно ломало карточку компании.

import type { StatementItem } from '~/types/statement'
import {
  CRM_OWNER_TYPE_COMPANY, buildActivityTitle, neutralizeBb, toPortalDeadline, type CrmCompanyRef
} from '~/utils/activity'
import {
  ACTIVITY_ORIGINATOR_ID, DESCRIPTION_TYPE_BB, MAX_TITLE_CHARS,
  activityOriginId, buildActivityDescription
} from '~/utils/todoActivity'

/** REST-метод системного дела. Помечен у Битрикса как устаревший — и это ровно то, что нужно:
 *  запасной путь существует для порталов, где НОВОГО метода ещё нет. */
export const LEGACY_ACTIVITY_ADD_METHOD = 'crm.activity.add'

/**
 * `TYPE_ID = 3` — «Задача» (перечисление `crm.enum.activitytype`: 1 встреча, 2 звонок, 3 задача,
 * 4 письмо, 5 действие, 6 пользовательское действие).
 *
 * ⚠ Поле ОБЯЗАТЕЛЬНОЕ (портал отвечает «The field TYPE_ID is not defined or invalid»), поэтому
 * выбор всё равно пришлось бы сделать. Взята «Задача», потому что платёж — это то, с чем человек
 * ещё должен что-то сделать; «Звонок» и «Письмо» вдобавок требуют описания коммуникации, а
 * «Пользовательское действие» — регистрации провайдера, которого у нас нет.
 */
export const LEGACY_ACTIVITY_TYPE_TASK = 3

/** Поля системного дела, которые мы заполняем. */
export interface LegacyActivityFields {
  OWNER_TYPE_ID: number
  OWNER_ID: number
  TYPE_ID: number
  SUBJECT: string
  DESCRIPTION: string
  DESCRIPTION_TYPE: number
  COMPLETED: 'N'
  RESPONSIBLE_ID: number
  START_TIME: string
  END_TIME: string
  DEADLINE: string
  ORIGINATOR_ID: string
  ORIGIN_ID: string
}

/**
 * Собрать параметры `crm.activity.add` для операции, привязанной к компании CRM.
 *
 * ⚠ `responsibleId` — ПАРАМЕТР, а не необязательное поле: у системного дела `RESPONSIBLE_ID`
 * обязателен («The field RESPONSIBLE_ID is not defined or invalid»), тогда как у `todo.add` он
 * необязателен и мы его не шлём вовсе. Сделать его здесь необязательным значило бы собрать вызов,
 * который портал отвергнет, — на том самом портале, ради которого весь этот путь и написан.
 * Откуда берётся значение, решает транспорт.
 *
 * ⚠ Дело НЕ закрывается (`COMPLETED: 'N'`) — то же решение, что у основного носителя: закрытое
 * дело читается как «сделано, смотреть незачем», а платёж ждёт действия человека.
 *
 * ⚠ Время ставится ТРИЖДЫ одним значением намеренно. `DEADLINE` — то, по чему дело попадает в
 * «Дела» на нужный день; `START_TIME`/`END_TIME` — то, по чему оно встаёт в ленту. Не задай мы
 * последние, портал подставит момент ИМПОРТА, и выписка за прошлую неделю легла бы в ленту
 * сегодняшним днём.
 */
export function buildLegacyActivity(
  item: StatementItem,
  company: CrmCompanyRef,
  responsibleId: number,
  note?: string
): { fields: LegacyActivityFields } {
  const at = toPortalDeadline(item.acceptDate)
  return {
    fields: {
      OWNER_TYPE_ID: CRM_OWNER_TYPE_COMPANY,
      OWNER_ID: company.id,
      TYPE_ID: LEGACY_ACTIVITY_TYPE_TASK,
      SUBJECT: neutralizeBb(buildActivityTitle(item)).slice(0, MAX_TITLE_CHARS),
      DESCRIPTION: buildActivityDescription(item, note),
      DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB,
      COMPLETED: 'N',
      RESPONSIBLE_ID: responsibleId,
      START_TIME: at,
      END_TIME: at,
      DEADLINE: at,
      // Маркер дедупа — В ТОМ ЖЕ вызове и ИЗ ТОГО ЖЕ источника (см. шапку модуля).
      ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID,
      ORIGIN_ID: activityOriginId(item)
    }
  }
}

/**
 * Достать id созданного дела из ответа `crm.activity.add`.
 *
 * ⚠ Конверт ПЛОСКИЙ (`{result: 999}`), в отличие от `todo.add` (`{result:{id}}`) — читать его
 * чужим разборщиком нельзя: тот вернул бы `null`, то есть «ничего не записано», и каждый опрос
 * создавал бы дело заново. Нечисловое значение тоже `null`: это значит, что мы неверно прочитали
 * ответ, и принять его за успех — спрятать промах за зелёной джобой.
 */
export function extractLegacyActivityId(resp: Record<string, unknown>): string | null {
  const raw = resp?.result
  if (raw === undefined || raw === null) return null
  // ⚠ Отдельной проверки «это объект» здесь НЕТ намеренно: маска отвергает его сама
  // (`${{}}` → `[object Object]`), то есть вложенный конверт `todo.add` не пройдёт и так. Первая
  // редакция такую проверку несла — и она пережила мутацию «убрать её», то есть была недостижима.
  // Гард, который нельзя уронить, обещает защиту, которой не существует.
  return /^\d+$/.test(`${raw}`) ? `${raw}` : null
}
