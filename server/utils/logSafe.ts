// Pure log-sanitizer for untrusted strings that get interpolated into console
// lines (bank statement fields, uploaded file names, admin-authored app.option
// mask literals). Strips Unicode control + format characters — CR/LF included —
// so a crafted value can't inject a fake log line (log forging / CWE-117), and
// caps length so one field can't flood a line. Extracted from the queue worker so
// it is unit-testable without importing the side-effectful worker module (#242).

/** Replace every control/format char (incl. CR, LF, NUL, ANSI escapes) with a
 *  space and truncate to `max` chars. Pure — no I/O.
 *
 *  ⚠ `Zl`/`Zp` тоже вычищаются (U+2028/U+2029), хотя в `Cc`/`Cf` они не входят: часть читателей
 *  лога считает их переводом строки, а значение сюда попадает и от АПСТРИМА (ответ банка, #649),
 *  то есть от стороны, которой выгодно подделать вторую строку. Unix-инструменты, которыми
 *  оперирует рантбук, их разделителем не считают — но полагаться на потребителя там, где правило
 *  формулируется в одну категорию, незачем. */
export function logSafe(s: string, max = 128): string {
  return String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, max)
}
