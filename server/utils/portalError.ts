// Код ошибки Bitrix24, доживающий до вызывающего (#572).
//
// ⚠ До этого модуля код ошибки ТЕРЯЛСЯ. `makeSdkRestCall` бросал голый `new Error(...)` из
// `res.getErrorMessages()`, а тот возвращает только `e.message`. У SDK при этом код есть:
// `AjaxError.code = response.data.error` (замерено по `core/http/ajax-error.mjs`), но в
// `formatErrorMessage` он попадает ТОЛЬКО когда описания нет вовсе — а у настоящих ошибок портала
// оно есть всегда, и сообщение оказывается чистым описанием без кода.
//
// ⚠ Почему это не косметика. Портал отвечает описанием на ЯЗЫКЕ ПОРТАЛА, и единственный способ
// отличить «админ ошибся в имени поля» от «портал молчит» был разбор чужой локализованной строки —
// то есть проверка, которая завтра придёт по-английски и перестанет работать молча. Код
// (`INVALID_ARG_VALUE`) — машинный и стабильный.
//
// Модуль намеренно ЧИСТЫЙ и без импортов SDK: его читают и транспорт, и резолвер, и тесты.

/** Ошибка REST-вызова портала с сохранённым машинным кодом (`error` из тела ответа B24). */
export class PortalRestError extends Error {
  /** Код из тела ответа портала: `INVALID_ARG_VALUE`, `ACCESS_DENIED`, … Пустая строка — код
   *  не доехал (сетевой сбой, ошибка самого SDK). */
  readonly portalCode: string
  /** Метод, на котором это случилось — для лога; в сообщение НЕ подставляется, чтобы текст
   *  оставался тем же, что видел прежний код. */
  readonly method: string

  constructor(message: string, portalCode: string, method: string) {
    super(message)
    this.name = 'PortalRestError'
    this.portalCode = portalCode
    this.method = method
  }
}

/** Код ошибки портала, если он сохранился; иначе пустая строка. Принимает `unknown`, потому что
 *  до вызывающего ошибка доезжает через `catch`. */
export function portalErrorCode(e: unknown): string {
  return e instanceof PortalRestError ? e.portalCode : ''
}

/**
 * Портал отверг ФИЛЬТР: в нём поле, которого у сущности нет.
 *
 * Замерено на живом портале (2026-08-23, `crm.item.list` на сделке):
 *   `{"error":"INVALID_ARG_VALUE","error_description":"Invalid filter: field 'TOTALLY_BOGUS_FIELD'
 *    is not allowed in filter"}` — HTTP 400, одинаково для простого и для UF-поля.
 *
 * ⚠ Это состояние НАСТРОЙКИ, а не сбой: имя поля набирает администратор в «карте сопоставления»,
 * и пока он его не поправит, ответ будет тем же на каждой попытке. Ретраить бессмысленно.
 *
 * ⚠ Проверяем ТОЛЬКО код, а не текст описания. Описание приходит на языке портала и содержит имя
 * поля — сверять по нему значило бы завести проверку, которая молча перестанет срабатывать на
 * англоязычном портале.
 */
export function isFilterFieldRejected(e: unknown): boolean {
  return portalErrorCode(e) === 'INVALID_ARG_VALUE'
}

/** Минимум, который нужен от результата SDK, чтобы достать код. `getErrors` объявлен
 *  необязательным: у батч-результата его может не быть, и тогда код просто не доедет — это хуже,
 *  чем с кодом, но не хуже, чем было до этого модуля. */
export interface SdkErrorCarrier {
  getErrorMessages: () => string[]
  /** ⚠ Именно `Iterable`, а не массив: SDK отдаёт `IterableIterator<Error>` (значения `Map`), и
   *  объявление массивом ломает совместимость типов — поймано компиляторным дрейф-гардом
   *  `OAuthCallClient`, а не глазами. */
  getErrors?: () => Iterable<unknown>
}

/** Достать код первой ошибки результата SDK. Ошибки SDK — экземпляры `AjaxError` с полем `code`;
 *  читаем структурно (`{ code?: unknown }`), а не через `instanceof`, чтобы не тащить сюда импорт
 *  SDK и не ломаться на его мажорном обновлении. */
export function firstPortalErrorCode(res: SdkErrorCarrier): string {
  if (typeof res.getErrors !== 'function') return ''
  let errors: Iterable<unknown>
  try {
    errors = res.getErrors() ?? []
  } catch {
    // Аксессор SDK не обязан быть безопасным на всех формах результата, а потеря кода не должна
    // превращаться в потерю самой ошибки — вызывающий всё равно бросит по сообщению.
    return ''
  }
  for (const e of errors) {
    const code = (e as { code?: unknown })?.code
    if (typeof code === 'string' && code) return code
  }
  return ''
}
