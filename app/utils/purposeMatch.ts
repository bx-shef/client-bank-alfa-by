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

// Between the phrase and the number: optional separators (space, colon, №, #,
// dot, dash). Because the class holds no letters, "счёт-фактура 12" will NOT
// yield 12 for the phrase "счёт" — the number must adjoin the phrase.
const SEPARATORS = '[\\s:№#.\\-]*'
// The identifier itself: digits, optionally grouped with `/` or `-` (e.g. 123/45).
const TOKEN = '(\\d+(?:[/-]\\d+)*)'

/**
 * Extract every identifier recognized in `purpose` under `rules`. Order follows
 * the rules then their in-string position; duplicates (same kind AND value) are
 * dropped. Returns an empty array when nothing matches (caller falls back to
 * §2/§5 "нет идентификатора"). Never throws for malformed input.
 */
export function recognizeIdentifiers(
  purpose: string,
  rules: readonly RecognitionRule[]
): RecognizedId[] {
  const out: RecognizedId[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    for (const phrase of rule.phrases) {
      const p = phrase.trim()
      if (!p) continue
      const re = new RegExp(escapeRegExp(p) + SEPARATORS + TOKEN, 'giu')
      for (const m of purpose.matchAll(re)) {
        const value = m[1]!
        const key = `${rule.kind}|${value}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: rule.kind, value })
      }
    }
  }
  return out
}
