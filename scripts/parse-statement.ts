// Inspect a Belarusian client-bank text statement (Приорбанк export or a
// hand-uploaded `manual` file, CP1251) using the CANONICAL parser
// app/utils/clientBankText.ts — no parsing logic is duplicated here.
//
// Runs with Node's native TS type-stripping (Node >= 22, see package.json
// engines), so it imports the .ts parser directly without a build step:
//   pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt
//   pnpm parse:statement path/to/your-export.txt another.txt
//
// ⚠️ PII: sample rows print counterparty names and payment purposes verbatim
// (account numbers ARE masked). Do NOT run on real client statements in a
// logged/shared environment. The fixtures under tests/fixtures are anonymized.
//
// The source files are windows-1251 (needs a full-ICU Node — the default for
// official builds). Parser rough edges (no StatementItem normalization, the
// `unrouted` bucket, no size cap) are tracked in issue #19.

import { readFileSync, statSync } from 'node:fs'
import { parseClientBankText } from '../app/utils/clientBankText.ts'
import { formatParsed } from './lib/statement-format.ts'

/** Refuse absurdly large files — a thin DoS guard the parser itself lacks (#19). */
const MAX_BYTES = 25 * 1024 * 1024

function decodeCp1251(bytes: Buffer): string {
  try {
    return new TextDecoder('windows-1251').decode(bytes)
  } catch {
    throw new Error('windows-1251 decoding unavailable — run on a full-ICU Node build')
  }
}

function parseFile(file: string): void {
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
  let parsed
  try {
    parsed = parseClientBankText(decodeCp1251(readFileSync(file)))
  } catch (e) {
    console.error(`✗ ${file}: ${(e as Error).message} (ожидается client-bank экспорт «***** ^Type=…»)`)
    return
  }
  console.log(`\n=== ${file} ===`)
  for (const line of formatParsed(parsed)) console.log(line)
}

const files = process.argv.slice(2).filter(a => !a.startsWith('--')) // dev CLI: caller controls the paths
if (!files.length) {
  console.log('Использование: pnpm parse:statement <файл-выписки.txt> [ещё.txt …]')
  console.log('Пример:        pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt')
  process.exit(1)
}
console.log('Парсер client-bank (Приорбанк / manual, CP1251) — app/utils/clientBankText.ts')
console.log('⚠️  вывод содержит данные контрагентов/назначений (PII) — не запускай на боевых выписках в логируемых средах')
for (const file of files) parseFile(file)
