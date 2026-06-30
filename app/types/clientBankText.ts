// Types for the ported client-bank text parser (see app/utils/clientBankText.ts
// and issue #19). Kept under app/types/* per the repo convention (CLAUDE.md ›
// Конвенции: «типы — в app/types/*»). Pure types only — no runtime.

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
  /** Keys not routed to a known sub-section. Currently also where the `I3`
   * currency marker and `DocID` land (a rough edge — see #19). */
  unrouted: ClientBankRow
}

/** Full parse result of a client-bank text export. */
export interface ClientBankParsed {
  /** File-header fields from the `***** ^Type=…^ ^Acc=…^ - Title` line. */
  GENERAL: { TYPE: string, ACC: string, TITLE: string }
  IN_PARAM: ClientBankSection
  OUT_PARAM: ClientBankSection
}
