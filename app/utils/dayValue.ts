// Один день как строка `ГГГГ-ММ-ДД` — общий словарь для календаря в интерфейсе и для проверки на
// сервере (#592: ручной забор выписки за выбранный день).
//
// ⚠ Чистый модуль без Date-арифметики над локальным временем: сравнение дней идёт ЛЕКСИКОГРАФИЧЕСКИ
// по `ГГГГ-ММ-ДД`, что для этого формата равносильно сравнению дат и не зависит от часового пояса
// процесса. Иначе «не в будущем» означало бы разное на сервере (UTC) и в браузере бухгалтера
// (UTC+3): день, наступивший в Минске, но ещё не наступивший в UTC, интерфейс предлагал бы, а
// сервер отвергал — и выглядело бы это поломкой кнопки, а не границей суток.

/** Максимальный возраст запрашиваемого дня. Верхняя граница нужна не банку, а нам: опечатка в годе
 *  («1926-08-17») иначе молча сжигает запрос из общего лимита банка и возвращает пустоту. */
export const MAX_POLL_DAY_AGE_DAYS = 730

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Строка похожа на день И описывает существующую дату (31 февраля — не день). */
export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Части календаря b24ui → `ГГГГ-ММ-ДД`. */
export function toIsoDay(parts: { year: number, month: number, day: number }): string {
  const p = (n: number, w: number) => String(n).padStart(w, '0')
  return `${p(parts.year, 4)}-${p(parts.month, 2)}-${p(parts.day, 2)}`
}

/** День по метке времени в UTC — тем же способом, каким его считает окно опроса. */
export function isoDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export type DayVerdict = 'ok' | 'malformed' | 'future' | 'too-old'

/**
 * Годится ли день для ручного забора. `today` — день «сейчас» в UTC (`isoDayFromMs`).
 *
 * ⚠ Сегодняшний день РАЗРЕШЁН: банк отдаёт операции текущих суток по мере их появления, и запретить
 * его значило бы убрать самый частый случай — «провёл платёж, хочу увидеть его сейчас».
 */
export function pollDayVerdict(day: string, today: string): DayVerdict {
  if (!isIsoDay(day)) return 'malformed'
  if (day > today) return 'future'
  const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000)
  return ageDays > MAX_POLL_DAY_AGE_DAYS ? 'too-old' : 'ok'
}

/** Человеческое объяснение отказа — одно на сервер и интерфейс, чтобы они не разошлись. */
export function dayVerdictMessage(verdict: DayVerdict): string {
  switch (verdict) {
    case 'malformed': return 'Дата не распознана — выберите день в календаре.'
    case 'future': return 'День ещё не наступил — выберите сегодняшний или прошедший.'
    case 'too-old': return `Слишком давно — банк отдаёт выписку не глубже ${MAX_POLL_DAY_AGE_DAYS} дней.`
    case 'ok': return ''
  }
}
