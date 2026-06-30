// ⚠️ PORTED EXAMPLE — REQUIRES REFACTOR (tracked in issue #19). DO NOT treat
// this as the final shape of the `manual` / `prior-by` provider.
//
// Parser for the legacy Belarusian client-bank text export (`***** ^Type=`,
// kin to `1CClientBankExchange`). Ported almost verbatim from the sibling
// `aidapioneer-tech/client-bank` app (`composables/useParser.ts`) so its
// behavior stays auditable against the live importer. Known rough edges to be
// addressed during the rewrite:
//   - section routing via three hand-maintained key dictionaries (header /
//     item / footer) — brittle, bank-specific, hard to extend;
//   - the `wtf` catch-all bucket where unrouted keys land — including the `I3`
//     currency marker AND `DocID`, which is NOT captured per row (last write
//     wins) even though it is the `account|docId` idempotency key #19 needs;
//   - no normalization to `StatementItem` yet (mapping lives in issue #19);
//   - the caller is responsible for decoding CP1251 → string before calling
//     (the source files are windows-1251, NOT utf-8).
// Until then it is covered by characterization tests against the anonymized
// fixtures in `tests/fixtures/client-bank/`.

/** One operation row: raw `^Key=Value^` pairs as parsed (values are strings). */
export type ClientBankRow = Record<string, string>

/** A `[IN_PARAM]` / `[OUT_PARAM]` section split into logical sub-sections. */
export interface ClientBankSection {
  /** Statement header fields (period, opening balance, …). */
  header: ClientBankRow
  /** Operation rows, in file order. A new `DocDate` opens a new row. */
  items: ClientBankRow[]
  /** Footer fields (closing balance, bank name, …). */
  footer: ClientBankRow
  /** Keys not routed to a known sub-section (incl. the `I3` currency marker). */
  wtf: ClientBankRow
}

/** Full parse result of a client-bank text export. */
export interface ClientBankParsed {
  /** File-header fields from the `***** ^Type=…^ ^Acc=…^ - Title` line. */
  GENERAL: { TYPE: string, ACC: string, TITLE: string }
  IN_PARAM: ClientBankSection
  OUT_PARAM: ClientBankSection
}

const FILE_HEADER = '***** ^Type='

/** Keys that belong to the statement header (period, opening balance, …). */
const HEADER_KEYS = new Set([
  'Time', 'Header1', 'Header2', 'Header3', 'Header4', 'Header5',
  'DateBegin', 'DateEnd', 'DateIn', 'RestIn', 'CrIn', 'CrInQ', 'RestInQ',
  'InCre', 'InCreQ', 'AcPa', 'AcPa1', 'I1', 'I1str', 'UNN'
])

/** Keys that belong to the statement footer (closing balance, turnovers, …). */
const FOOTER_KEYS = new Set([
  'DB', 'CR', 'RestOut', 'DebVQ', 'CreVQ', 'DebV', 'CreV',
  'RestOutQ', 'CrOut', 'OutCre', 'DebOut'
])

/** Keys that belong to an operation row. `DocDate` also opens a new row. */
const ITEM_KEYS = new Set([
  'DocDate', 'DocTime', 'Num', 'Opr', 'PaymCode', 'Code', 'Acc',
  'DebQ', 'CreQ', 'Deb', 'Cre', 'I2', 'Amount', 'Rate',
  'KorUNP', 'UNNRec', 'KorName', 'Nazn', 'Nazn2', 'OpDate',
  'Credit', 'Db', 'OutRate'
])

function emptySection(): ClientBankSection {
  return { header: {}, items: [], footer: {}, wtf: {} }
}

/**
 * Parse a client-bank text export into structured sections.
 *
 * The input MUST already be a decoded string (the source files are
 * windows-1251; decode with `iconv`/`TextDecoder('windows-1251')` first).
 * Throws on an unrecognized file (missing `***** ^Type=` header).
 *
 * NOTE (refactor, #19): faithful port — routing rules and the `wtf` bucket are
 * intentionally kept as-is so behavior matches the live importer.
 */
export function parseClientBankText(content: string): ClientBankParsed {
  if (content.substring(0, FILE_HEADER.length) !== FILE_HEADER) {
    throw new Error('Unexpected file format')
  }

  const result: ClientBankParsed = {
    GENERAL: { TYPE: '', ACC: '', TITLE: '' },
    IN_PARAM: emptySection(),
    OUT_PARAM: emptySection()
  }

  let curSection: ClientBankSection | null = null
  // Index of the operation row currently being filled (`-1` = none yet).
  let itemIndex = -1

  for (const line of content.split(/\r?\n/)) {
    const firstChar = line.charAt(0)

    if (firstChar === '*') {
      // File header: `***** ^Type=400^ ^Acc=BY…^  -  Title`.
      const parts = line.split('^').filter(Boolean)
      result.GENERAL.TYPE = (parts[1] ?? '').split('=')[1] ?? ''
      result.GENERAL.ACC = (parts[3] ?? '').split('=')[1] ?? ''
      let titleParts = (parts[4] ?? '').split('-')
      if (titleParts.length < 2) {
        titleParts = (parts[6] ?? '').split('-')
      }
      result.GENERAL.TITLE = (titleParts[1] ?? '').trim()
      continue
    }

    if (firstChar === '[') {
      const tag = line.trim()
      if (tag === '[OUT_PARAM]') {
        curSection = result.OUT_PARAM
        itemIndex = -1
      } else if (tag === '[IN_PARAM]') {
        curSection = result.IN_PARAM
        itemIndex = -1
      }
      continue
    }

    if (firstChar === '^' && curSection) {
      const [rawKey = '', rawValue = ''] = line.replaceAll('^', '').split('=').map(s => s.trim())
      const key = rawKey
      let value = rawValue
      // Alias some keys into a second field, mirroring the live importer.
      let aliasKey: string | null = null

      if (HEADER_KEYS.has(key)) {
        if (key === 'CrIn' || key === 'InCre') aliasKey = 'RestIn'
        curSection.header[key] = value
        if (aliasKey) curSection.header[aliasKey] = value
      } else if (FOOTER_KEYS.has(key)) {
        if (key === 'CrOut' || key === 'OutCre') aliasKey = 'RestOut'
        curSection.footer[key] = value
        if (aliasKey) curSection.footer[aliasKey] = value
      } else if (ITEM_KEYS.has(key)) {
        if (key === 'DocDate' || key === 'DateIn' || key === 'DateOut') {
          // Normalize the date separator: `28/09/2023` -> `28.09.2023`.
          value = value.replaceAll('/', '.')
          if (key === 'DocDate') {
            itemIndex += 1
            aliasKey = 'OpDate'
          }
        } else if (key === 'DocTime') {
          aliasKey = 'OpTime'
        } else if (key === 'UNNRec') {
          aliasKey = 'KorUNP'
        } else if (key === 'CrIn') {
          aliasKey = 'RestIn'
        } else if (key === 'CrOut') {
          aliasKey = 'RestOut'
        }
        if (itemIndex < 0) {
          // An item key before the first `DocDate` — skip (matches the source,
          // which keys rows by `DocDate`). One of the rough edges of #19.
          continue
        }
        const row = (curSection.items[itemIndex] ??= {})
        row[key] = value
        if (aliasKey) row[aliasKey] = value
      } else {
        curSection.wtf[key] = value
      }
    }
  }

  return result
}
