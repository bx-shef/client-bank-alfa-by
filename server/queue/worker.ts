// BullMQ worker runtime: binds each queue to its pure handler with live deps.
// Started once on server boot by server/plugins/queue.ts (only when REDIS_URL is
// set). For horizontal scale-out the same startWorkers() can run in a dedicated
// worker container (documented in docs/REFACTOR_PLAN.md) — the handlers don't care
// where they run. CRM-sync transports (findCompany/writeActivity + dedup) and the
// file-parse transport (manual import) are LIVE; only the bank fetch transport
// (Alfa/Prior online polling) is still a stub until stage 5 fills it in.

import { Worker } from 'bullmq'
import { connectionOptions } from './connection'
import { Q_CRM, Q_EVENTS, Q_FETCH, Q_PARSE } from './topology'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'
import { demoDelayMs, demoItems, isDemoAccount } from './cron'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob,
  MAX_RESOLVED_INTENTS_PER_OP, type HandlerDeps
} from './handlers'
import { enqueueCrmSync } from './producers'
import { dbQuery } from '../db/client'
import { deleteToken, saveToken } from '../utils/tokenStore'
import { deleteImportResultForPortal, saveImportResult } from '../utils/importResultStore'
import { bumpCounters, deleteMetricsForPortal, metricsFromSummary } from '../utils/metricsStore'
import { decryptSecret } from '../utils/secretCrypto'
import { createPortalSdkResolver, type PortalRestResolver } from '../utils/portalSdkResolver'
import { sdkPortalDeps } from '../utils/b24Sdk'
import { B24_REQUIRED_SCOPES } from '../../app/config/b24'
import { logSafe } from '../utils/logSafe'
import { findCompanyByAccount } from '../utils/companyLookup'
import { writeConfigurableActivityViaRest } from '../utils/configurableActivityWrite'
import { findActivityByMarker } from '../utils/activityMarkerLookup'
import { ACTIVITY_ORIGINATOR_ID } from '../../app/utils/configurableActivity'
import { notifyChatViaRest } from '../utils/chatNotifyWrite'
import { notifyAllocationErrorViaRest } from '../utils/allocationErrorNotify'
import { deleteFactsForPortal, getAllocationFact, recordAllocation } from '../utils/allocationFactStore'
import { deleteBankTokensForPortal } from '../utils/bankTokenStore'
import { executeTriggerViaRest, payAllocationViaRest } from '../utils/allocationMutationWrite'
import { makeApplyTrigger } from '../utils/applyTriggerDep'
import { buildAllocationMutation } from '../../app/utils/allocationMutation'
import { allocationFactKey } from '../../app/utils/allocation'
import { readAppSettingVia } from '../utils/appSettings'
import { parseManualFileBase64 } from '../utils/importIngest'
import { findInvoicesByNumber } from '../utils/invoiceLookup'
import { findCandidateById, findCandidateByField } from '../utils/itemByIdLookup'
import { findCompanyDealPayments } from '../utils/paymentLookup'
import { findOrderPaymentIds } from '../utils/saleLookup'
import { resolveIntentsForOp, type IntentResolverDeps } from '../utils/intentResolver'
import { buildPortalNegativeStagePredicate, failOpenEntities } from '../utils/negativeStages'
import { SETTINGS_KEY, parsePortalSettings } from '../../app/utils/settings'

/** Entity resolvers the intent dispatch composes (#109 slice 2). Bound once. */
const intentResolverDeps: IntentResolverDeps = { findInvoicesByNumber, findCandidateById, findCandidateByField, findCompanyDealPayments, findOrderPaymentIds }

// Per-portal RestCall resolver for every crm-sync REST op (#191). Transport is the
// @bitrix24/b24jssdk SDK: its per-instance RestrictionManager IS the rate-limiter
// (leaky-bucket + backoff on QUERY_LIMIT_EXCEEDED). The client is MEMOISED per portal for a
// short TTL (per-JOB memoisation — one rate-limiter bucket + one token load per job), rebuilt
// from the current DB token on TTL lapse or evict-on-error; refresh is reactive and persisted
// UPDATE-only via tombstone-guarded saveToken. The SDK refreshes OUTSIDE our advisory lock — a
// lost rotation race is a transient BullMQ retry, not corruption (see portalSdkResolver.ts);
// the advisory lock still serialises the proactive keep-alive cron (#175). The former
// advisory-locked `callRest` resolver (bind-once, lever-2) was retired once the SDK became the
// default transport.
const resolvePortalCall: PortalRestResolver = createPortalSdkResolver(sdkPortalDeps({
  query: dbQuery,
  clientId: process.env.B24_CLIENT_ID ?? '',
  clientSecret: process.env.B24_CLIENT_SECRET ?? '',
  now: Date.now,
  scope: B24_REQUIRED_SCOPES.join(',')
}))

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Artificial processing delay for the load demo (env DEMO_DELAY_MS), so the demo's
 *  fetch/crm-sync jobs sit in the queues long enough to show a visible backlog on
 *  the chart. Applied ONLY to demo accounts; real jobs never wait. Read once. */
const DEMO_DELAY = demoDelayMs(Number(process.env.DEMO_DELAY_MS ?? 600))
const demoPause = (account: string): Promise<void> =>
  isDemoAccount(account) && DEMO_DELAY > 0 ? delay(DEMO_DELAY) : Promise.resolve()

/** Live side-effects for the handlers. Transports are stubs for now (return the
 *  demo batch / nothing) with TODOs pointing at the stage that fills them in. */
export function liveHandlerDeps(): HandlerDeps {
  return {
    // TODO stage 3/5: real Alfa/Prior transport. For now emits synthetic ops only
    // for DEMO- accounts (the load demo), and nothing for real accounts. The demo
    // pause makes bank-fetch show a visible backlog (real accounts: no pause, []).
    fetchStatement: async (job) => {
      await demoPause(job.account)
      return demoItems(job)
    },
    // Manual import: decode the windows-1251 file carried in the packet and parse it
    // to operations (server is the single parse authority). Demo/fetch path is
    // unaffected — parseFile only runs for file-parse jobs (real uploads). Log the
    // attribution (file + initiating user + portal) so the resolved userId/fileName
    // have a real consumer, not just the payload.
    parseFile: async (job) => {
      const items = parseManualFileBase64(job.contentBase64)
      // fileName is the operator-supplied upload name (untrusted) → logSafe it like
      // account/docId elsewhere, so a crafted name can't inject forged log lines.
      console.log(`[import] parsed ${items.length} ops from "${logSafe(job.fileName)}" — portal ${job.memberId}, user ${job.userId ?? '—'}`)
      return items
    },
    // Find the CRM company by the counterparty's settlement account. Demo accounts
    // are GATED (never touch a real portal's REST); an unknown portal (no token)
    // yields null → the op is counted unmatched and nothing is written.
    // #191 lever-2 DONE: the per-portal RestCall is resolved ONCE via `resolvePortalCall`
    // (the SDK resolver, memoised per portal per job) and reused across findCompany/
    // resolveIntents/writeActivity/notifyChat/applyAllocation/notifyError, instead of
    // re-loading+refreshing the token per op. lever-1 DONE: the SDK's built-in
    // RestrictionManager (b24Sdk.ts) is the per-portal rate-limiter (leaky-bucket + backoff on
    // QUERY_LIMIT_EXCEEDED); the SDK also refreshes reactively on `expired_token`. The remaining
    // #191 lever is `callList` batching (findCompany ~2 calls + resolveIntents up to
    // MAX_RESOLVED_INTENTS_PER_OP lookups — the payment-number pool is ONE company scan per op
    // (#192) — + writeActivity 1 call per op); see docs/QUEUES.md §REST-бюджет.
    findCompany: async (item, memberId) => {
      // Demo ops: pause (so crm-sync shows a backlog too) then skip — never REST.
      if (isDemoAccount(item.account)) {
        await demoPause(item.account)
        return null
      }
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      return findCompanyByAccount(item.counterparty.account, call)
    },
    // Write the operation as a CONFIGURABLE activity (crm.activity.configurable.add) attached
    // to the matched company; returns the new activity id or null when skipped (demo account /
    // no company → no owner / unknown portal). The activity carries the ORIGINATOR_ID/ORIGIN_ID
    // dedup marker (#259), so idempotency lives in B24 (getActivityId searches it) — no store.
    writeActivity: async (item, companyId, memberId) => {
      if (isDemoAccount(item.account) || !companyId) return null
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      return writeConfigurableActivityViaRest(item, companyId, call)
    },
    // Read the portal's FULL settings blob (chat target + rules + recognition matrices)
    // from app.option ONCE per job (#16, #109). One read feeds both the chat and the
    // recognition steps. Goes through the SAME bind-once resolver as the per-op calls, so
    // this gating read shares the reactive expired_token retry (#191): it runs FIRST and can
    // hard-fail the whole job, so a clock-fresh-but-server-rejected token must self-heal here
    // too (force-refresh+retry-once) instead of looping BullMQ retries until clock-expiry.
    getPortalSettings: async (memberId) => {
      // null call = portal genuinely not installed (e.g. demo memberId with no token) → no
      // settings (chat + recognition off), same as the old PortalNotInstalledError branch.
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      // A TRANSIENT error (non-auth REST) still throws out of `call` → fails the job BEFORE
      // any activity is written (this runs before the loop) → clean retry recovers the writes
      // and announcements. An expired_token is absorbed by the resolver's retry, not thrown.
      return parsePortalSettings(await readAppSettingVia(call, SETTINGS_KEY))
    },
    // Recognition intent (§4, #109) — LOG-ONLY this slice: record what was recognized in
    // the purpose and where each identifier would route, so coverage is observable on the
    // real portal before the lookup slice drives allocation. No REST, never throws.
    // account/docId come from the parsed statement (a manual-import file is operator-
    // supplied, not payer-controlled, but still untrusted) → strip control chars so a
    // crafted value can't inject fake log lines. The recognized `value` is normally safe
    // (digits+mask literals, MAX_ID_CHARS-clamped) but the mask literals come from
    // app.option (admin-writable, not control-char filtered) → logSafe it too.
    onRecognized: (item, intents, memberId) => {
      const summary = intents.map(i => `${i.kind}=${logSafe(i.value)}→${i.route.targetKind ?? 'document'}/${i.route.strategy}`).join(', ')
      console.log(`[recognize] portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${summary}`)
      // Observability (#242): the resolver caps REST lookups at MAX_RESOLVED_INTENTS_PER_OP,
      // so any intents beyond that are silently dropped (a payer with a purpose stuffed full
      // of ids can't otherwise be seen). Surface the truncation so it's visible in logs.
      if (intents.length > MAX_RESOLVED_INTENTS_PER_OP) {
        console.warn(`[recognize] portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${intents.length} intents, capped to ${MAX_RESOLVED_INTENTS_PER_OP} for REST lookup (${intents.length - MAX_RESOLVED_INTENTS_PER_OP} dropped)`)
      }
    },
    // Resolve recognized intents to allocation candidates via the entity lookups (#109
    // slice 3 — wiring the slice-2 dispatcher), scoped to the matched company and dropping
    // negative-stage entities (`isNegativeStage`, loaded once per job). LOG/COUNT only —
    // nothing is written. No portal token → []. REST per op with a recognized id: the
    // handler caps the intent count, and the payment-number pool is fetched once per op
    // (#192, not per value) — but the pool scan itself is still unbatched/unpaginated;
    // global rate-limit + bind-RestCall-once remain (see the TODO above / #191). A REST
    // error propagates (handler fails the job → clean retry), like findCompany.
    resolveIntents: async (intents, companyId, memberId, isNegativeStage, configFields) => {
      const call = await resolvePortalCall(memberId)
      if (!call) return []
      // Batch resolver fetches the deal-payment pool once per op (#191), not per value.
      // configFields (portal «карта сопоставления») drives the by-config-field kinds (deal-field).
      return resolveIntentsForOp(intents, { companyId, isNegativeStage, configFields }, call, intentResolverDeps)
    },
    // Load the portal's negative-stage predicate (union of invoice + deal fail/lost
    // stages) so intent resolution drops paid/«Не оплачен»/lost candidates. Called at most
    // ONCE per job by the handler. No portal token → null (resolution proceeds unfiltered).
    // FAIL-OPEN ALERT: an empty negative set is indistinguishable from a broken query /
    // trimmed rights — a real portal's invoice/deal funnel always has ≥1 fail/lost stage,
    // so 0 negatives across ≥1 funnel (invoice OR deal, symmetric) is warned (else we'd
    // allocate onto a «Не оплачен» invoice / lost deal). A REST error propagates (fail the
    // job → clean retry).
    loadNegativeStagePredicate: async (memberId) => {
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      // Batch the per-funnel `crm.status.list` fan-out into one request (#191). The batch
      // shares the SAME memoised SDK client (rate-limiter bucket) as `call`.
      const batch = await resolvePortalCall.batch(memberId)
      const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call, batch)
      const suspicious = failOpenEntities(diagnostics)
      if (suspicious.length > 0) {
        const detail = suspicious.map((e) => {
          const d = e === 'invoice' ? diagnostics.invoice : diagnostics.deal
          return `${e}(funnels=${d.categories},neg=${d.negativeStages},empty=${d.emptyCategories})`
        }).join(' ')
        console.warn(`[stage] portal ${memberId}: suspicious negative-stage load — ${detail} (a funnel with 0 lost/fail stages, or none enumerated) — check rights/config; those entities won't be stage-excluded (fail-open)`)
      }
      return predicate
    },
    // Observe what each intent resolved to (log-only coverage). account/docId + value
    // sanitized (logSafe) like onRecognized; kind/status are safe internal data.
    onResolved: (item, resolutions, memberId) => {
      const summary = resolutions.map(r => `${r.kind}=${logSafe(r.value)}:${r.status}(${r.candidates.length})`).join(', ')
      console.log(`[resolve] portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${summary}`)
    },
    // Observe the allocation decision (§2). This callback only LOGS; the fact is persisted
    // by the `recordAllocation` dep below (#184). Target id/kind are internal (CRM ids, not
    // payer-controlled); account/docId sanitized.
    onAllocationDecision: (item, decision, triggerTargets, memberId) => {
      const detail = decision.action === 'allocate'
        ? `allocate ${decision.target.kind}#${decision.target.id}${decision.ambiguous ? ` ambiguous(+${decision.alternatives.length})` : ''}`
        : decision.action === 'manual'
          ? `manual(${decision.candidates.length} candidates, no exact match)`
          : 'none'
      console.log(`[allocate] portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${detail}${triggerTargets ? ` +${triggerTargets} trigger` : ''}`)
    },
    // Post the announcement via im.message.add. The decision (target + rules) was made
    // in handleCrmSyncJob; here we only send. Demo accounts are GATED (never real REST);
    // no portal token → skip. The WHOLE body is guarded (incl. resolvePortalCall's token
    // load + OAuth refresh) — a chat failure is swallowed+logged, NEVER propagated: the
    // activity is already written+remembered, so failing the job would skip the op on
    // retry and lose the record (нюанс 3).
    notifyChat: async (item, dialogId, memberId) => {
      if (isDemoAccount(item.account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifyChatViaRest(item, dialogId, call)
      } catch (e) {
        console.error('chat notify failed', memberId, (e as Error)?.message)
      }
    },
    // Persist the allocation fact «платёж → сущность» (#184), write-once per (portal,
    // factKey). Demo accounts are GATED (never touch the real store). A store error
    // PROPAGATES (unlike notifyChat) — it runs BEFORE the activity write, so a retry is
    // clean; the fact write must not be silently lost.
    recordAllocation: (item, target, memberId) => {
      if (isDemoAccount(item.account)) return Promise.resolve(false)
      return recordAllocation(dbQuery, memberId, allocationFactKey(item, target), target.kind, target.id)
    },
    // Idempotency pre-check for the mutation slice (#109 §2): does a fact already exist
    // for this (payment → target)? Demo accounts GATED (never touch the store). Consulted
    // only when autoDistribute is on. A store error propagates (fail the job).
    hasAllocationFact: async (item, target, memberId) => {
      if (isDemoAccount(item.account)) return false
      return (await getAllocationFact(dbQuery, memberId, allocationFactKey(item, target))) !== null
    },
    // Portal MUTATION for a decided allocate target (#109 §2): mark it paid
    // (`crm.item.payment.pay` / invoice `crm.item.update`). Demo accounts GATED (never real
    // REST). A REST error PROPAGATES (runs before the fact write, so a retry is clean).
    // Returns whether a portal write was actually applied.
    //
    // `!call` (no portal token) has TWO distinct causes we must NOT conflate (#77 review):
    //   - the target has NO v1 mutation anyway (trigger kind, or invoice w/o configured
    //     stage) — `buildAllocationMutation` is `null`, so there is nothing to write and
    //     fact-only is correct → return false (no mutation, caller records the fact);
    //   - the target IS mutatable but the portal token is transiently unavailable (refresh
    //     failed / mid-batch uninstall) — recording a fact now would PERMANENTLY block the
    //     pay (`hasAllocationFact` short-circuits every retry) for a payment we never paid.
    //     A transient failure is NOT an uninstall, so `deletePortal` won't purge it — no
    //     self-heal. THROW instead → the job retries cleanly, no fact until the pay lands.
    applyAllocation: async (item, target, memberId, opts) => {
      if (isDemoAccount(item.account)) return false
      const call = await resolvePortalCall(memberId)
      if (!call) {
        if (buildAllocationMutation(target, opts)) {
          throw new Error(`applyAllocation: no portal token for ${memberId} — retry (mutation pending)`)
        }
        return false // unsupported target: nothing to write, fact-only is correct
      }
      const res = await payAllocationViaRest(target, call, opts)
      // THIRD failure mode (besides transport-throw and no-token, both handled above): the
      // pay REST call WAS made but the portal did NOT confirm the write (`{result:false}` —
      // e.g. a soft business-rule rejection), and that is NOT an `unsupported` target (which
      // legitimately writes nothing and is fact-only). Returning false here would let the
      // caller record the idempotency fact for a payment that was never applied →
      // `hasAllocationFact` then PERMANENTLY blocks every retry, leaving a «разнесён» fact on
      // an unpaid target (the exact poison the no-token branch throws to avoid). THROW so the
      // job retries; a genuinely permanent rejection surfaces via retry exhaustion, not a
      // silent success. (`skipped:'unsupported'` still returns false → fact-only, unchanged.)
      if (!res.applied && res.skipped !== 'unsupported') {
        throw new Error(`applyAllocation: portal did not confirm ${res.method ?? 'pay'} for ${target.kind}#${target.id} (member ${memberId}) — retry`)
      }
      return res.applied
    },
    // Fire the portal automation trigger for a decided trigger target (#79). BEST-EFFORT,
    // like notifyChat — a trigger SIGNALS «деньги пришли» (the client's BP allocates), it does
    // NOT move money, so a failure must NEVER fail the whole batch. Returns whether it actually
    // FIRED (`{result:true}`); the handler records the write-once fact ONLY on a fire. Any
    // failure — a transient token/limit error, or a PERMANENT config error (a `triggerCode` set
    // but never registered via `crm.automation.trigger.add` → «...is not registered») — is
    // swallowed+logged and returns false (no cross-batch failure storm). NOTE: because the swallow
    // keeps the job succeeding, the handler's B24 dedup marker is still written, so this is
    // SINGLE-SHOT — a swallowed miss is NOT re-attempted on a later poll (durable retry is a
    // follow-up). Demo gated; no token → skip. `crm.automation.trigger.execute` needs OAuth
    // app-context — the resolver's SDK call provides it (a webhook gets «Application context
    // required»). `executeTriggerViaRest` (#269) takes the CODE via `opts.triggerCode`.
    applyTrigger: makeApplyTrigger({ isDemoAccount, resolvePortalCall, executeTriggerViaRest }),
    // Post an ambiguous/manual allocation notice to the error chat. Same guarantees as
    // notifyChat: demo accounts gated, no token → skip, whole body swallow+logged (a chat
    // failure must never fail the job).
    notifyError: async (item, decision, dialogId, memberId) => {
      if (isDemoAccount(item.account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifyAllocationErrorViaRest(item, decision, dialogId, call)
      } catch (e) {
        console.error('alloc error notify failed', memberId, (e as Error)?.message)
      }
    },
    // Read-before-write dedup guard (#259): search Bitrix24 for our marker
    // (ORIGINATOR_ID + ORIGIN_ID; key = ORIGIN_ID = account|docId). The marker is written
    // ATOMICALLY with the activity (configurable.add), so B24 is the source of truth — no DB
    // store and no separate "remember" step (the write→remember gap is closed). Demo/no-token
    // → null (proceed as "not written").
    getActivityId: async (memberId, key) => {
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      return findActivityByMarker(ACTIVITY_ORIGINATOR_ID, key, call)
    },
    // Register a portal: decrypt the refresh blob carried in the job (never plain
    // in Redis) and upsert the token row (write-once application_token in saveToken).
    // No DATABASE_URL guard: if the DB is missing/down, saveToken throws → BullMQ
    // retries and, on exhaustion, keeps the job in the failed set (never a silent
    // no-op that would ack a never-persisted install). `envCheck` errors on a
    // missing DATABASE_URL at boot.
    savePortal: async (job) => {
      if (!job.credentials) return
      const c = job.credentials
      // eventTs (#77): a stale register that retries after a newer uninstall is a no-op
      // (saveToken refuses to write over a same-or-newer tombstone).
      await saveToken(dbQuery, {
        memberId: job.memberId,
        domain: job.domain,
        accessToken: c.accessToken,
        refreshToken: c.refreshTokenEnc ? decryptSecret(c.refreshTokenEnc) : '',
        expiresAt: c.expiresAt,
        applicationToken: c.applicationToken
      }, Number(job.ts) || 0)
    },
    // Uninstall always erases EVERYTHING for the portal: token row + import status +
    // allocation facts (#184) + lifetime metrics + connected bank tokens (stage 5). `eventTs`
    // records the ordering tombstone (#77). Activity dedup
    // now lives in B24 (the marker on the activity itself), so there's no local dedup map to
    // purge — the client's own CRM keeps the activities. Also evict the in-memory bind-once
    // RestCall (#191) so a just-uninstalled portal's cached access token can't be reused by an
    // in-flight job — restores the instant cutoff (the DB row is gone; the cache isn't).
    deletePortal: async (memberId, eventTs) => {
      await deleteToken(dbQuery, memberId, eventTs)
      await deleteImportResultForPortal(dbQuery, memberId)
      await deleteFactsForPortal(dbQuery, memberId)
      await deleteMetricsForPortal(dbQuery, memberId)
      await deleteBankTokensForPortal(dbQuery, memberId) // stage-5 bank creds — a removed app keeps none
      resolvePortalCall.evict(memberId)
    },
    enqueueCrmSync
  }
}

/** The `b24-events` worker (install/uninstall). MUST run on a SINGLE instance: it
 *  stays at concurrency 1 for per-portal ordering, but that only holds within ONE
 *  process — so the plugin runs it on the primary (cron) instance, NEVER on scaled
 *  worker replicas (else ONAPPINSTALL/ONAPPUNINSTALL for one portal could reorder
 *  across replicas and leave a live token after an uninstall). */
export function startEventWorker(deps: HandlerDeps): Worker {
  return new Worker<EventJob>(Q_EVENTS, async job => handleEventJob(job.data, deps), { connection: connectionOptions() })
}

/** The throughput workers (fetch/parse/crm-sync) — safe to run on N scaled replicas
 *  (Redis hands each job to exactly one). `concurrency` (default 1 = unchanged)
 *  applies to all three.
 *  ⚠ Raising crm-sync concurrency OR running >1 replica needs (a) a per-portal REST
 *  limiter (else a big batch hits B24 `QUERY_LIMIT` — batch/`callBatch` is the real
 *  lever) and (b) ATOMIC dedup. Dedup is the B24 marker (`findActivityByMarker` →
 *  `configurable.add` stamps ORIGINATOR_ID/ORIGIN_ID atomically, #259), but the search→write
 *  is still two calls: under parallelism two workers could both miss the marker and
 *  double-write a dela (TOCTOU) — see #109/#259/PROCESSING §1. Until a per-portal limiter
 *  lands, keep crm-sync effectively serial; fetch/parse scale freely. See docs/QUEUES.md. */
export function startThroughputWorkers(deps: HandlerDeps, opts: { concurrency?: number } = {}): Worker[] {
  const connection = connectionOptions()
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  return [
    // TODO stage 5: once fetchStatement hits the real Alfa API (100 req/min), add a
    // limiter here — new Worker(..., { connection, limiter: { max: 100, duration: 60_000 } }).
    new Worker<FetchJob>(Q_FETCH, async job => handleFetchJob(job.data, deps), { connection, concurrency }),
    new Worker<ParseJob>(Q_PARSE, async job => handleParseJob(job.data, deps), { connection, concurrency }),
    new Worker<CrmSyncJob>(Q_CRM, async (job) => {
      const summary = await handleCrmSyncJob(job.data, deps)
      // Persist the run for the in-portal status card (#5) — LATEST run per portal.
      // Best-effort: a status-persist failure must NOT fail the job (the CRM writes
      // already happened). Demo batches never touch the real portal's status row.
      await persistImportResult(job.data, summary)
      // Accumulate LIFETIME per-portal counters for the dashboard (#78). Same
      // best-effort/demo-gated contract — bookkeeping must never fail a job.
      await bumpMetrics(job.data, summary)
      return summary
    }, { connection, concurrency })
  ]
}

/** Save the crm-sync run summary as the portal's last import status (#5). Gated to
 *  real (non-demo) portals; swallows errors so status bookkeeping can't fail a job. */
async function persistImportResult(
  job: CrmSyncJob,
  summary: { processed: number, created: number, notified: number }
): Promise<void> {
  const account = job.items[0]?.account ?? ''
  if (!account || isDemoAccount(account)) return
  try {
    await saveImportResult(dbQuery, job.memberId, {
      state: 'ok',
      lastSyncAt: new Date().toISOString(),
      operations: summary.processed,
      activitiesCreated: summary.created,
      chatNotified: summary.notified,
      errors: []
    })
  } catch (e) {
    console.error('import_result save failed', job.memberId, (e as Error)?.message)
  }
}

/** Accumulate lifetime per-portal metric counters from a crm-sync run summary (#78).
 *  Gated to real (non-demo) portals; swallows errors so metrics can't fail a job. */
async function bumpMetrics(
  job: CrmSyncJob,
  summary: { processed: number, created: number, notified: number, unmatched: number, recognized: number, resolved: number, allocated: number, distributed: number, ambiguous: number, manual: number }
): Promise<void> {
  const account = job.items[0]?.account ?? ''
  if (!account || isDemoAccount(account)) return
  try {
    await bumpCounters(dbQuery, job.memberId, metricsFromSummary(summary))
  } catch (e) {
    console.error('metrics bump failed', job.memberId, (e as Error)?.message)
  }
}
