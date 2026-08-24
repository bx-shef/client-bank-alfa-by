// Manual «Опросить сейчас» — guarded on-demand bank poll for testing/debugging (#54). Pure
// logic over injected I/O (DI), unit-testable without Redis/DB/B24. The thin route
// (server/api/poll-now.post.ts) wires the live transports + mints now/window.
//
// #54 is explicit that poll frequency is regulated APP-SIDE, never by a portal user/admin —
// a portal admin must not be able to outrun the bank's rate limit (a ban hits the shared app).
// This endpoint honours that with four layers, none of which the caller controls:
//   1. QUEUES — `enabled`: without Redis the enqueue would silently no-op, so we answer 503 instead
//      of pretending the poll started. ⚠ Своего ВЫКЛЮЧАТЕЛЯ у ручного опроса больше нет
//      (`MANUAL_POLL_ENABLED` снят 2026-08-23, решение владельца): кнопка нужна на каждом портале,
//      а частоту держат остальные три слоя, ни один из которых вызывающий не контролирует.
//   2. ADMIN GATE — the frame token must belong to THIS portal (blocks X-B24-Domain spoofing) and
//      the caller must be a portal admin.
//   3. PER-PORTAL COOLDOWN — a Redis NX-EX slot (`claimSlot`): within the cooldown a repeat poll is
//      429'd, so the button can't be hammered to exceed the bank rate. Only claimed when there is
//      real work (≥1 connected account), so a no-op poll doesn't burn the window.
//   4. GLOBAL RATE-LIMITER (A8) — the bank-fetch queue's fleet-wide limiter still caps the actual
//      Alfa calls downstream, and idempotent fetch jobIds absorb double-clicks within a tick.
// It only ever polls the caller's OWN portal's connected accounts (listAccounts is member-scoped).

import { accountsForPolling, planFetches, pollWindow } from '../queue/cron'
import { dayVerdictMessage, isoDayFromMs, pollDayVerdict } from '../../app/utils/dayValue'
import type { FetchJob } from '../queue/topology'
import type { BankAccountRef } from './bankTokenStore'

export interface PollNowResult {
  status: number
  body: Record<string, unknown>
}

export interface PollNowDeps {
  /** Очереди доступны (Redis). Нет ⇒ 503: постановка задачи молча ничего не сделала бы. */
  enabled: boolean
  /** Cooldown length (seconds) for the per-portal manual-poll slot. */
  cooldownSec: number
  /** Statement lookback window (days) — same rolling window the cron poll uses. */
  lookbackDays: number
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame token against `domain` (`profile`), returning the user's admin flag, or
   *  THROWING if the token isn't valid for that portal (blocks domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** The portal's connected bank accounts (member-scoped — never another portal's). */
  listAccounts: (memberId: string) => Promise<BankAccountRef[]>
  /** Claim the per-portal cooldown slot (Redis NX-EX). true ⇒ proceed; false ⇒ still cooling down. */
  claimSlot: (memberId: string, ttlSec: number) => Promise<boolean>
  /** Enqueue one bank-fetch job (idempotent jobId absorbs double-enqueue within a tick). The
   *  return is ignored (enqueueFetch resolves a boolean; no-ops false without Redis). */
  enqueue: (job: FetchJob) => Promise<unknown>
  /** Now, epoch ms — used for the poll window AND the fetch `epoch` (a fresh fetch, not deduped). */
  nowMs: number
}

export interface PollNowInput {
  accessToken: string
  domain: string
  /** Один день `ГГГГ-ММ-ДД` для точечного забора (#592). Пусто ⇒ обычное скользящее окно.
   *  ⚠ Именно ОДИН день, а не интервал: интервал — это N задач к банку за один клик, то есть
   *  нагрузка, которую портал задавал бы себе сам вопреки #54 («частоту регулируем мы»). */
  day?: string
  /**
   * Точечный забор ПО ОДНОМУ подключению (#19): банк и номер счёта.
   *
   * ⚠ Заведено потому, что «забрать за 18 августа» без адреса — это задача на КАЖДЫЙ подключённый
   * счёт портала, а человек смотрел на конкретную строку и про неё спрашивал. На портале с двумя
   * банками ответ «опрос запущен» не говорил, ЧТО именно опрошено, а лимит запросов тратился на
   * счета, о которых не спрашивали.
   *
   * Пусто ⇒ прежнее поведение: все подключённые счета портала.
   */
  provider?: string
  accountKey?: string
}

/** Default manual-poll cooldown (seconds): a manual test poll no more than once per minute per
 *  portal — comfortably below any bank rate limit even before the global limiter. */
export const DEFAULT_MANUAL_POLL_COOLDOWN_SEC = 60

/**
 * Handle a manual poll request. Returns 200 `{enqueued, accounts, cooldownSec}` on success, or a
 * 4xx/5xx `{error}`. Enqueues one bank-fetch job per connected pollable account for a rolling
 * window; inert (200, enqueued:0) when the portal has no connected accounts yet.
 */
export async function handlePollNow(deps: PollNowDeps, input: PollNowInput): Promise<PollNowResult> {
  if (!deps.enabled) return { status: 503, body: { error: 'очередь недоступна — опрос сейчас не запустить' } }

  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }

  // ⚠ День проверяется ДО любых REST-вызовов и ДО заявки на кулдаун: отвергнутая дата не должна
  // стоить портала ни обращения к Bitrix24, ни минуты паузы — иначе опечатка в календаре
  // блокировала бы исправную кнопку.
  const day = (input.day || '').trim()
  if (day) {
    const verdict = pollDayVerdict(day, isoDayFromMs(deps.nowMs))
    if (verdict !== 'ok') return { status: 400, body: { error: dayVerdictMessage(verdict) } }
  }

  // Portal key check — do we hold tokens for this domain's portal?
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  // Prove the frame token belongs to THIS portal (blocks X-B24-Domain spoofing) AND read admin.
  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  // Admin-only: a manual poll is an operator/test action, not a regular user feature (#54).
  if (!frame.isAdmin) return { status: 403, body: { error: 'manual poll requires a portal administrator' } }

  // Only poll accounts of THIS portal, filtered to pollable providers (drops Prior until A5b / demo).
  const accounts = await deps.listAccounts(memberId)
  // ⚠ Отбор ДО `accountsForPolling`, а не после: тот сворачивает счета в план по порталам, и
  // выцеплять оттуда одну строку значило бы разбирать структуру, которую только что собрали.
  // ⚠ Сравнение ТОЧНОЕ и по обоим полям: один и тот же номер у разных банков — разные строки
  // хранилища, и отбор по одному номеру опросил бы чужое подключение.
  const wantProvider = (input.provider || '').trim()
  const wantAccount = (input.accountKey || '').trim()
  const targeted = wantProvider || wantAccount
  const scoped = targeted
    ? accounts.filter(a => a.provider === wantProvider && a.accountKey === wantAccount)
    : accounts
  // ⚠ Просили конкретный счёт, а его нет — это 404, а не тихий «enqueued: 0». Второе неотличимо от
  // «портал вообще ничего не подключил», и человек, чей счёт только что отключили из соседней
  // вкладки, читал бы его как «опрос сработал, но операций нет».
  if (targeted && scoped.length === 0) {
    return { status: 404, body: { error: 'подключение не найдено — обновите список' } }
  }
  const byPortal = accountsForPolling(scoped)
  const pollable = byPortal.reduce((n, p) => n + p.accounts.length, 0)
  // No connected accounts yet → nothing to do; do NOT burn the cooldown on a no-op.
  // ⚠ Адресованный счёт есть, но опрашивать его нельзя (пауза, ожидающий ключ) — тоже НЕ тишина:
  // строка на экране выглядит подключённой, и «0 задач» без объяснения читается как поломка кнопки.
  if (pollable === 0 && targeted) {
    return { status: 409, body: { error: 'это подключение сейчас не опрашивается — снимите паузу или выберите счёт' } }
  }
  if (pollable === 0) return { status: 200, body: { enqueued: 0, accounts: 0 } }

  // Per-portal cooldown: reject a too-soon repeat so the button can't outrun the bank rate.
  const claimed = await deps.claimSlot(memberId, deps.cooldownSec)
  if (!claimed) {
    return { status: 429, body: { error: 'manual poll on cooldown', cooldownSec: deps.cooldownSec } }
  }

  // Fresh fetch: `epoch` = now, so the fetch jobId is distinct from a same-window cron poll and
  // actually re-fetches (crm-sync still dedupes writes by the B24 marker).
  // ⚠ Точечный день (#592) заменяет окно ЦЕЛИКОМ (`dateFrom = dateTo = day`), а не расширяет его:
  // «забрать за 17 августа» и должно спросить банк ровно про 17 августа — одна задача, один запрос.
  const { dateFrom, dateTo } = day
    ? { dateFrom: day, dateTo: day }
    : pollWindow(new Date(deps.nowMs), deps.lookbackDays)
  const jobs = planFetches(byPortal, dateFrom, dateTo, String(deps.nowMs))
  for (const job of jobs) await deps.enqueue(job)

  // `day` возвращаем эхом: интерфейс подтверждает человеку, ЗА КАКОЙ день ушла задача, — иначе
  // выбранная дата и ответ «опрос запущен» связаны только его памятью.
  // Банк и счёт возвращаются эхом по той же причине, что и день: без них «опрос запущен» не
  // говорит, ЧТО опрошено, а на портале с двумя банками это и есть весь вопрос (#19).
  return {
    status: 200,
    body: {
      enqueued: jobs.length,
      accounts: pollable,
      cooldownSec: deps.cooldownSec,
      ...(day ? { day } : {}),
      ...(targeted ? { provider: wantProvider, accountKey: wantAccount } : {})
    }
  }
}
