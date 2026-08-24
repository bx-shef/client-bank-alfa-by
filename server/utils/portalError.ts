// The Bitrix24 error CODE, surviving all the way to the caller (#572).
//
// ⚠ Before this module the code was LOST. `makeSdkRestCall` threw a bare `new Error(...)` built from
// `res.getErrorMessages()`, and that accessor returns only `e.message`. The SDK does carry the code —
// `AjaxError.code = response.data.error` (read off `core/http/ajax-error.mjs`) — but its
// `formatErrorMessage` folds the code into the message ONLY when there is no description, and a real
// portal error always has one. So the message arrived as a clean description with no code.
//
// ⚠ Why that is not cosmetic: the portal answers with a description in the PORTAL'S language, so the
// only way to tell «the admin mistyped a setting» from «the portal is down» was to parse a foreign
// localized string — a check that silently stops working the day it arrives in another language.
//
// Deliberately PURE and free of SDK imports: the transport, the resolver and the tests all read it.

/** A portal REST failure that kept its machine-readable code (`error` from the B24 response body). */
export class PortalRestError extends Error {
  /**
   * The code from the portal response body: `INVALID_ARG_VALUE`, `NOT_FOUND`, `ACCESS_DENIED`, …
   * Empty when no code arrived (a network failure, or an SDK-internal error).
   *
   * ⚠ Named `code`, NOT `portalCode`, and that is load-bearing rather than taste. `errorKind()`
   * (`telemetrySpan.ts`) reads `e.code ?? e.name`; under any other name it would fall through to
   * `.name` and stamp EVERY single-call SDK failure across the whole app as `PortalRestError` —
   * one flat label replacing the previous `Error`, while the one genuinely useful value (the portal
   * code) never reached telemetry at all. With this name `error_kind` becomes the portal code, which
   * is a class rather than data and therefore safe to record.
   */
  readonly code: string
  /** The method it happened on — for logs. Deliberately NOT interpolated into the message, so the
   *  text stays exactly what the pre-#572 code produced (`classifyProvisionError` matches on it). */
  readonly method: string

  constructor(message: string, code: string, method: string) {
    super(message)
    this.name = 'PortalRestError'
    this.code = code
    this.method = method
  }
}

/**
 * The portal error code, or an empty string. Takes `unknown` — the error reaches the caller through
 * a `catch`.
 *
 * ⚠ It reads the code from ANY error shape, and that is the whole point rather than defensiveness.
 * The first draft looked only at `PortalRestError` and was DEAD CODE for the main case: the SDK
 * splits codes into soft and hard, and `INVALID_ARG_VALUE` is HARD. Measured against the pinned
 * version — `RestrictionManager.BUILT_IN_HARD_ERROR_CODES.includes('INVALID_ARG_VALUE') === true`,
 * `BUILT_IN_SOFT_ERROR_CODES` → `false` — and `abstract-http.mjs` returns a failed result ONLY for
 * soft codes (`exceptionCodeForSoft.includes(lastError.code)`), otherwise `throw lastError`. So our
 * transport's `!res.isSuccess` branch is never reached for this case at all: a raw `AjaxError`
 * propagates instead. Caught in review; the unit tests missed it because they hand-built
 * `PortalRestError` instances and never exercised the real throw path.
 *
 * ⚠ Read STRUCTURALLY rather than via `instanceof AjaxError`: an SDK import does not belong in a
 * pure module, and on a major SDK bump a structural read degrades to «no code» instead of failing
 * to compile somewhere unexpected.
 */
export function portalErrorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && code && code !== SDK_WRAPPER_CODE) return code
  // ⚠ MEASURED, and this is the SECOND time the same trap was walked into (#574). The SDK wraps any
  // error that is neither `AjaxError` nor `AxiosError` into `AjaxError{code:'JSSDK_UNKNOWN_ERROR',
  // originalError: <the real one>}` (`abstract-http.mjs::_convertUnknownErrorToAjaxError`). The
  // dead-grant case goes exactly there: `RefreshTokenError` extends `SdkError` as a SIBLING of
  // `AjaxError`, so `new RefreshTokenError(...) instanceof AjaxError === false` (verified by
  // running the pinned 2.0.0). Without unwrapping, `invalid_grant` reaches every caller as
  // `JSSDK_UNKNOWN_ERROR` and the reaper's hot-path signal is dead code.
  //
  // ⚠ ONE level of unwrapping, not a loop: the SDK nests exactly once, and an unbounded walk would
  // invent a contract nothing guarantees (and could loop on a self-referencing `originalError`).
  const inner = (e as { originalError?: { code?: unknown } } | null | undefined)?.originalError?.code
  if (typeof inner === 'string' && inner) return inner
  return typeof code === 'string' ? code : ''
}

/** The code the SDK stamps on anything it could not classify — the real code is in `originalError`. */
const SDK_WRAPPER_CODE = 'JSSDK_UNKNOWN_ERROR'

/**
 * Portal error codes that mean «the ADMIN's recognition-map setting is wrong», per lookup shape.
 *
 * ⚠ The two sets differ because the admin-supplied parameter differs, and conflating them would
 * misclassify. All values below are MEASURED live (2026-08-23, `crm.item.list`):
 *
 *  - a field name the entity does not have →
 *    `INVALID_ARG_VALUE` / «Invalid filter: field 'X' is not allowed in filter» (HTTP 400, identical
 *    for a plain and a UF field). This is what `deal-field`/`smart-field` get wrong.
 *  - a smart process that does not exist → `NOT_FOUND` / «Смарт-процесс не найден»;
 *    `entityTypeId: 0` → `ENTITY_TYPE_NOT_SUPPORTED`. This is what `smart-entity` gets wrong, and it
 *    is the ONLY admin-supplied parameter on the `smart-id` path — its filter is `{id, companyId}`,
 *    with no field name in it at all.
 *
 * ⚠ The first draft wrapped all three kinds with the filter-field set alone. Measurement showed that
 * would never have fired for `smart-id`: a bad `entityTypeId` answers `NOT_FOUND`, so the realistic
 * admin mistake there stayed a job-killing retry loop while the unit tests were green.
 *
 * ⚠ `NOT_FOUND` is NOT in the deal set on purpose. On the deal path `entityTypeId` is our own
 * constant (2), so `NOT_FOUND` there would mean something else entirely — and swallowing it would
 * hide OUR bug behind «check your settings».
 */
const FIELD_MISCONFIG_CODES = ['INVALID_ARG_VALUE'] as const
const ENTITY_MISCONFIG_CODES = ['INVALID_ARG_VALUE', 'NOT_FOUND', 'ENTITY_TYPE_NOT_SUPPORTED'] as const

/** Which admin-supplied parameter a lookup depends on — picks the code set above. */
export type ConfiguredParam = 'field' | 'entity'

/**
 * Did the portal reject the lookup because of an admin-supplied setting?
 *
 * ⚠ HONEST LIMIT: `INVALID_ARG_VALUE` is Bitrix's GENERIC invalid-argument code, not a
 * filter-field-specific one — a value of the wrong type against an otherwise-correct field raises it
 * too. So this answers «the portal refused arguments we built from settings», and the message built
 * on it must NOT assert one single cause. `buildSettingsErrorMessage` is written accordingly.
 *
 * ⚠ Matched on the CODE only, never on the description: the description arrives in the portal's
 * language and embeds the field name.
 */
export function isSettingsRejection(e: unknown, param: ConfiguredParam): boolean {
  const code = portalErrorCode(e)
  if (!code) return false
  const codes: readonly string[] = param === 'entity' ? ENTITY_MISCONFIG_CODES : FIELD_MISCONFIG_CODES
  return codes.includes(code)
}

/** The minimum we need from an SDK result to read a code. `getErrors` is optional so a future SDK
 *  shape that drops it degrades to «no code» rather than failing to typecheck. */
export interface SdkErrorCarrier {
  getErrorMessages: () => string[]
  /** ⚠ `Iterable`, not an array: the SDK returns `IterableIterator<Error>` (Map values), and
   *  declaring an array breaks type compatibility — caught by the `OAuthCallClient` compile-time
   *  drift guard, not by eye. */
  getErrors?: () => Iterable<unknown>
}

/**
 * The code of the first error on an SDK result, read structurally.
 *
 * ⚠ The ITERATION sits inside the `try`, not just the accessor call. Guarding only the call left the
 * same class of risk open: a `getErrors()` returning a non-iterable (or a lazy generator throwing
 * mid-iteration) would raise a `TypeError` here — and this runs inside the transport's error branch,
 * so that `TypeError` would REPLACE the `PortalRestError` being built and destroy the original
 * portal message too. Strictly worse than the pre-#572 behaviour.
 */
export function firstPortalErrorCode(res: SdkErrorCarrier): string {
  if (typeof res.getErrors !== 'function') return ''
  try {
    for (const e of res.getErrors() ?? []) {
      const code = (e as { code?: unknown })?.code
      if (typeof code === 'string' && code) return code
    }
  } catch {
    // Losing the code must never become losing the error itself: the caller still throws with the
    // message, just without classification.
    return ''
  }
  return ''
}
