// Inspect a manually-uploaded bank statement using the CANONICAL manual-import
// dispatcher app/utils/manualImport.ts — the SAME entry point the `manual`
// provider (UI upload / backend) uses. No parsing logic is duplicated here.
//
// Handles both supported manual formats (issue #19/#21):
//   - `***** ^Type=`        client-bank text export (Приорбанк / Альфа Type=4)
//   - `1CClientBankExchange` 1C accounting exchange (RU + BY)
// and prints the UNIFIED StatementItem[] the app ingests. For the client-bank
// text format it also prints the detailed section view (parser rough edges are
// tracked in #19).
//
// Runs with Node's native TS type-stripping (Node >= 22, see package.json
// engines), so it imports the .ts core directly without a build step:
//   pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt
//   pnpm parse:statement tests/fixtures/1c-exchange/demo-1c.txt another.txt
//   pnpm parse:statement --account BY12ALFA... path/to/export.txt
//
// ⚠️ PII: sample rows print counterparty names and payment purposes verbatim
// (account numbers ARE masked). Do NOT run on real client statements in a
// logged/shared environment. The fixtures under tests/fixtures are anonymized.
//
// The ENCODING IS DETECTED, not assumed (#700): statement exports are windows-1251,
// CP866 (Паритетбанк) or UTF-8, and the app picks between them in ONE place —
// `decodeUploadText`. This script MUST go through that same point. It used to hardcode
// windows-1251, and the failure was silent in the worst direction: a CP866 file still
// parses STRUCTURALLY (stars, digits, accounts and amounts are ASCII), only the Cyrillic
// comes out as mojibake — so the diagnostic tool showed garbage where the app shows clean
// text, i.e. it lied AGAINST us. Needs a full-ICU Node (the default for official builds).

import { readFileSync, statSync } from 'node:fs'
import { decodeUploadText } from '../app/utils/importUpload.ts'
import { detectStatementEncoding } from '../app/utils/statementEncoding.ts'
import { detectManualFormat, normalizeManualStatement } from '../app/utils/manualImport.ts'
import { parseClientBankText } from '../app/utils/clientBankText.ts'
import { formatItems, formatParsed } from './lib/statement-format.ts'

/** Refuse absurdly large files — a thin DoS guard the parser itself lacks (#19). */
const MAX_BYTES = 25 * 1024 * 1024

/** `--account <acc>` overrides our own account (seeds 1C direction + dedup). */
function readAccountFlag(argv: string[]): string {
  const i = argv.indexOf('--account')
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : ''
}

function parseFile(file: string, account: string): void {
  let size: number
  try {
    size = statSync(file).size
  } catch (e) {
    console.error(`✗ ${file}: не прочитать — ${(e as Error).message}`)
    return
  }
  if (size > MAX_BYTES) {
    console.error(`✗ ${file}: слишком большой (${size} Б > ${MAX_BYTES} Б) — пропускаю`)
    return
  }

  let text: string
  let encoding: string
  try {
    const bytes = readFileSync(file)
    encoding = detectStatementEncoding(bytes)
    text = decodeUploadText(bytes)
  } catch (e) {
    console.error(`✗ ${file}: не декодировать — ${(e as Error).message}`)
    return
  }

  const format = detectManualFormat(text)
  console.log(`\n=== ${file} ===`)
  // The encoding is PRINTED because it is a guess made from byte statistics: when the
  // Cyrillic looks wrong, the reader needs to know which way the guess went.
  console.log(`кодировка: ${encoding}`)
  console.log(`формат: ${format}`)
  if (format === 'unknown') {
    console.error('✗ неизвестный формат (ожидается 1CClientBankExchange или client-bank «***** ^Type=»)')
    return
  }

  // Unified normalized items — exactly what the app consumes for this file.
  try {
    const items = normalizeManualStatement(text, { account })
    for (const line of formatItems(items)) console.log(line)
  } catch (e) {
    console.error(`✗ нормализация не удалась: ${(e as Error).message}`)
  }

  // For the client-bank text format, also show the raw section view (#19).
  if (format === 'client-bank-text') {
    try {
      for (const line of formatParsed(parseClientBankText(text))) console.log(line)
    } catch { /* already reported above if it failed */ }
  }
}

const argv = process.argv.slice(2)
const account = readAccountFlag(argv)
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--account')
if (!files.length) {
  console.log('Использование: pnpm parse:statement [--account <счёт>] <файл-выписки.txt|.csv> [ещё …]')
  console.log('Пример:        pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt')
  console.log('               pnpm parse:statement tests/fixtures/1c-exchange/demo-1c.txt')
  process.exit(1)
}
console.log('Разбор ручной выписки — app/utils/manualImport.ts (client-bank «***** ^Type=» и 1CClientBankExchange)')
console.log('⚠️  вывод содержит данные контрагентов/назначений (PII) — не запускай на боевых выписках в логируемых средах')
for (const file of files) parseFile(file, account)
