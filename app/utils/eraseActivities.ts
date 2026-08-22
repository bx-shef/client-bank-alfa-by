// Чистое ядро «стереть дела, созданные приложением» (#576 п.4).
//
// ⚠ ЗАЧЕМ. На неподготовленном портале приложение записывает дела в «мою компанию» — клиент по
// счёту не опознан, и это штатный фолбэк (#91). За несколько суток их накапливаются сотни, и
// убрать их из CRM было нечем: руками это столько же кликов, сколько дел. Владелец просит кнопку.
//
// ⚠ ДЕЙСТВИЕ НЕОБРАТИМО, поэтому всё в этом модуле построено вокруг одного вопроса: можно ли
// случайно удалить ЧУЖОЕ. Отсюда две границы, а не одна:
//   1. в фильтр запроса ВСЕГДА уходит наш `ORIGINATOR_ID` — без него список вернул бы все дела
//      портала, включая звонки и встречи сотрудников;
//   2. удаляются только те строки, у которых `ORIGINATOR_ID` совпал В ОТВЕТЕ. Вторая проверка
//      существует именно потому, что первая — это наш собственный код: ошибка в сборке фильтра
//      иначе означала бы удаление чужих дел, а не пустой результат.
//
// ⚠ Отбор по НАШЕМУ счёту делается ЗДЕСЬ, а не фильтром B24. Маркер операции — это
// `<наш счёт>|<id операции>` (`dedupKey`), то есть счёт лежит префиксом в `ORIGIN_ID`, и его
// можно было бы искать подстрочным фильтром. Но подстрока у B24 — именно ПОДСТРОКА, а не префикс
// (замерено на живом портале): счёт, оказавшийся внутри чужого идентификатора, дал бы совпадение.
// Для необратимого действия это неприемлемо, поэтому B24 сужает по своему (`ORIGINATOR_ID` + даты),
// а точное сравнение по счёту делает эта функция.

import { ACTIVITY_ORIGIN } from './activity'

/**
 * Период стирания. Обе границы НЕОБЯЗАТЕЛЬНЫ, и это все четыре формы, которые просил владелец:
 * ни одной (всё), только `from`, только `to`, обе.
 *
 * Даты — календарные `YYYY-MM-DD`. ⚠ Не момент времени: у дела в `DEADLINE` лежит дата операции,
 * которую назвал банк, и трактовать её через часовые пояса значило бы стирать не тот день.
 */
export interface ErasePeriod {
  from?: string
  to?: string
}

/** Что именно стираем. */
export interface EraseSelection {
  period: ErasePeriod
  /**
   * НАШИ счета, по которым стираем. Пустой список ⇒ по всем.
   *
   * ⚠ «Банк» отдельным полем НЕ передаётся намеренно: выбор банка на экране разворачивается в
   * список его счетов ещё в браузере. Иначе серверу пришлось бы знать соответствие счёт↔банк в
   * момент стирания, а оно живёт в таблице подключений — и отключённый вчера счёт перестал бы
   * попадать под «стереть всё по этому банку» ровно тогда, когда это нужнее всего.
   */
  accounts: string[]
}

/** Строка дела, как её отдаёт `crm.activity.list` с нашим `select`. */
export interface ActivityRow {
  id: string
  originatorId: string
  originId: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Календарная дата `YYYY-MM-DD`? */
export function isCalendarDay(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v)
}

/**
 * Разобрать период из недоверенного ввода. Возвращает `null`, если ввод не описывает период —
 * и это ОТКАЗ, а не «сотрём всё»: пустой период означает «все дела», поэтому кривая дата, молча
 * превращённая в пустоту, расширила бы стирание вместо того, чтобы его сузить.
 */
export function parsePeriod(raw: { from?: unknown, to?: unknown }): ErasePeriod | null {
  const from = raw?.from
  const to = raw?.to
  const okFrom = from === undefined || from === null || from === '' || isCalendarDay(from)
  const okTo = to === undefined || to === null || to === '' || isCalendarDay(to)
  if (!okFrom || !okTo) return null
  const period: ErasePeriod = {}
  if (isCalendarDay(from)) period.from = from
  if (isCalendarDay(to)) period.to = to
  // ⚠ Перевёрнутый период — тоже отказ. `from > to` не выбирает ничего, и «удалили 0 дел» человек
  // прочитает как «нечего было удалять», хотя на самом деле он опечатался в дате.
  if (period.from && period.to && period.from > period.to) return null
  return period
}

/**
 * Фильтр для `crm.activity.list`.
 *
 * ⚠ `ORIGINATOR_ID` подставляется ВСЕГДА и не берётся из аргументов: он и есть граница между
 * «нашими» делами и всей остальной CRM клиента. Сделать его параметром значило бы дать
 * вызывающему возможность её убрать.
 */
export function buildEraseListFilter(period: ErasePeriod): Record<string, unknown> {
  const filter: Record<string, unknown> = { ORIGINATOR_ID: ACTIVITY_ORIGIN }
  // Дата операции лежит в `DEADLINE` (её ставит `toPortalDeadline`), поэтому период — по нему.
  if (period.from) filter['>=DEADLINE'] = `${period.from}T00:00:00`
  if (period.to) filter['<=DEADLINE'] = `${period.to}T23:59:59`
  return filter
}

/** Наш счёт из маркера операции (`<счёт>|<id>`); пустая строка, если маркер не той формы. */
export function accountOfOrigin(originId: string): string {
  const i = originId.indexOf('|')
  return i > 0 ? originId.slice(0, i) : ''
}

/**
 * Отобрать строки, которые действительно можно удалить.
 *
 * ⚠ ВТОРАЯ граница безопасности, и она не дублирует первую. Первая (фильтр) — наш код, вторая
 * смотрит на то, что ОТВЕТИЛ портал: строка без нашего `ORIGINATOR_ID` не удаляется, даже если
 * она пришла в ответе. Ошибка в сборке фильтра тогда даёт пустой результат, а не удаление чужих
 * звонков и встреч.
 */
export function selectDeletable(rows: readonly ActivityRow[], selection: EraseSelection): ActivityRow[] {
  const wanted = new Set(selection.accounts.filter(a => a !== ''))
  return rows.filter((r) => {
    if (r.originatorId !== ACTIVITY_ORIGIN) return false
    if (!r.id) return false
    if (wanted.size === 0) return true
    // Точное сравнение счёта, а не «содержит»: см. шапку модуля.
    return wanted.has(accountOfOrigin(r.originId))
  })
}

/** Человеческая подпись выбранного периода — её показывают в подтверждении. */
export function periodLabel(period: ErasePeriod): string {
  if (period.from && period.to) return `с ${period.from} по ${period.to}`
  if (period.from) return `с ${period.from}`
  if (period.to) return `по ${period.to}`
  return 'за всё время'
}
