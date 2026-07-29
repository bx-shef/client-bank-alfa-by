// «Что настроено, а что нет» — pure SETUP-readiness model (#409 + #405).
//
// NB: distinct from `server/utils/readiness.ts`, which probes INFRASTRUCTURE health (Postgres/Redis
// for `/api/ready`). This one is about a portal's configuration, hence the `setup` prefix.
//
// Why: the app had no single place answering «почему ничего не приходит?». Bank connection lived in
// one card, the chat in another, smart processes in a third, and the poll schedule NOWHERE — a
// portal could sit half-configured forever with every screen looking normal. This turns the scattered
// state into one ordered checklist plus the poll schedule, so the gap is visible at a glance.
//
// Pure: takes an already-loaded snapshot and returns what to render. No I/O, no clock reading beyond
// the `nowMs` handed in — so it is fully testable and the same model serves the server response and
// the UI.

import { paymentSpEtid, distributionSpEtid } from '~/config/distributionSp'
import type { PortalSettings } from '~/utils/settings'

/** One checklist line. `ok` drives the icon; `hint` is what to DO when it isn't ok. */
export interface ReadinessItem {
  key: 'bank' | 'chat' | 'smart-process' | 'poll'
  title: string
  ok: boolean
  /** Short state description («2 счёта», «не выбран»). */
  detail: string
  /** Action to take when not ok. Empty when everything is fine. */
  hint: string
}

/** Everything the checklist needs, gathered by the caller. */
export interface ReadinessSnapshot {
  settings: PortalSettings
  /** How many bank accounts the portal has connected (online import). */
  connectedAccounts: number
  /** Server-side poll gate (`CRON_REAL_POLL`) — OFF means no automatic polling at all. */
  pollEnabled: boolean
  /** Poll period in minutes (`CRON_INTERVAL_MIN`). */
  pollIntervalMin: number
  /** Epoch ms of the last finished import run, or null if it never ran. */
  lastRunMs: number | null
}

/** Plural «счёт/счёта/счетов» — the checklist reads as a sentence, not as «2 счет». */
function accountsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'счёт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'счёта'
  return 'счетов'
}

/**
 * Build the readiness checklist. Order is the order an admin must act in: connect a bank (or accept
 * manual upload), pick a chat, provision smart processes, then confirm polling is on. Manual upload
 * never depends on any of this, which the bank hint says out loud.
 */
export function buildReadiness(snap: ReadinessSnapshot): ReadinessItem[] {
  const cfg = snap.settings.recognition?.configFields
  const spReady = paymentSpEtid(cfg) !== null && distributionSpEtid(cfg) !== null

  const chatId = snap.settings.chat?.dialogId ?? ''

  return [
    {
      key: 'bank',
      title: 'Банк подключён',
      ok: snap.connectedAccounts > 0,
      detail: snap.connectedAccounts > 0
        ? `${snap.connectedAccounts} ${accountsWord(snap.connectedAccounts)}`
        : 'нет подключений',
      hint: snap.connectedAccounts > 0
        ? ''
        : 'Подключите счёт в разделе «Подключение банка». Без него работает только ручная загрузка файла выписки.'
    },
    {
      key: 'chat',
      title: 'Чат для уведомлений выбран',
      ok: chatId !== '',
      detail: chatId !== '' ? (snap.settings.chat?.title || 'выбран') : 'не выбран',
      hint: chatId !== '' ? '' : 'Выберите чат в разделе «Уведомления в чат» — туда приложение пишет о новых операциях.'
    },
    {
      key: 'smart-process',
      title: 'Смарт-процессы распределения настроены',
      ok: spReady,
      detail: spReady ? 'созданы' : 'не созданы',
      hint: spReady ? '' : 'Нажмите «Настроить смарт-процессы». Без них приложение не сможет вести учёт распределения оплат.'
    },
    {
      key: 'poll',
      title: 'Автоматический опрос банка включён',
      ok: snap.pollEnabled,
      detail: snap.pollEnabled ? `каждые ${snap.pollIntervalMin} мин` : 'выключен',
      // The gate is server-side, so a portal admin genuinely cannot fix this themselves — say so
      // instead of showing an action they can't perform.
      hint: snap.pollEnabled ? '' : 'Опрос выключен на сервере приложения. Обратитесь к владельцу приложения — из портала это не включается.'
    }
  ]
}

/** True when every checklist line is ok — the app is fully set up. */
export function isFullyReady(items: readonly ReadinessItem[]): boolean {
  return items.every(i => i.ok)
}

// There is deliberately NO «next poll at» here. The obvious formula (last run + interval) is wrong
// twice over: the cron is a bare setInterval anchored at PROCESS BOOT, so it has no relationship to
// when a batch last reached crm-sync; and `lastRunMs` is stamped only when a run actually produced
// operations, so a faithfully-polling quiet portal looks hours stale. Showing the period and being
// honest that the exact moment is unknown beats a confidently wrong prediction.
