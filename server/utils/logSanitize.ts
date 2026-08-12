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
  if (data === undefined || data === null) return sanitizeForLog(message, max)
  let body: string
  try {
    body = typeof data === 'string' ? data : JSON.stringify(data) ?? String(data)
  } catch {
    // Circular / throwing toJSON — the message alone still identifies the step.
    body = '[unserializable]'
  }
  return sanitizeForLog(`${message} :: ${body}`, max)
}
