// Parser for the 1C "Клиент-банк" exchange format (`1CClientBankExchange`) — a
// pure *format* parser (text → header/accounts/documents), sibling to
// clientBankText.ts. Normalization to StatementItem[] lives in oneCStatement.ts
// (`normalizeOneC`). Issue #21.
//
// The caller decodes the file to a string first (the files are CP1251 —
// `Кодировка=Windows`; some emitters use UTF-8/DOS). Structure:
//   1CClientBankExchange            ← required first-line marker
//   ВерсияФормата=1.02 … РасчСчет=…  ← service header
//   СекцияРасчСчет … КонецРасчСчет   ← balances per account (bank → 1C only)
//   СекцияДокумент=Платежное поручение … КонецДокумента   ← one per document
//   КонецФайла

import type { OneCExchange, OneCRecord } from '~/types/oneCExchange'

const MARKER = '1CClientBankExchange'

/** Split a `Ключ=Значение` line on the FIRST `=` only (values may contain `=`,
 * e.g. a payment purpose). Returns `null` for a line without `=`. */
function splitKeyValue(line: string): [string, string] | null {
  const eq = line.indexOf('=')
  if (eq < 0) return null
  return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()]
}

/**
 * Parse a `1CClientBankExchange` document into its header, account-balance
 * sections, and payment documents. Throws if the first line is not the
 * `1CClientBankExchange` marker (so a caller can sniff the format by catching).
 *
 * A `СекцияДокумент=<вид>` line opens a document whose type is kept under the
 * synthetic key `Вид`; `КонецДокумента` closes it. `СекцияРасчСчет`/`КонецРасчСчет`
 * bracket a balance section. Keys before the first section land in `header`.
 */
export function parseOneCExchange(content: string): OneCExchange {
  const lines = content.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== MARKER) {
    throw new Error('Not a 1CClientBankExchange file')
  }

  const result: OneCExchange = { header: {}, accounts: [], documents: [] }
  let current: OneCRecord | null = null // the open section, or null = header

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    if (line === 'СекцияРасчСчет') {
      current = {}
      result.accounts.push(current)
      continue
    }
    if (line === 'КонецРасчСчет' || line === 'КонецДокумента') {
      current = null
      continue
    }
    if (line === 'КонецФайла') break

    const kv = splitKeyValue(line)
    if (!kv) continue // a bare continuation line — ignored (see purpose note in normalizer)
    const [key, value] = kv

    if (key === 'СекцияДокумент') {
      current = { Вид: value }
      result.documents.push(current)
      continue
    }

    ;(current ?? result.header)[key] = value
  }

  return result
}

/** Cheap sniff: is this text a `1CClientBankExchange` file? (first-line marker). */
export function isOneCExchange(content: string): boolean {
  return content.slice(0, 256).trimStart().startsWith(MARKER)
}
