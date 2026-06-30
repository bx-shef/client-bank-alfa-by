// Pure formatting/masking helpers for scripts/parse-statement.ts, kept here as
// .ts so they share the canonical types and are unit-tested
// (tests/parseStatement.test.ts). These mirror maskNumber/trunc in
// scripts/lib/demo-utils.mjs — the OAuth demo is plain .mjs (no TS step) while
// this tool is .ts, so the two module systems can't share one file.

import type { ClientBankParsed, ClientBankSection } from '../../app/types/clientBankText.ts'

/** Mask an account-like number, keeping the last 4 chars. Empty → '?', and a
 * value of 4 chars or fewer is fully masked so a short value never leaks. */
export function maskAccount(a: string): string {
  if (!a) return '?'
  return a.length <= 4 ? '****' : `****${a.slice(-4)}`
}

/** Truncate to `n` chars with an ellipsis; nullish/empty → ''. */
export function truncText(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatSection(label: string, sec: ClientBankSection): string[] {
  const h = sec.header
  const f = sec.footer
  const lines = [`  [${label}]  операций: ${sec.items.length}`]
  if (h.DateBegin || h.DateEnd) lines.push(`    период:  ${h.DateBegin ?? '?'} … ${h.DateEnd ?? '?'}`)
  if (h.RestIn != null || f.RestOut != null) lines.push(`    остаток: вход ${h.RestIn ?? '?'} → исход ${f.RestOut ?? '?'}`)
  for (const row of sec.items.slice(0, 3)) {
    const amount = row.Cre ?? row.Deb ?? row.Amount ?? '?'
    lines.push(`    • ${row.DocDate ?? '?'}  ${amount}  ${truncText(row.KorName, 28)}  «${truncText(row.Nazn, 40)}»`)
  }
  if (sec.items.length > 3) lines.push(`    … ещё ${sec.items.length - 3}`)
  const unrouted = Object.keys(sec.unrouted).length
  if (unrouted) lines.push(`    unrouted-ключей: ${unrouted} (см. issue #19)`)
  return lines
}

/** Render a parsed statement into display lines (account masked). The sample
 * rows include counterparty name / payment purpose verbatim — that is client
 * PII, so the caller must warn before running on real statements. */
export function formatParsed(parsed: ClientBankParsed): string[] {
  const lines = [
    `GENERAL: TYPE ${parsed.GENERAL.TYPE || '?'}  ACC ${maskAccount(parsed.GENERAL.ACC)}  ${parsed.GENERAL.TITLE}`
  ]
  lines.push(...formatSection('IN_PARAM', parsed.IN_PARAM))
  lines.push(...formatSection('OUT_PARAM', parsed.OUT_PARAM))
  return lines
}
