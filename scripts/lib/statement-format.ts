// Pure formatting/masking helpers for scripts/parse-statement.ts, kept here as
// .ts so they share the canonical types and are unit-tested
// (tests/parseStatement.test.ts). These mirror maskNumber/trunc in
// scripts/lib/demo-utils.mjs — the OAuth demo is plain .mjs (no TS step) while
// this tool is .ts, so the two module systems can't share one file.

import type { ClientBankParsed, ClientBankSection } from '../../app/types/clientBankText.ts'
import type { StatementItem } from '../../app/types/statement.ts'

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

/** Format a money amount for display (fixed 2 decimals, thin grouping). */
function fmtAmount(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '?'
}

/**
 * Render the UNIFIED normalized StatementItem[] — the exact data the app ingests
 * from any manual format — into display lines. Shows per-currency приход/расход
 * totals and up to `sample` rows (direction arrow, amount, masked counterparty
 * account + name, purpose, dedup key `account|docId`). Counterparty name and
 * purpose are printed verbatim (client PII) — the caller must warn first.
 */
export function formatItems(items: StatementItem[], sample = 8): string[] {
  const lines = [`NORMALIZED: операций ${items.length} (единый StatementItem[], как в приложении)`]
  if (!items.length) {
    lines.push('  (нет операций — проверь формат/период)')
    return lines
  }
  // Per-currency credit/debit totals — statements can mix currencies.
  const totals = new Map<string, { cr: number, crN: number, db: number, dbN: number }>()
  for (const it of items) {
    const t = totals.get(it.currency) ?? { cr: 0, crN: 0, db: 0, dbN: 0 }
    if (it.direction === 'credit') {
      t.cr += it.amount
      t.crN++
    } else {
      t.db += it.amount
      t.dbN++
    }
    totals.set(it.currency, t)
  }
  for (const [cur, t] of totals) {
    lines.push(`  ${cur || '?'}:  приходы ${t.crN} (+${fmtAmount(t.cr)})  ·  расходы ${t.dbN} (−${fmtAmount(t.db)})`)
  }
  for (const it of items.slice(0, sample)) {
    const arrow = it.direction === 'credit' ? '↑' : '↓'
    const sign = it.direction === 'credit' ? '+' : '−'
    const date = (it.operDate ?? it.acceptDate ?? '').slice(0, 10) || '?'
    const cp = `${maskAccount(it.counterparty.account)} ${truncText(it.counterparty.name, 24)}`.trim()
    const key = `${maskAccount(it.account)}|${truncText(it.docId, 12)}`
    lines.push(`  • ${date}  ${arrow}${sign}${fmtAmount(it.amount)} ${it.currency}  ${cp}  «${truncText(it.purpose, 40)}»  [${key}]`)
  }
  if (items.length > sample) lines.push(`  … ещё ${items.length - sample}`)
  return lines
}
