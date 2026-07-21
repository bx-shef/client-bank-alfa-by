// Pure core for the «программа» feedback channel (docs/FEEDBACK.md channel 2): the worker files a
// GitHub issue in the PRIVATE receiving repo when the program «got confused». Three signals:
//   • confusion — a crm-sync run had unmatched / ambiguous / manual outcomes (counts);
//   • fail-open — negative-stage load returned empty for a known funnel (invoice/deal/smart-process),
//     so candidates on those entities aren't stage-excluded (a broken query / trimmed rights);
//   • format   — a statement file didn't parse (format not recognized).
// A health/volume signal for the owner/triage agent, distinct from the per-portal error-chat notices.
//
// PRIVACY: member_id (routing id), build sha and per-signal internal shape (counts / entity-type
// names / provider id) are non-PII. Two variants ADDITIONALLY carry client financial data, embedded
// ONLY because the receiving repo is PRIVATE (docs/FEEDBACK.md; the owner opts in by configuring
// GITHUB_FEEDBACK_*): a `confusion` signal may carry one redacted SAMPLE of the confused op, and a
// `format` signal carries the raw FILE that failed to parse (for reproduction). Both are rendered
// fully inert (HOSTILE_CHARS + backtick strip, newline-collapse/HTML-escape, capped), and the footer
// flags «содержит данные клиента» so the triage agent won't leak it to the public repo. Dedup keeps
// each to one issue/shape/hour. fail-open carries no client data.

import { escapeHtml, fileEmbedLines, stripHostileChars, type IssuePayload } from './feedback'
import type { StatementItem } from '../types/statement'

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

/** A single redacted confused operation, for reproduction. RAW fields (the builder sanitizes on
 *  render). Client financial data — only ever embedded in the PRIVATE receiving repo. */
export interface ProgramSample {
  kind: ConfusionKind
  direction: string
  amount: number
  currency: string
  purpose: string
  counterparty: string
  counterpartyAccount: string
  counterpartyUnp: string
}

/** Extract a redacted sample from a confused operation (pure; no sanitization here — the builder
 *  makes each field inert on render). `kind` records which outcome the op hit. */
export function makeProgramSample(item: StatementItem, kind: ConfusionKind): ProgramSample {
  return {
    kind,
    direction: item.direction,
    amount: item.amount,
    currency: item.currency,
    purpose: item.purpose,
    counterparty: item.counterparty?.name ?? '',
    counterpartyAccount: item.counterparty?.account ?? '',
    counterpartyUnp: item.counterparty?.unp ?? ''
  }
}

/** A program «confusion» event, discriminated by `type`:
 *  - confusion: crm-sync counts (unmatched/ambiguous/manual) + an optional redacted op sample;
 *  - fail-open: entity types whose negative-stage load came back empty (invoice/deal/smart-process);
 *  - format:    a statement file didn't parse (provider id + the raw file text, for reproduction —
 *               the file the worker was parsing; client data → PRIVATE repo only). */
export type ProgramSignal
  = | { type: 'confusion', counts: ConfusionCounts, sample?: ProgramSample }
    | { type: 'fail-open', entities: string[] }
    | { type: 'format', providerId?: string, fileText?: string }

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

/** Body lines for a redacted op sample (client data → PRIVATE repo only), or `[]` when absent. The
 *  sample fields (purpose, counterparty) are PAYER-CONTROLLED, so each value is made fully inert:
 *  strip HOSTILE_CHARS (bidi/zero-width/BOM/C0 — Trojan-Source, same as the employee channel), strip
 *  backticks (can't close the code span), collapse newlines/tabs to a space (can't forge a markdown
 *  line), HTML-escape, cap. Amount is a typed number → rendered plain. */
function sampleLines(sample?: ProgramSample): string[] {
  if (!sample) return []
  const inertValue = (v: unknown, cap: number): string =>
    escapeHtml(stripHostileChars(v).replace(/`/g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, cap))
  const line = (label: string, value: unknown): string | null => {
    const f = inertValue(value, 200)
    return f ? `- **${label}:** \`${f}\`` : null
  }
  const amount = Number.isFinite(sample.amount) ? `- **Сумма:** \`${sample.amount} ${inertValue(sample.currency, 8)}\`` : null
  return [
    '',
    '**Пример операции** (данные клиента — репозиторий приватный, только для воспроизведения):',
    line('Случай', CONFUSION_LABELS[sample.kind]),
    line('Направление', sample.direction),
    amount,
    line('Назначение', sample.purpose),
    line('Контрагент', sample.counterparty),
    line('Счёт контрагента', sample.counterpartyAccount),
    line('УНП', sample.counterpartyUnp)
  ].filter((l): l is string => l !== null)
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
 *  `feedback:problem` (docs/FEEDBACK.md). Non-PII EXCEPT a confusion signal carrying a `sample` (a
 *  redacted client-data op) — then the footer flags that client data IS attached (the triage agent
 *  keys its privacy handling off that line). member/sha/provider are escaped. Pure. */
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
  // The footer must match reality: a confusion sample OR a format file embeds client PII, otherwise
  // the body is non-PII. The triage agent reads this line to decide privacy handling — it MUST NOT lie.
  const hasClientData
    = (input.signal.type === 'confusion' && !!input.signal.sample)
      || (input.signal.type === 'format' && !!(input.signal.fileText && stripHostileChars(input.signal.fileText).trim()))
  const tail = ['', hasClientData
    ? '_⚠ Содержит данные клиента (репозиторий приватный) — не переносить в публичный репо. Разбор — по FEEDBACK_TRIAGE_AGENT.md._'
    : '_Без данных клиента (счёт/сумма/назначение не приложены). Разбор — по FEEDBACK_TRIAGE_AGENT.md._']
  const finish = (title: string, middle: string[]): IssuePayload => ({
    title: title.slice(0, 120),
    body: [...head, ...middle, ...tail].join('\n'),
    labels: ['agent-feedback', 'feedback:problem']
  })

  // Switch (each case returns) → exhaustive by construction: a new ProgramSignal variant would leave
  // a non-returning path and fail typecheck (TS2366), same guard as programSignalSignature.
  switch (input.signal.type) {
    case 'confusion': {
      const { counts } = input.signal
      const total = nonNeg(counts.unmatched) + nonNeg(counts.ambiguous) + nonNeg(counts.manual)
      return finish(`Программа запуталась — портал ${member} (${total})`, [
        '**Что пошло не так на прогоне импорта:**',
        ...CONFUSION_KINDS.filter(k => nonNeg(counts[k]) > 0).map(k => `- **${CONFUSION_LABELS[k]}:** ${nonNeg(counts[k])}`),
        ...sampleLines(input.signal.sample)
      ])
    }
    case 'fail-open': {
      const entities = [...new Set(input.signal.entities)].sort()
      return finish(`Стадии не загрузились (fail-open) — портал ${member}`, [
        '**Не удалось загрузить «отрицательные» стадии для воронок:**',
        `- **Сущности:** \`${inert(entities.join(', '), 80)}\``,
        '- Кандидаты на этих сущностях **не** отсеиваются по стадии (можно сесть на «Не оплачен»/проигранную).',
        '- Причина обычно — урезанные права или пустая воронка. Проверьте scope `crm` / стадии.'
      ])
    }
    case 'format': {
      // safeProvider already yields [a-z0-9-]{≤32}; no further inert needed. The raw file the worker
      // was parsing is embedded (inert, capped) via the shared file-embed — client data → private repo.
      return finish(`Не разобрана выписка (формат?) — портал ${member}`, [
        '**Разбор выписки упал** (обычно — новый / нераспознанный формат банка).',
        `- **Провайдер:** \`${safeProvider(input.signal.providerId)}\``,
        '- Ожидались форматы 1CClientBankExchange / client-bank `***** ^Type=` (windows-1251).',
        ...fileEmbedLines(input.signal.fileText, '**Файл, который не разобрался** (для воспроизведения):')
      ])
    }
  }
}
