// Pure recognition of entity identifiers from a payment purpose (назначение),
// per docs/PROCESSING.md §4 «Распознавание из назначения». A configurable set of
// trigger phrases each maps the NUMBER that follows it to a kind of entity
// identifier. No I/O: the id→entity lookup (invoice by number/id, deal, order,
// payment, smart-process element, or a document-generator bridge) is the REST
// slice; this module only extracts (phrase → identifier) so it unit-tests on
// plain strings. Phrases come from per-portal settings — the module is
// config-driven and ships no hard-coded Russian phrases.

/**
 * What an extracted number identifies (§4). The lookup uses this to pick the
 * right REST search — e.g. an invoice by its number vs by its id, or a deal by a
 * per-direction custom field. `document-number` is a bridge: find the generated
 * document, then follow its `entityTypeId`/`entityId` to the real entity.
 */
export type IdentifierKind
  = | 'invoice-number' | 'invoice-id'
    | 'deal-id' | 'deal-field'
    | 'order-id' | 'order-number'
    | 'payment-id' | 'payment-number'
    | 'smart-id' | 'smart-field'
    | 'document-number'

/**
 * One recognition rule: any of `phrases` (matched case-insensitively) directly
 * preceding a number marks that number as an identifier of `kind`. Phrases are
 * supplied from the per-portal «карта сопоставления» (§4).
 */
export interface RecognitionRule {
  phrases: string[]
  kind: IdentifierKind
}

/** A recognized identifier: its kind and the extracted value (kept as a string —
 *  leading zeros / composite forms like `123/45` must survive). */
export interface RecognizedId {
  kind: IdentifierKind
  value: string
}

/** Escape a phrase for safe embedding in a RegExp (phrases are arbitrary text). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Left word boundary: the phrase must not start INSIDE another word. Cyrillic is
// invisible to `\b` (ASCII-only in JS), so we use a Unicode lookbehind — "счёт"
// then does NOT match inside "расчёту" (very common in RU/BY purposes).
const WORD_START = '(?<!\\p{L})'
// Between the phrase and the number: optional separators (space, colon, №, #,
// dot, dash). The class holds no letters, so a letter right after the phrase
// blocks the match: "счёт-фактура 12" yields nothing, and so do declined forms
// ("счёту 55") — configure the exact form/variants as phrases (§4). No ё/е or
// case folding beyond the RegExp `i` flag: the phrase must match as written.
const SEPARATORS = '[\\s:№#.\\-]*'
// The identifier itself: digits, optionally grouped with `/` or `-` (e.g. 123/45).
const TOKEN = '(\\d+(?:[/-]\\d+)*)'

/** Upper bound on the purpose length we scan — DoS guard, matches the parser
 *  convention (cf. `MAX_CLIENT_BANK_CHARS`). Real purposes are far shorter. */
export const MAX_PURPOSE_CHARS = 10_000
/** Reject absurdly long extracted values — real ids/numbers are short; a huge
 *  digit run is noise (and would lose precision if later coerced to a number). */
export const MAX_ID_CHARS = 64

/**
 * Extract every identifier recognized in `purpose` under `rules`. Order is:
 * by rule, then by phrase (as listed in the rule), then by in-string position
 * within that phrase. Duplicates (same kind AND value) are dropped. Returns an
 * empty array when nothing matches (caller falls back to §2/§5 "нет
 * идентификатора"). Never throws for malformed input.
 */
export function recognizeIdentifiers(
  purpose: string,
  rules: readonly RecognitionRule[]
): RecognizedId[] {
  // DoS guard: scan at most MAX_PURPOSE_CHARS (bank/attacker-controlled text).
  const hay = purpose.length > MAX_PURPOSE_CHARS ? purpose.slice(0, MAX_PURPOSE_CHARS) : purpose
  const out: RecognizedId[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    for (const phrase of rule.phrases) {
      const p = phrase.trim()
      if (!p) continue
      const re = new RegExp(WORD_START + escapeRegExp(p) + SEPARATORS + TOKEN, 'giu')
      for (const m of hay.matchAll(re)) {
        const value = m[1]!
        if (value.length > MAX_ID_CHARS) continue
        const key = `${rule.kind}|${value}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: rule.kind, value })
      }
    }
  }
  return out
}
