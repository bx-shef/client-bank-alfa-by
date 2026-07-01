// Types for the 1C "Обмен с системами Клиент-банка" text format
// (`1CClientBankExchange`, versions 1.01–1.03). The de-facto universal accounting
// exchange format in the 1C ecosystem (RU and BY): banks export it, 1C imports it.
// Text, CP1251/UTF-8, lines `Ключ=Значение`, with `СекцияРасчСчет…КонецРасчСчет`
// (balances) and `СекцияДокумент=<вид>…КонецДокумента` (documents) sections.
// See docs/PRIOR_API.md and issue #21. Pure types — no runtime.

/** A flat `Ключ → Значение` bag (one document or account section). */
export type OneCRecord = Record<string, string>

/** Parsed `1CClientBankExchange` file: the service header, per-account balance
 * sections, and the payment documents. */
export interface OneCExchange {
  /** Header key/values before the first section (`ВерсияФормата`, `РасчСчет`, …). */
  header: OneCRecord
  /** `СекцияРасчСчет` blocks (balances/turnovers per settlement account). */
  accounts: OneCRecord[]
  /** `СекцияДокумент` blocks. `Вид` carries the document type (`Платежное поручение`). */
  documents: OneCRecord[]
}
