// Shared log sanitizer for PROVIDER-CONTROLLED text (bank OAuth errors, upstream messages).
// Lives in its own module so both bank-connect halves (start + callback) can use one copy without
// importing each other. Strips CR/LF so an attacker-influenced message can't forge extra log lines,
// and caps the length so a huge upstream body can't flood the log.

/** Strip CR/LF and cap length — provider-controlled text is logged only through this. */
export function sanitizeForLog(s: string, max = 200): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, max)
}
