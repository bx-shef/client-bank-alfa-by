// Pure core for the «программа» feedback channel (docs/FEEDBACK.md channel 2): the crm-sync worker
// files a GitHub issue in the PRIVATE receiving repo when a run «got confused» — a company wasn't
// found (unmatched), allocation was ambiguous, or an op fell through to manual. It's a health/volume
// signal for the owner/triage agent, distinct from the per-portal error-chat notices.
//
// PRIVACY: MVP carries ONLY non-PII — the portal member_id (a routing hash), the build sha and the
// COUNTS of each confused kind. No account number / purpose / amount is embedded (unlike the employee
// channel's opt-in file attach), so the program issue is safe even before triage. member_id/sha are
// still HTML-escaped defensively. Attaching a sample confused op (account/purpose) is a follow-up.

import { escapeHtml, type IssuePayload } from './feedback'

/** The crm-sync outcomes that count as «confusion» worth a program feedback issue. All three are
 *  already tallied in the run summary (server/queue/handlers.ts). Format-not-recognized and
 *  fail-open-stages are additional signals in docs/FEEDBACK.md — follow-ups (not summary counts). */
export const CONFUSION_KINDS = ['unmatched', 'ambiguous', 'manual'] as const
export type ConfusionKind = typeof CONFUSION_KINDS[number]

/** Russian labels for the issue body (exhaustive over ConfusionKind). */
export const CONFUSION_LABELS: Record<ConfusionKind, string> = {
  unmatched: 'не найдена компания по счёту',
  ambiguous: 'неоднозначное разнесение (несколько целей одной суммы)',
  manual: 'нет точного совпадения → ручная очередь'
}

export interface ConfusionCounts {
  unmatched: number
  ambiguous: number
  manual: number
}

function nonNeg(v: unknown): number {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Reduce a crm-sync summary to its confusion shape: normalized counts, the kinds that actually
 *  fired (count > 0), and the total. `total === 0` ⇒ nothing to report. Pure. */
export function summarizeConfusion(summary: Partial<ConfusionCounts>): { counts: ConfusionCounts, kinds: ConfusionKind[], total: number } {
  const counts: ConfusionCounts = {
    unmatched: nonNeg(summary.unmatched),
    ambiguous: nonNeg(summary.ambiguous),
    manual: nonNeg(summary.manual)
  }
  const kinds = CONFUSION_KINDS.filter(k => counts[k] > 0)
  const total = counts.unmatched + counts.ambiguous + counts.manual
  return { counts, kinds, total }
}

/** Stable, order-independent signature of a set of confused kinds — the dedup «root» so the same
 *  problem-shape for a portal files at most once per window (e.g. `ambiguous+manual`). Pure. */
export function confusionSignature(kinds: ConfusionKind[]): string {
  return [...kinds].sort().join('+')
}

/** Build the { title, body, labels } for a program feedback issue. Labels `agent-feedback` +
 *  `feedback:problem` (per docs/FEEDBACK.md). Body is non-PII (member/sha escaped, counts). */
export function buildProgramFeedbackIssue(input: { memberId: string, commitSha?: string, counts: ConfusionCounts }): IssuePayload {
  const member = escapeHtml(input.memberId).slice(0, 64)
  const sha = escapeHtml(input.commitSha ?? '').slice(0, 40) || '—'
  const { counts } = input
  const lines = CONFUSION_KINDS
    .filter(k => counts[k] > 0)
    .map(k => `- **${CONFUSION_LABELS[k]}:** ${counts[k]}`)
  const total = counts.unmatched + counts.ambiguous + counts.manual
  const title = `Программа запуталась — портал ${member} (${total})`.slice(0, 120)
  const body = [
    '- **Канал:** agent-feedback (программа)',
    `- **member_id:** \`${member}\``,
    `- **Сборка:** \`${sha}\``,
    '',
    '**Что пошло не так на прогоне импорта:**',
    ...lines,
    '',
    '_Без данных клиента (счёт/сумма/назначение не приложены). Разбор — по FEEDBACK_TRIAGE_AGENT.md._'
  ].join('\n')
  return { title, body, labels: ['agent-feedback', 'feedback:problem'] }
}
