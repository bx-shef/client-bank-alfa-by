// Document bridge (#109, PROCESSING.md §4): resolve a `document-number` from the
// «Генерация документов» module to the CRM entity the document was generated for,
// so the caller can route that entity (invoice / deal / smart-process) through the
// id-based resolvers. A document carries exactly one `entityTypeId` + `entityId` —
// that pair IS the bridge target.
//
// IDOR — the number comes from the payment purpose and is UNTRUSTED.
// `crm.documentgenerator.document.list` has NO company filter, so this returns the
// bound entity ref globally. The CALLER MUST re-verify the entity belongs to the
// payer's company via `itemByIdLookup.findCandidateById(kind, entityTypeId,
// entityId, { companyId })` before acting — exactly the by-id re-check that
// `identifierDispatch` requires for a bridged document.
//
// Scope `crm` (the method lives under `crm.documentgenerator.*`). Response shape and
// field names (`number`/`entityTypeId`/`entityId`, array under `result.documents`)
// are taken from the official docs — NOT yet live-verified: the test portal has no
// generated document (`crm.documentgenerator.document.list` → 0). Confirm the field
// casing on a real document before relying on it in production.

import type { RestCall } from './companyLookup'

/** The CRM object a generated document is bound to — the bridge output. `kind`
 *  routing (2→deal, 31→invoice, custom→smart) happens in the caller. */
export interface DocumentEntityRef {
  entityTypeId: string
  entityId: string
}

/** `crm.documentgenerator.document.list` params to find a document by its number.
 *  Only the bridge fields are selected. Document numbers are unique per portal, so
 *  at most one row is expected. */
export function documentByNumberParams(documentNumber: string): Record<string, unknown> {
  return {
    filter: { number: documentNumber },
    select: ['id', 'number', 'entityTypeId', 'entityId']
  }
}

interface RawDocument {
  entityTypeId?: unknown
  entityId?: unknown
}

/** Pull the documents array out of the response (`result.documents`, tolerant). */
export function extractDocuments(resp: Record<string, unknown>): RawDocument[] {
  const documents = (resp?.result as Record<string, unknown> | undefined)?.documents
  return Array.isArray(documents) ? (documents as RawDocument[]) : []
}

/**
 * Resolve `documentNumber` to the CRM entity ref it is bound to, or `null` when no
 * document has that number or the row lacks the entity binding. A transport error
 * from `call` propagates; "not found" is `null`, never a throw. A blank number
 * yields `null` without a REST call.
 *
 * The returned `{ entityTypeId, entityId }` is UNVERIFIED against the payer's
 * company — the caller re-checks it via `itemByIdLookup` (see the file header).
 */
export async function findDocumentEntity(documentNumber: string, call: RestCall): Promise<DocumentEntityRef | null> {
  const num = String(documentNumber).trim()
  if (!num) return null

  const resp = await call('crm.documentgenerator.document.list', documentByNumberParams(num))
  const doc = extractDocuments(resp)[0]
  if (!doc) return null

  const entityTypeId = doc.entityTypeId === undefined || doc.entityTypeId === null ? '' : String(doc.entityTypeId)
  const entityId = doc.entityId === undefined || doc.entityId === null ? '' : String(doc.entityId)
  if (!entityTypeId || !entityId) return null
  return { entityTypeId, entityId }
}
