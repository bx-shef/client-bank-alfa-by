// Сумма в том виде, в каком валюту показывает САМ портал (#729).
//
// ЗАЧЕМ. Сперва здесь стоял штатный `Intl` со `style:'currency'`, и на живом портале он выдал
// «1 840,50 BYN» рядом с «29,00 ₽» — то есть основная валюта белорусского клиента выглядела
// неотформатированной ровно там, где рублёвая выглядела нормально. Причина в том, что `Intl` знает
// СВОЙ справочник CLDR, а Bitrix24 держит свой, и у BYN там подпись «руб.», которой в CLDR нет.
//
// ЗАМЕРЕНО на живом портале 2026-09-16 (`crm.currency.list`):
//   BYN → `# руб.`   RUB → `# &#8381;`   USD → `$#`   EUR → `# &euro;`
// Отсюда три вывода, каждый из которых ломает наивную реализацию:
//   1) подпись бывает СЛЕВА (`$#`) — «число, пробел, символ» верно не всегда;
//   2) в строке живут HTML-сущности (`&#8381;`, `&euro;`), их надо раскрывать;
//   3) сущность СОДЕРЖИТ решётку, то есть плейсхолдер `#` нельзя заменять простым `replace`.
//
// ⚠ ГРУППИРОВКУ ЧИСЛА БЕРЁМ СВОЮ, А НЕ ПОРТАЛЬНУЮ, и это осознанное расхождение. Портал отдаёт
// `THOUSANDS_SEP: null` и `DEC_POINT: "."`, то есть по его же настройкам вышло бы «1840.50 руб.» —
// без разделения разрядов, ровно то «нет форматирования», с которого всё началось. Берём ru-RU
// (неразрывный пробел + запятая) и подставляем в ПОРТАЛЬНЫЙ шаблон: подпись и её место — от
// портала, читаемость числа — наша.
//
// ⚠ ПОРТАЛ МОЖЕТ И НЕ ОТВЕТИТЬ, и тогда мы не падаем. Именно за падение отвергнут
// `CurrencyManager.format` из jssdk: он **бросает** `UnhandledMatchError` на валюту, которой на
// портале нет, — а валюту мы берём из ВЫПИСКИ, а не из CRM, поэтому рублёвый платёж на портале с
// одной BYN уронил бы запись дела целиком. Здесь неизвестная валюта и недоступный справочник дают
// запасной вид «1 840,50 BYN»: хуже подписью, но дело записано.

/** Как портал описывает одну валюту. Нужны ровно два поля из `crm.currency.list`. */
export interface PortalCurrencyFormat {
  /** Шаблон с плейсхолдером `#` на месте числа, напр. `# руб.` или `$#`. */
  formatString: string
  /** Сколько знаков после запятой. */
  decimals: number
}

/** Справочник валют портала: код → формат. */
export type PortalCurrencyFormats = Record<string, PortalCurrencyFormat>

/** Именованные сущности, которые встречаются в шаблонах валют Bitrix24. Список КОРОТКИЙ и закрытый:
 *  общий HTML-декодер здесь был бы лишней поверхностью — строка приходит из справочника портала,
 *  а не от пользователя, и набор подписей у валют конечен. */
const NAMED_ENTITIES: Record<string, string> = {
  euro: '€', pound: '£', yen: '¥', cent: '¢', dollar: '$', nbsp: ' ', amp: '&'
}

/**
 * Раскрыть HTML-сущности в подписи валюты (`&#8381;` → `₽`, `&euro;` → `€`).
 *
 * ⚠ Числовая форма разбирается и в десятичном, и в шестнадцатеричном виде: у Bitrix встречается
 * `&#8381;`, но гарантий, что не появится `&#x20BD;`, нет никаких.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
}

/** Число по-русски: неразрывный пробел между разрядами, запятая перед копейками. */
function formatNumber(value: number, decimals: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals
  }).format(Number.isFinite(value) ? value : 0)
}

/**
 * Подставить число в шаблон портала.
 *
 * ⚠ Плейсхолдер `#` заменяется НЕ напрямую: сама подпись бывает сущностью `&#8381;`, где решётка
 * стоит второй, и наивный `replace('#', …)` подставил бы число ВНУТРЬ кода символа, превратив
 * «29,00 ₽» в мусор. Экранируем `&#` на время замены — тот же приём, что у самого SDK.
 */
export function applyFormatString(formatString: string, formattedNumber: string): string {
  // \u0000 экранированием, а не литералом: сырые NUL-байты делают исходник «бинарным»
  // для grep и прочих инструментов, хотя как страж работают.
  const GUARD = '\u0000ENT\u0000'
  const guarded = formatString.replaceAll('&#', GUARD)
  const filled = guarded.includes('#')
    ? guarded.replace('#', formattedNumber)
    // Шаблон без плейсхолдера — такого быть не должно, но молча потерять СУММУ нельзя.
    : `${formattedNumber} ${guarded}`.trim()
  return decodeEntities(filled.replaceAll(GUARD, '&#')).trim()
}

/**
 * Сумма с валютой для карточки дела.
 *
 * `formats` — справочник портала; пустой или без нужной валюты ⇒ запасной вид «1 840,50 BYN».
 */
export function formatAmountWithPortal(
  amount: number,
  currency: string,
  formats?: PortalCurrencyFormats
): string {
  const code = (currency ?? '').trim().toUpperCase()
  const known = code && formats ? formats[code] : undefined
  if (known && known.formatString) {
    return applyFormatString(known.formatString, formatNumber(amount, known.decimals))
  }
  const number = formatNumber(amount, 2)
  // \u00A0 экранированием, а не литералом: неразрывный пробел в исходнике неотличим от обычного.
  return code ? `${number}\u00A0${code}` : number
}
