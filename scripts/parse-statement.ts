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
// The source files are windows-1251 (needs a full-ICU Node — the default for
// official builds).

import { readFileSync, statSync } from 'node:fs'
import { detectManualFormat, normalizeManualStatement } from '../app/utils/manualImport.ts'
import { parseClientBankText } from '../app/utils/clientBankText.ts'
import { formatItems, formatParsed } from './lib/statement-format.ts'

/** Refuse absurdly large files — a thin DoS guard the parser itself lacks (#19). */
const MAX_BYTES = 25 * 1024 * 1024

function decodeCp1251(bytes: Buffer): string {
  try {
    return new TextDecoder('windows-1251').decode(bytes)
  } catch {
    throw new Error('windows-1251 decoding unavailable — run on a full-ICU Node build')
  }
}

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
  try {
    text = decodeCp1251(readFileSync(file))
  } catch (e) {
    console.error(`✗ ${file}: ${(e as Error).message}`)
    return
  }

  const format = detectManualFormat(text)
  console.log(`\n=== ${file} ===`)
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
  console.log('Использование: pnpm parse:statement [--account <счёт>] <файл-выписки.txt> [ещё.txt …]')
  console.log('Пример:        pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt')
  console.log('               pnpm parse:statement tests/fixtures/1c-exchange/demo-1c.txt')
  process.exit(1)
}
console.log('Разбор ручной выписки — app/utils/manualImport.ts (client-bank «***** ^Type=» и 1CClientBankExchange)')
console.log('⚠️  вывод содержит данные контрагентов/назначений (PII) — не запускай на боевых выписках в логируемых средах')
for (const file of files) parseFile(file, account)
