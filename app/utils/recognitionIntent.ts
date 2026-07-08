import type { IdentifierKind } from '~/utils/purposeMatch'
import { recognizeByMatrices } from '~/utils/purposeMatch'
import type { IdentifierRoute } from '~/utils/identifierDispatch'
import { routeIdentifier } from '~/utils/identifierDispatch'
import type { RecognitionSettings } from '~/utils/settings'

// Pure composition of the two recognition cores (#109, PROCESSING.md §4): recognize
// every identifier in a payment purpose by the portal's matrices, then route each to
// its lookup decision. The result — WHAT was recognized + WHERE it would resolve — is
// the "intent". No I/O: the actual REST lookup/allocation is a later crm-sync slice;
// this module lets the wiring log/observe recognition coverage before it drives writes.

/** A recognized identifier paired with its dispatch decision (§4 → #109 lookup). */
export interface RecognitionIntent {
  kind: IdentifierKind
  /** The extracted value — whole matched fragment incl. any mask literal prefix. */
  value: string
  /** Where this kind resolves (target + lookup strategy), from `identifierDispatch`. */
  route: IdentifierRoute
}

/**
 * Recognize every identifier in `purpose` by the portal's matrices/alphabet, then
 * route each. Empty when recognition is off (no matrices) or nothing matches — the
 * caller then treats the op as "нет идентификатора" (§2/§5). Pure; never throws.
 */
export function recognizePurposeIntents(
  purpose: string,
  settings: RecognitionSettings
): RecognitionIntent[] {
  return recognizeByMatrices(purpose, settings.matrices, settings.alphabet)
    .map(id => ({ kind: id.kind, value: id.value, route: routeIdentifier(id.kind) }))
}
