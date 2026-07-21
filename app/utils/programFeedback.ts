// Pure core for the «программа» feedback channel (docs/FEEDBACK.md channel 2): the worker files a
// GitHub issue in the PRIVATE receiving repo when the program «got confused». Three signals:
//   • confusion — a crm-sync run had unmatched / ambiguous / manual outcomes (counts);
//   • fail-open — negative-stage load returned empty for a known funnel (invoice/deal/smart-process),
//     so candidates on those entities aren't stage-excluded (a broken query / trimmed rights);
//   • format   — a statement file didn't parse (format not recognized).
// A health/volume signal for the owner/triage agent, distinct from the per-portal error-chat notices.
//
// PRIVACY: carries ONLY non-PII — the portal member_id (routing id), the build sha, and per-signal
// INTERNAL shape (confusion counts / entity-type names / provider id). No account / purpose / amount
// is embedded (unlike the employee channel's opt-in file attach), so the issue is safe before triage.
// member_id/sha/provider are HTML-escaped + backtick-stripped defensively (rendered in code spans).

import { escapeHtml, type IssuePayload } from './feedback'

/** The crm-sync outcomes that count as «confusion». All three are tallied in the run summary. */
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

/** A program «confusion» event, discriminated by `type`:
 *  - confusion: crm-sync counts (unmatched/ambiguous/manual);
 *  - fail-open: entity types whose negative-stage load came back empty (invoice/deal/smart-process);
 *  - format:    a statement file didn't parse (optional provider id for context). */
export type ProgramSignal
  = | { type: 'confusion', counts: ConfusionCounts }
    | { type: 'fail-open', entities: string[] }
    | { type: 'format', providerId?: string }

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

/** Normalize a provider id to a safe key/label fragment (enum in practice, but defensive). */
function safeProvider(providerId?: string): string {
  return (providerId ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 32).toLowerCase() || 'manual'
}

/** Stable, order-independent dedup «root» for a signal — namespaced per type so a confusion shape
 *  and a fail-open shape never collide, and the same shape for a portal files at most once per
 *  window (e.g. `confusion:ambiguous+manual`, `failopen:deal+invoice`, `format:manual`). Pure. */
export function programSignalSignature(signal: ProgramSignal): string {
  switch (signal.type) {
    case 'confusion':
      return `confusion:${CONFUSION_KINDS.filter(k => nonNeg(signal.counts[k]) > 0).join('+')}`
    case 'fail-open':
      return `failopen:${[...new Set(signal.entities)].sort().join('+')}`
    case 'format':
      return `format:${safeProvider(signal.providerId)}`
  }
}

/** Build the { title, body, labels } for a program feedback issue. Labels always `agent-feedback` +
 *  `feedback:problem` (docs/FEEDBACK.md). Body is non-PII (member/sha/provider escaped; internal
 *  shape only — counts / entity-type names / provider id). Pure. */
export function buildProgramFeedbackIssue(input: { memberId: string, commitSha?: string, signal: ProgramSignal }): IssuePayload {
  // Render inside markdown code spans → strip backticks (can't close the span) THEN cap THEN escape,
  // so we never truncate mid-HTML-entity. Values are internal (hex/sha/enum) but keep it defensive.
  const inert = (v: string, cap: number): string => escapeHtml(v.replace(/`/g, '').slice(0, cap))
  const member = inert(input.memberId, 64)
  const sha = inert(input.commitSha ?? '', 40) || '—'
  const head = [
    '- **Канал:** agent-feedback (программа)',
    `- **member_id:** \`${member}\``,
    `- **Сборка:** \`${sha}\``,
    ''
  ]
  const tail = ['', '_Без данных клиента (счёт/сумма/назначение не приложены). Разбор — по FEEDBACK_TRIAGE_AGENT.md._']

  let title: string
  let middle: string[]
  if (input.signal.type === 'confusion') {
    const { counts } = input.signal
    const total = nonNeg(counts.unmatched) + nonNeg(counts.ambiguous) + nonNeg(counts.manual)
    title = `Программа запуталась — портал ${member} (${total})`
    middle = ['**Что пошло не так на прогоне импорта:**',
      ...CONFUSION_KINDS.filter(k => nonNeg(counts[k]) > 0).map(k => `- **${CONFUSION_LABELS[k]}:** ${nonNeg(counts[k])}`)]
  } else if (input.signal.type === 'fail-open') {
    const entities = [...new Set(input.signal.entities)].sort()
    title = `Стадии не загрузились (fail-open) — портал ${member}`
    middle = ['**Не удалось загрузить «отрицательные» стадии для воронок:**',
      `- **Сущности:** \`${inert(entities.join(', '), 80)}\``,
      '- Кандидаты на этих сущностях **не** отсеиваются по стадии (можно сесть на «Не оплачен»/проигранную).',
      '- Причина обычно — урезанные права или пустая воронка. Проверьте scope `crm` / стадии.']
  } else {
    const provider = inert(safeProvider(input.signal.providerId), 32)
    title = `Не разобрана выписка (формат) — портал ${member}`
    middle = ['**Разбор выписки упал — формат не распознан.**',
      `- **Провайдер:** \`${provider}\``,
      '- Ожидались форматы 1CClientBankExchange / client-bank `***** ^Type=` (windows-1251).',
      '- Похоже на новый формат банка — нужен образец (файл — только по каналу «сотрудник» с согласием).']
  }
  return { title: title.slice(0, 120), body: [...head, ...middle, ...tail].join('\n'), labels: ['agent-feedback', 'feedback:problem'] }
}
