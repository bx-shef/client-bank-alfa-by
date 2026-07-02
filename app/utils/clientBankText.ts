import type { ClientBankParsed, ClientBankSection } from '~/types/clientBankText'

// ⚠️ PORTED EXAMPLE — REQUIRES REFACTOR (tracked in issue #19). DO NOT treat
// this as the final shape of the `manual` / `prior-by` provider.
//
// Parser for the legacy Belarusian client-bank text export (`***** ^Type=`,
// kin to `1CClientBankExchange`). The SAME text format is produced by Приорбанк
// exports and by hand-uploaded statements, so it backs BOTH the `prior-by` and
// `manual` providers (see app/config/banks.ts) — it is a *format* parser, not a
// bank client. Ported almost verbatim from the sibling `aidapioneer-tech/client-bank`
// app (`composables/useParser.ts`) so its behavior stays auditable against the
// live importer. Normalization to `StatementItem[]` now lives in the sibling
// `app/utils/clientBankStatement.ts` (`normalizeClientBank`, the `manual` /
// `prior-by` provider — issue #19); this file stays a pure *format* parser.
// Remaining rough edges (deferred to the #19 rewrite):
//   - section routing via three hand-maintained key dictionaries (header /
//     item / footer) — brittle, bank-specific, hard to extend;
//   - the `unrouted` catch-all bucket where unknown keys land (e.g. the `I3`
//     currency marker, which the normalizer reads back);
//   - no input-size limit (DoS guard) — the live app caps it in the UI and the
//     `scripts/parse-statement.ts` CLI caps bytes; the refactor should add one here;
//   - the caller is responsible for decoding CP1251 → string before calling
//     (the source files are windows-1251, NOT utf-8).
// It is covered by characterization tests against the anonymized fixtures in
// `tests/fixtures/client-bank/`.

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

/** Keys that belong to an operation row. `DocDate` also opens a new row.
 * The per-row document id — `DocID` OR `OperationID` (the `Type=4` "за период"
 * Alfa export uses `OperationID`, unique per operation) — and `Cod`/`Code`
 * (counterparty bank BIC) are captured per-row, emitted after their `DocDate`. */
const ITEM_KEYS = new Set([
  'DocDate', 'DocTime', 'Num', 'Opr', 'PaymCode', 'Code', 'Cod', 'Acc',
  'DebQ', 'CreQ', 'Deb', 'Cre', 'I2', 'Amount', 'Rate',
  'KorUNP', 'UNNRec', 'KorName', 'Nazn', 'Nazn2', 'OpDate', 'DocID', 'OperationID',
  'Credit', 'Db', 'OutRate'
])

function emptySection(): ClientBankSection {
  return { header: {}, items: [], footer: {}, unrouted: {} }
}

/** Split a `^Key=Value^`-derived line into [key, value] on the FIRST `=` only,
 * so values that themselves contain `=` (e.g. a payment purpose) are preserved. */
function splitKeyValue(line: string): [string, string] {
  const cleaned = line.replaceAll('^', '')
  const eq = cleaned.indexOf('=')
  if (eq < 0) return [cleaned.trim(), '']
  return [cleaned.slice(0, eq).trim(), cleaned.slice(eq + 1).trim()]
}

/**
 * Parse a client-bank text export into structured sections.
 *
 * The input MUST already be a decoded string (the source files are
 * windows-1251; decode with `iconv`/`TextDecoder('windows-1251')` first).
 * Throws on an unrecognized file (missing `***** ^Type=` header).
 *
 * NOTE (refactor, #19): faithful port — routing rules and the `unrouted` bucket
 * are intentionally kept as-is so behavior matches the live importer.
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
      // The title may itself contain `-`; keep everything after the first one.
      let titleParts = (parts[4] ?? '').split('-')
      if (titleParts.length < 2) {
        titleParts = (parts[6] ?? '').split('-')
      }
      result.GENERAL.TITLE = titleParts.slice(1).join('-').trim()
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
      const [key, rawValue] = splitKeyValue(line)
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
        if (key === 'DocDate') {
          // Normalize the date separator: `28/09/2023` -> `28.09.2023`.
          value = value.replaceAll('/', '.')
          itemIndex += 1
          // Seed OpDate from DocDate; an explicit `^OpDate=…^` line overrides it.
          aliasKey = 'OpDate'
        } else if (key === 'DocTime') {
          aliasKey = 'OpTime'
        } else if (key === 'UNNRec') {
          aliasKey = 'KorUNP'
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
        curSection.unrouted[key] = value
      }
    }
  }

  return result
}
