// Document bridge (#109, PROCESSING.md §4): resolve a `document-number` from the
// «Генерация документов» module to the CRM entity(ies) the document was generated
// for, so the caller can route each entity (invoice / deal / smart-process) through
// the id-based resolvers. A document carries exactly one `entityTypeId` + `entityId`
// — that pair IS a bridge target.
//
// Returns a LIST, not one ref: a document `number` is NOT guaranteed unique across
// the portal (Document Generator numbering is per-template and editable, unlike a
// smart-invoice `accountNumber`), so several documents may share a number. The
// caller re-scopes each ref by company (below) and takes the first that passes —
// mirroring how `invoiceLookup` returns an array even for a "unique" number.
//
// IDOR — the number comes from the payment purpose and is UNTRUSTED.
// `crm.documentgenerator.document.list` has NO company filter, so this returns bound
// entity refs across ALL companies. The CALLER MUST re-verify each entity belongs to
// the payer's company via `itemByIdLookup.findCandidateById(kind, Number(entityTypeId),
// entityId, { companyId })` before acting — exactly the by-id re-check that
// `identifierDispatch` requires for a bridged document (`strategy: 'via-document'`).
//
// Scope `documentgenerator` (the method lives under `crm.documentgenerator.*`; added to
// `B24_REQUIRED_SCOPES` with the bridge wiring, #109). Response shape and field names
// (`number`/`entityTypeId`/`entityId`, array under `result.documents`, `total` top-level)
// are LIVE-VERIFIED on the test portal (a document generated from template #1 bound to a
// deal): the reverse `filter:{ number }` IS honored (returns the doc; a non-existent number
// → `[]`), so the bridge is sound. We still DEFENSIVELY re-check `doc.number` against the
// requested one (cheap, guards a future portal that ignores the filter).
//
// ⚠ LIVE FINDING: the portal IGNORES `select` for this list method — the response ALWAYS
// carries `downloadUrlMachine`/`pdfUrlMachine`/`imageUrlMachine`, whose query string holds a
// LIVE access token. `findDocumentEntities` reads ONLY `number`/`entityTypeId`/`entityId` and
// discards the rest, so those token URLs never flow onward — but the raw response MUST NOT be
// logged wholesale. (`select` is kept as a hint; it is not a guarantee of field narrowing.)

import type { RestCall } from './companyLookup'

/** The CRM object a generated document is bound to — one bridge output. `kind`
 *  routing (2→deal, 31→invoice, custom→smart) happens in the caller. */
export interface DocumentEntityRef {
  entityTypeId: string
  entityId: string
}

/** `crm.documentgenerator.document.list` params to find documents by number. Selects
 *  ONLY the identifier fields (`number` for the defensive re-check, `entityTypeId`/
 *  `entityId` for the bridge) — deliberately NOT the `*UrlMachine` fields, which
 *  carry a live access token in their query string and must not flow onward. */
export function documentByNumberParams(documentNumber: string): Record<string, unknown> {
  return {
    filter: { number: documentNumber },
    select: ['id', 'number', 'entityTypeId', 'entityId']
  }
}

interface RawDocument {
  number?: unknown
  entityTypeId?: unknown
  entityId?: unknown
}

/** Pull the documents array out of the response (`result.documents`, tolerant). */
export function extractDocuments(resp: Record<string, unknown>): RawDocument[] {
  const documents = (resp?.result as Record<string, unknown> | undefined)?.documents
  return Array.isArray(documents) ? (documents as RawDocument[]) : []
}

/**
 * Resolve `documentNumber` to the CRM entity refs bound to documents with that exact
 * number. Returns `[]` when none match; a blank number yields `[]` without a REST
 * call. A transport error from `call` propagates; "not found" is `[]`, never a throw.
 *
 * Each returned `{ entityTypeId, entityId }` is UNVERIFIED against the payer's
 * company — the caller re-checks it via `itemByIdLookup` (see the file header).
 * Documents whose `number` does not equal the requested one are dropped (defence
 * against a silently-ignored `number` filter); rows without an entity binding too.
 */
export async function findDocumentEntities(documentNumber: string, call: RestCall): Promise<DocumentEntityRef[]> {
  const num = String(documentNumber).trim()
  if (!num) return []

  const resp = await call('crm.documentgenerator.document.list', documentByNumberParams(num))
  const out: DocumentEntityRef[] = []
  for (const doc of extractDocuments(resp)) {
    if (String(doc.number ?? '').trim() !== num) continue // filter re-check (see header)
    const entityTypeId = doc.entityTypeId === undefined || doc.entityTypeId === null ? '' : String(doc.entityTypeId)
    const entityId = doc.entityId === undefined || doc.entityId === null ? '' : String(doc.entityId)
    if (!entityTypeId || !entityId) continue
    out.push({ entityTypeId, entityId })
  }
  return out
}
