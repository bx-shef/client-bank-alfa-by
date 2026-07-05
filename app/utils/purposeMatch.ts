// Pure recognition of entity identifiers from a payment purpose (назначение),
// per docs/PROCESSING.md §4. Recognition is MATRIX-driven (not "phrase + number"):
// each matrix is a mask where `d` = a digit and every other character is a literal
// (letters / `-` / `/` / …), e.g. `dddd`, `СЧ-dddd`, `BOPC-ddd/dd`. A matrix is
// bound to an `IdentifierKind` (→ which entity field to look up, §4). Homoglyphs
// (`ВОРС`↔`BOPC` look identical) are folded to a chosen alphabet before matching.
// No I/O: the id→entity lookup is the REST slice; this module only extracts
// (mask → identifier) so it unit-tests on plain strings. Matrices come from
// per-portal settings — the module ships no hard-coded numbers or prefixes.

/**
 * What an extracted identifier is (§4). The lookup uses this to pick the right
 * REST search — an invoice by number vs by id, a deal by a per-direction field,
 * etc. `document-number` is a bridge: find the generated document, then follow
 * its `entityTypeId`/`entityId` to the real entity.
 */
export type IdentifierKind
  = | 'invoice-number' | 'invoice-id'
    | 'deal-id' | 'deal-field'
    | 'order-id' | 'order-number'
    | 'payment-id' | 'payment-number'
    | 'smart-id' | 'smart-field'
    | 'document-number'

/** Which alphabet homoglyphs are folded to before matching (§4). */
export type Alphabet = 'cyrillic' | 'latin'

/**
 * One recognition matrix: `mask` describes the identifier's format — lowercase
 * `d` is a digit placeholder, every other char is a literal. Bound to `kind`.
 * `note` is a human explanation shown in settings. Masks come from the per-portal
 * «карта сопоставления» (§4). A literal Latin lowercase `d` cannot be used (it is
 * always the digit placeholder) — spell prefixes with uppercase / other letters.
 */
export interface MatchMatrix {
  mask: string
  kind: IdentifierKind
  note?: string
}

/** A recognized identifier: its kind and the extracted value — the WHOLE matched
 *  fragment, INCLUDING the mask's literal prefix (e.g. `СЧ-1234`, not `1234`) and
 *  in the folded alphabet. The REST lookup decides whether the entity field holds
 *  the number with the prefix or without (§4; often `accountNumber` IS `СЧ-1`). */
export interface RecognizedId {
  kind: IdentifierKind
  value: string
}

/** Escape a literal for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Visually-identical Cyrillic↔Latin letter pairs (uppercase canon). Numbers/codes
// are typed in either alphabet — "ВОРС" (Cyr) and "BOPC" (Lat) look the same. Case
// is handled programmatically in `foldHomoglyphs`, so only uppercase pairs live
// here (a lowercase-only table would silently miss "ворс" — #152 review).
const CYR_LAT: ReadonlyArray<readonly [string, string]> = [
  ['А', 'A'], ['В', 'B'], ['Е', 'E'], ['К', 'K'], ['М', 'M'], ['Н', 'H'],
  ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['У', 'Y'], ['Х', 'X']
]
const TO_LATIN = new Map(CYR_LAT.map(([c, l]) => [c, l]))
const TO_CYRILLIC = new Map(CYR_LAT.map(([c, l]) => [l, c]))

/** Fold homoglyphs of `text` to the chosen alphabet so a code written in either
 *  Cyrillic or Latin compares equal — case-insensitively (table is uppercase; the
 *  source char's case is preserved). Non-homoglyph chars pass through unchanged. */
export function foldHomoglyphs(text: string, alphabet: Alphabet): string {
  const m = alphabet === 'latin' ? TO_LATIN : TO_CYRILLIC
  let out = ''
  for (const ch of text) {
    const upper = ch.toUpperCase()
    const mapped = m.get(upper)
    if (mapped === undefined) out += ch
    else out += ch === upper ? mapped : mapped.toLowerCase()
  }
  return out
}

// A match must not sit INSIDE a longer alphanumeric token (so bare `dddd` does not
// grab "1234" out of "12345", and a prefixed mask does not match a fragment). The
// class includes Belarusian `Іі`/`Ўў` (Alfa-Bank BY) beyond А-Я/а-я/Ёё.
const ALNUM = '0-9A-Za-zА-Яа-яЁёІіЎў'
const BOUND_L = `(?<![${ALNUM}])`
const BOUND_R = `(?![${ALNUM}])`

/** Compile a (already homoglyph-folded) mask into a RegExp body: `d` → a digit,
 *  everything else → an escaped literal. */
function maskToPattern(foldedMask: string): string {
  let p = ''
  for (const ch of foldedMask) p += ch === 'd' ? '\\d' : escapeRegExp(ch)
  return p
}

/** Upper bound on the purpose length we scan — DoS guard (cf. `MAX_CLIENT_BANK_CHARS`). */
export const MAX_PURPOSE_CHARS = 10_000
/** Reject absurdly long extracted values — real ids/numbers are short. */
export const MAX_ID_CHARS = 64
/** Skip an over-long mask (defense-in-depth: masks come from portal settings). */
export const MAX_MASK_CHARS = 128
/** Scan at most this many matrices per call (semi-trusted settings source). */
export const MAX_MATRICES = 200

/**
 * Extract every identifier recognized in `purpose` by `matrices`, folding both the
 * purpose and each mask to `alphabet` (default `cyrillic`) first. Order: by matrix,
 * then by in-string position. Duplicates (same kind AND value) are dropped. Returns
 * an empty array when nothing matches (caller falls back to §2/§5 "нет
 * идентификатора"). Never throws for malformed input or a bad mask.
 */
export function recognizeByMatrices(
  purpose: string,
  matrices: readonly MatchMatrix[],
  alphabet: Alphabet = 'cyrillic'
): RecognizedId[] {
  const hay = foldHomoglyphs(
    purpose.length > MAX_PURPOSE_CHARS ? purpose.slice(0, MAX_PURPOSE_CHARS) : purpose,
    alphabet
  )
  const out: RecognizedId[] = []
  const seen = new Set<string>()
  for (const matrix of matrices.slice(0, MAX_MATRICES)) {
    const mask = matrix.mask.trim()
    if (!mask || mask.length > MAX_MASK_CHARS) continue
    const body = maskToPattern(foldHomoglyphs(mask, alphabet))
    let re: RegExp
    try {
      re = new RegExp(BOUND_L + '(' + body + ')' + BOUND_R, 'giu')
    } catch {
      continue // a mask that somehow compiles to invalid regex is skipped, not thrown
    }
    for (const m of hay.matchAll(re)) {
      const value = m[1]!
      if (value.length > MAX_ID_CHARS) continue
      const key = `${matrix.kind}|${value}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: matrix.kind, value })
    }
  }
  return out
}
