// Период показа «Последних операций» на `/app` (#42): день / 2 дня / 3 дня / неделя / месяц /
// квартал / год / произвольный диапазон + подпись «за какой период показано».
//
// ⚠ ЗАЧЕМ. Витрина брала последние 50 элементов реестра БЕЗ привязки к датам, и подписи об этом не
// было вовсе: человек видел список и не мог сказать, за какой он срок — а сводка и график над ним
// считались по тому же набору, то есть числа тоже были «за неизвестно что». Отсюда две вещи сразу:
// выбор периода и ЕГО НАЗВАНИЕ на экране.
//
// ⚠ Отбор идёт по ДАТЕ ОПЕРАЦИИ, а не по времени создания элемента. Ручная загрузка старой выписки
// создаёт свежие элементы старых операций, и «за неделю» по времени создания показало бы платежи
// годичной давности — бухгалтер спрашивает про календарь банка, а не про порядок нашей записи.
//
// ⚠ Вся арифметика — над строкой `ГГГГ-ММ-ДД` через `Date.UTC`, как в `dayValue.ts`: у пояса
// восточнее UTC локальные `Date`-вычисления сдвигают границу суток, и «за сегодня» у бухгалтера в
// Минске означало бы вчера. День «сегодня» вызывающий берёт по СВОИМ локальным часам
// (`todayIsoDay`) — период это человеческий календарь, а не UTC.

import { isIsoDay, toIsoDay } from '~/utils/dayValue'

/** Пресеты периода. `custom` — произвольный диапазон, границы задаёт человек. */
export type OperationPeriodPreset = 'day' | 'days2' | 'days3' | 'week' | 'month' | 'quarter' | 'year' | 'custom'

/** Диапазон дней ВКЛЮЧИТЕЛЬНО с обеих сторон (проверено на живом портале: `crm.item.list` с
 *  `>=`/`<=` по полю типа `date` включает обе границы). Пустая строка — граница не задана. */
export interface DayRange {
  from: string
  to: string
}

interface PresetSpec {
  value: OperationPeriodPreset
  label: string
  /** Сколько КАЛЕНДАРНЫХ дней покрывает период, считая сегодняшний. `null` — у `custom` длины нет. */
  days: number | null
}

/**
 * Порядок — по возрастанию срока, как их перечислил владелец. `custom` последним: это не «ещё один
 * срок», а переход к ручному выбору, и стоять он должен после готовых.
 *
 * ⚠ Длина считает СЕГОДНЯШНИЙ день: «2 дня» — это сегодня и вчера, а не «двое суток назад». Иначе
 * подпись «за 2 дня» показывала бы три календарных дня.
 */
export const OPERATION_PERIOD_PRESETS: readonly PresetSpec[] = [
  { value: 'day', label: 'День', days: 1 },
  { value: 'days2', label: '2 дня', days: 2 },
  { value: 'days3', label: '3 дня', days: 3 },
  { value: 'week', label: 'Неделя', days: 7 },
  { value: 'month', label: 'Месяц', days: 30 },
  { value: 'quarter', label: 'Квартал', days: 90 },
  { value: 'year', label: 'Год', days: 365 },
  { value: 'custom', label: 'Диапазон', days: null }
]

/** Период по умолчанию. Месяц — компромисс: короче даёт пустой экран порталу, который импортирует
 *  раз в неделю, длиннее упирается в страницу реестра и подпись «показаны не все». */
export const DEFAULT_OPERATION_PERIOD: OperationPeriodPreset = 'month'

/** Сегодняшний день по ЛОКАЛЬНЫМ часам (`ГГГГ-ММ-ДД`). Именно локальным: период — календарь
 *  человека, а не пояс сервера. */
export function todayIsoDay(now: Date = new Date()): string {
  return toIsoDay({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() })
}

/** Сдвиг дня на `delta` суток. Арифметика в UTC над календарной датой — пояс не участвует. */
export function shiftIsoDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  return toIsoDay({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() })
}

/**
 * Границы периода. Для пресетов — `[сегодня-(N-1); сегодня]`; для `custom` — то, что выбрал человек.
 *
 * ⚠ У `custom` пустая граница допустима и означает «без ограничения с этой стороны» — так же, как в
 * разделе очистки. Подставить сегодняшний день за человека нельзя: он мог намеренно спросить «всё,
 * что старше такой-то даты».
 * ⚠ Перевёрнутый диапазон НЕ чиним молчаливой перестановкой: `DayRangeField` сделать его не даёт,
 * а пришедший снаружи (адрес, будущая правка) лучше вернуть как есть — пустой ответ честнее, чем
 * период, которого не просили.
 */
export function operationPeriodRange(
  preset: OperationPeriodPreset,
  today: string,
  custom: DayRange = { from: '', to: '' }
): DayRange {
  if (preset === 'custom') return { from: custom.from, to: custom.to }
  const spec = OPERATION_PERIOD_PRESETS.find(p => p.value === preset)
  const days = spec?.days ?? 1
  return { from: shiftIsoDay(today, -(days - 1)), to: today }
}

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
] as const

/** «26 августа 2026». Невалидный день отдаётся как есть — подпись не место для исключений. */
export function formatIsoDayRu(day: string): string {
  if (!isIsoDay(day)) return day
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTHS_GENITIVE[m - 1]} ${y}`
}

/**
 * Подпись «за какой период показано» — ради неё задача и заведена: список без названия срока не
 * отвечает на вопрос, который бухгалтер задаёт первым.
 *
 * Формы: один день — «за 26 августа 2026»; обе границы — «с … по …»; одна — «с …» / «по …»;
 * ни одной — «за всё время».
 */
export function operationPeriodCaption(range: DayRange): string {
  const from = range.from.trim()
  const to = range.to.trim()
  if (!from && !to) return 'за всё время'
  if (from && to) {
    return from === to
      ? `за ${formatIsoDayRu(from)}`
      : `с ${formatIsoDayRu(from)} по ${formatIsoDayRu(to)}`
  }
  return from ? `с ${formatIsoDayRu(from)}` : `по ${formatIsoDayRu(to)}`
}

/**
 * Годится ли диапазон для запроса. Пустые границы допустимы, заполненная обязана быть настоящим
 * днём, а начало — не позже конца.
 *
 * ⚠ Кривой день — ОТКАЗ, а не «спросим без фильтра»: молча отброшенная граница РАСШИРЯЕТ период, и
 * человек увидел бы чужой срок под своей подписью.
 */
export function isValidDayRange(range: DayRange): boolean {
  if (range.from && !isIsoDay(range.from)) return false
  if (range.to && !isIsoDay(range.to)) return false
  return !(range.from && range.to && range.from > range.to)
}
