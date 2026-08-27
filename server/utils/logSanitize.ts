// Shared log sanitizer for PROVIDER-CONTROLLED text (bank OAuth errors, upstream messages).
// Lives in its own module so both bank-connect halves (start + callback) can use one copy without
// importing each other. Strips CR/LF so an attacker-influenced message can't forge extra log lines,
// and caps the length so a huge upstream body can't flood the log.

/** Strip CR/LF and cap length — provider-controlled text is logged only through this. */
export function sanitizeForLog(s: string, max = 200): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, max)
}

/**
 * One-line diagnostic for a failed upstream call. ofetch's `FetchError.message` carries only
 * `[METHOD] "url": <status> <reason>` — the provider's own error envelope lives in `.data`, and
 * that is the half naming the offending field or header. Without it every 400 from the bank looks
 * identical in the log ("400 Bad Request"), which is exactly the case a preamble failure has to be
 * told apart from. Renders both through {@link sanitizeForLog}: the text is PROVIDER-CONTROLLED
 * and goes to the LOG only — the admin still gets our own opaque message.
 */
export function describeUpstreamError(e: unknown, max = 400): string {
  const err = e as { message?: unknown, data?: unknown } | null | undefined
  const message = typeof err?.message === 'string' ? err.message : 'error'
  const data = err?.data
  if (data === undefined || data === null) return sanitizeForLog(redactCredentials(message), max)
  let body: string
  try {
    body = typeof data === 'string' ? data : JSON.stringify(data) ?? String(data)
  } catch {
    // Circular / throwing toJSON — the message alone still identifies the step.
    body = '[unserializable]'
  }
  return sanitizeForLog(redactCredentials(`${message} :: ${body}`), max)
}

/**
 * Strip credentials an upstream may ECHO BACK at us before that text reaches the log.
 *
 * The reason this is not paranoia: under `private_key_jwt` our `client_assertion` — a signed,
 * short-lived credential — travels in the request body, and OAuth servers routinely quote the
 * offending parameter inside `error_description`. So the very error we now log can contain the
 * credential we just sent. The call sites state plainly that neither the secret nor the assertion
 * may be logged; a length cap does not enforce that, since the head of the string is exactly where
 * a quoted token lands.
 *
 * Matches the two shapes that carry a secret: a compact JWS (three base64url segments starting with
 * the `eyJ` of `{"`) and a `client_secret=` / `client_assertion=` form pair. Everything else is left
 * alone — over-redacting would blunt the diagnostic this function exists for.
 */
export function redactCredentials(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]')
    .replace(/((?:client_secret|client_assertion|refresh_token)=)[^&\s"']+/gi, '$1[redacted]')
}

/**
 * Вырезать из текста КОНКРЕТНЫЕ секреты, которые мы только что отправили (#649).
 *
 * ⚠ Шаблонов из `redactCredentials` тут НЕ ХВАТАЕТ, и это не перестраховка. Они ловят форму
 * (`client_secret=…`, JWT), а апстрим волен процитировать голое ЗНАЧЕНИЕ: `refresh token
 * 'AbCdEf…' already used` — ни одного шаблона не совпадёт. Это первое место в проекте, где в теле
 * запроса едет живой `refresh_token`: обмен по коду его не шлёт вовсе, поэтому прежним вызовам
 * такая редакция была не нужна.
 *
 * ⚠ Короткие значения НЕ вырезаем: пустая строка (у Приора `client_secret` может отсутствовать)
 * или двухсимвольный мусор превратили бы осмысленный текст в решето, а то и стёрли бы его целиком.
 */
export function redactValues(s: string, secrets: readonly string[]): string {
  let out = s
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
}
