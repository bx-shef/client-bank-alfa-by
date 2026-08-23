// BullMQ worker runtime: binds each queue to its pure handler with live deps.
// Started once on server boot by server/plugins/queue.ts (only when REDIS_URL is
// set). For horizontal scale-out the same startWorkers() can run in a dedicated
// worker container (documented in docs/REFACTOR_PLAN.md) — the handlers don't care
// where they run. CRM-sync transports (findCompany/writeActivity + dedup), the file-parse
// transport (manual import) and the bank fetch transport (Alfa online GET, A9 →
// fetchBankStatement) are LIVE; a real account with no stored bank token fetches nothing
// (inert []), and Prior online fetch throws until A5b. The live Alfa call is rate-limited
// (A8) by a GLOBAL BullMQ queue limiter (fleet-wide, default 80/60s — QUEUE_FETCH_RATE_*).

import { Worker } from 'bullmq'
import { claimCooldownSlot, connectionOptions, incrementWithTtl, queueEnabled } from './connection'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { postFeedbackIssue, type FeedbackFetchFn } from '../utils/feedbackGithub'
import { buildProgramFeedbackIssue, programSignalSignature, summarizeConfusion, type ProgramSample, type ProgramSignal } from '../../app/utils/programFeedback'
import { MAX_FILE_EMBED } from '../../app/utils/feedback'
import { decodeUploadText } from '../../app/utils/importUpload'
import { claimProgramFeedbackSlot, type ProgramFeedbackGateDeps } from '../utils/programFeedbackCap'
import { withSpan } from '../utils/telemetrySpan'
import { portalHash } from '../utils/telemetryAttributes'
import { Q_BINDINGS, Q_CRM, Q_DELETIONS, Q_EVENTS, Q_FEEDBACK, Q_FETCH, Q_FETCH_PRIOR, Q_PARSE, Q_REGISTRY, Q_TRIGGER } from './topology'
import type {
  ActivityBindJob, CrmSyncJob, DeletionJob, EventJob, FeedbackPostJob, FetchJob, ParseJob,
  RegistryWriteJob, TriggerFireJob
} from './topology'
import {
  handleActivityBindJob, handleRegistryWriteJob,
  type ActivityBindJobDeps, type RegistryWriteJobDeps
} from '../utils/deferredWriteJobs'
import { handleFeedbackPostJob, type FeedbackPostJobDeps } from '../utils/feedbackPostJob'
import { handleTriggerFireJob, type TriggerFireJobDeps } from '../utils/triggerFireJob'
import { handleDeletionJob, type DeletionReconcileDeps } from '../utils/deletionReconcile'
import { hasTriggerLedgerFact, reconcileTargetDeletion, writeLedgerAllocation, writeTriggerLedgerFact } from '../utils/distributionLedgerWrite'
import { notifyDeletionErrorViaRest } from '../utils/deletionErrorNotify'
import type { DeletionErrorKind } from '../../app/utils/deletionErrorMessage'
import { livePortalSdkCall } from '../utils/liveDeps'
import { distributionSpRef, paymentSpRef } from '../../app/config/distributionSp'
import { demoDelayMs, demoItems, isDemoAccount } from './cron'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob,
  MAX_RESOLVED_INTENTS_PER_OP, type HandlerDeps
} from './handlers'
import { enqueueActivityBind, enqueueCrmSync, enqueueRegistryWrite, enqueueTriggerFire } from './producers'
import { dedupKey } from '../../app/utils/statement'
import { dbQuery } from '../db/client'
import { deleteToken, getApplicationToken, saveToken } from '../utils/tokenStore'
import { deleteImportResultForPortal, markBankFetch, saveImportResult } from '../utils/importResultStore'
import { deleteBatchesForPortal, saveBatchError, saveBatchResult } from '../utils/importBatchStore'
import { isFinalAttempt } from '../utils/jobAttempt'
import { FEEDBACK_METRICS, bumpCounter, bumpCounters, deleteMetricsForPortal, metricsFromSummary } from '../utils/metricsStore'
import { decryptSecret } from '../utils/secretCrypto'
import { createPortalSdkResolver, type PortalRestResolver } from '../utils/portalSdkResolver'
import { sdkPortalDeps } from '../utils/b24Sdk'
import { B24_REQUIRED_SCOPES } from '../../app/config/b24'
import { resolveOpLogMode, runSummaryLine } from '../../app/utils/opLogPolicy'
import { useServerLogger } from '../utils/serverLogger'
import { buildOpLogLine } from '../utils/opLogLine'
import { logSafe } from '../utils/logSafe'
import { findCompanyByAccount, findMyCompanyByAccount } from '../utils/companyLookup'
import { writeTodoActivityViaRest } from '../utils/todoActivityWrite'
import { writePaymentRegistryViaRest } from '../utils/paymentRegistryWrite'
import { bindActivityViaRest } from '../utils/activityBindingsWrite'
import { notifyUnmatchedViaRest } from '../utils/unmatchedNotify'
import { findActivityByMarker } from '../utils/activityMarkerLookup'
import { ACTIVITY_ORIGINATOR_ID } from '../../app/utils/todoActivity'
import { notifyChatViaRest } from '../utils/chatNotifyWrite'
import { forgetBot } from '../utils/chatBotSend'
import { notifyAllocationErrorViaRest, notifySettingsErrorViaRest, notifyUnresolvedViaRest } from '../utils/allocationErrorNotify'
import { deleteBankTokensForPortal } from '../utils/bankTokenStore'
import { deleteRatingForPortal } from '../utils/appRatingStore'
import { deleteLeasesForPortal } from '../utils/singleFlightLease'
import { fetchBankStatement } from '../utils/bankFetch'
import { executeTriggerViaRest, payAllocationViaRest } from '../utils/allocationMutationWrite'
import { readAllocationApplied } from '../utils/allocationApplied'
import { makeApplyTrigger } from '../utils/applyTriggerDep'
import { buildAllocationMutation } from '../../app/utils/allocationMutation'
import { readAppSettingVia } from '../utils/appSettings'
import { parseManualFileBase64 } from '../utils/importIngest'
import { findInvoicesByNumber } from '../utils/invoiceLookup'
import { findCandidateById, findCandidateByField } from '../utils/itemByIdLookup'
import { findCompanyDealPayments } from '../utils/paymentLookup'
import { findOrderPaymentIds } from '../utils/saleLookup'
import { findDocumentEntities } from '../utils/documentLookup'
import { resolveIntentsForOp, type IntentResolverDeps } from '../utils/intentResolver'
import { buildPortalNegativeStagePredicate, failOpenEntities } from '../utils/negativeStages'
import { SETTINGS_KEY, parsePortalSettings } from '../../app/utils/settings'

// Каналы воркера. Имена совпадают с маркерами, которые уже грепает рантбук (#529): менять их
// «покрасивее» — значит молча сломать `docs/OPERATIONS.md` и `scripts/prod-doctor.sh`.
const fetchLog = useServerLogger('fetch')
// ⚠ `import` — про РУЧНУЮ загрузку (так его трактует рантбук). Отказы сохранения итога и метрик
// сюда не относятся: они срабатывают и на пути автоопроса, поэтому идут в `crm-sync` (ревью #529).
const importLog = useServerLogger('import')
const recognizeLog = useServerLogger('recognize')
const stageLog = useServerLogger('stage')
const resolveLog = useServerLogger('resolve')
const allocateLog = useServerLogger('allocate')
const opLog = useServerLogger('op')
const crmLog = useServerLogger('crm-sync')
const triggerLog = useServerLogger('trigger')
const deletionLog = useServerLogger('deletion')

/** Entity resolvers the intent dispatch composes (#109 slice 2). Bound once. */
const intentResolverDeps: IntentResolverDeps = { findInvoicesByNumber, findCandidateById, findCandidateByField, findCompanyDealPayments, findOrderPaymentIds, findDocumentEntities }

/** Redis dedup + hourly-cap primitives for the program feedback channel (docs/FEEDBACK.md). Bound
 *  to the shared queue client; only used when queueEnabled(). */
const programFeedbackGateDeps: ProgramFeedbackGateDeps = {
  claimDedup: (key, ttl) => claimCooldownSlot(key, ttl),
  incrCap: (key, ttl) => incrementWithTtl(key, ttl),
  now: Date.now
}

// Per-portal RestCall resolver for every crm-sync REST op (#191). Transport is the
// @bitrix24/b24jssdk SDK: its per-instance RestrictionManager IS the rate-limiter
// (leaky-bucket + backoff on QUERY_LIMIT_EXCEEDED). The client is MEMOISED per portal for a
// short TTL (per-JOB memoisation — one rate-limiter bucket + one token load per job), rebuilt
// from the current DB token on TTL lapse or evict-on-error; refresh is reactive and persisted
// UPDATE-only via `updatePortalTokenSecrets` (#510). The SDK refreshes OUTSIDE our advisory lock — a
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
/** Reveal the PAYMENT PURPOSE in the `[op]` log line (`STATEMENT_DEBUG_LOG=1`; default OFF).
 *  Read once at start — flipping it means a restart, which is intended: this is a deliberate,
 *  announced loosening of docs/PRIVACY.md §Логи for a calibration run, not a runtime knob.
 *  Everything else in `[op]` is logged unconditionally; only this field is gated. */
const STATEMENT_DEBUG_LOG = process.env.STATEMENT_DEBUG_LOG === '1'
/** How verbose the per-operation log is (#498): `notable` (default) | `all` | `off`. Read once at
 *  start, exactly like the flag above — flipping it means a restart. The default prints only the
 *  operations that did NOT land; the run summary stays unconditional in every mode. */
const OP_LOG_MODE = resolveOpLogMode(process.env.STATEMENT_OP_LOG)

const DEMO_DELAY = demoDelayMs(Number(process.env.DEMO_DELAY_MS ?? 600))
const demoPause = (account: string): Promise<void> =>
  isDemoAccount(account) && DEMO_DELAY > 0 ? delay(DEMO_DELAY) : Promise.resolve()

/** Live side-effects for the handlers. Transports are stubs for now (return the
 *  demo batch / nothing) with TODOs pointing at the stage that fills them in. */
export function liveHandlerDeps(): HandlerDeps {
  return {
    // Bank fetch (stage 5, A9): DEMO- accounts still emit the synthetic load-demo batch
    // (with the visible-backlog pause); real accounts go through the LIVE transport
    // (fetchBankStatement → ensureBankToken → GET /accounts/statement → normalizeAlfa).
    // A real account with no stored bank token returns [] inertly (not connected yet, or the
    // planner hasn't been given creds); Prior online fetch throws until A5b wires it. The
    // queue layer names the provider field `providerId`; the transport, `provider`.
    fetchStatement: async (job) => {
      if (isDemoAccount(job.account)) {
        await demoPause(job.account)
        return demoItems(job)
      }
      const items = await fetchBankStatement({
        memberId: job.memberId,
        provider: job.providerId,
        account: job.account,
        dateFrom: job.dateFrom,
        dateTo: job.dateTo
      })
      // A poll that answers with NOTHING and a poll that never reached the bank looked identical
      // from outside: both produced silence, because a chained crm-sync only exists when
      // items.length > 0 and a thrown fetch is reported by the failure path. So «no operations»
      // was indistinguishable from «wrong window», «wrong account» and «connection dead» — the
      // first question asked of every live run had no answer anywhere. One line per fetch settles
      // it. Amounts/purposes stay out (docs/PRIVACY.md §Логи); the account is logSafe'd like
      // everywhere else, since the bank echoes operator-supplied values.
      fetchLog.info(`${job.providerId} portal ${job.memberId}, account ${logSafe(job.account)} ${job.dateFrom}..${job.dateTo}: ${items.length} ops`)
      // ⚠ Отмечаем КАЖДЫЙ забор, а не только пустой. `crm-sync` ставится лишь когда операции
      // есть, а сводку прогона пишет именно он — поэтому «банк ответил, операций за этот день
      // нет» не доходило до интерфейса НИКАК, и человек, нажавший «Забрать», не мог отличить это
      // от «кнопка не работает». Ровно на этом застряла проверка забора за день.
      // ⚠ Отметка идёт в СВОИ колонки и сводку прогона не трогает — иначе пустой забор одного
      // счёта затирал бы результат соседнего (у портала один ряд, счетов несколько).
      await markFetchOutcome(job, items.length)
      return items
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
      importLog.info(`parsed ${items.length} ops from "${logSafe(job.fileName)}" — portal ${job.memberId}, user ${job.userId ?? '—'}`)
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
    // Look up MY company by OUR account (item.account) — the UNMATCHED-client fallback owner (#91).
    // Demo gated; no portal token → null. Uses the SAME memoised per-portal RestCall as findCompany.
    findMyCompany: async (item, memberId) => {
      if (isDemoAccount(item.account)) return null
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      return findMyCompanyByAccount(item.account, call)
    },
    // Write the operation as a universal TODO activity (crm.activity.todo.add, #495) attached
    // to the matched company; returns the new activity id or null when skipped (demo account /
    // no company → no owner / unknown portal). The activity carries the ORIGINATOR_ID/ORIGIN_ID
    // dedup marker (#259), so idempotency lives in B24 (getActivityId searches it) — no store.
    // `note` prepends a reason block (UNMATCHED-client fallback to my company, #91).
    writeActivity: async (item, companyId, memberId, note) => {
      if (isDemoAccount(item.account) || !companyId) return null
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      return writeTodoActivityViaRest(item, companyId, call, note, memberId)
    },
    // Привязки дела к сущностям CRM (#579). ЛУЧШИЕ УСИЛИЯ и НИКОГДА не бросает — контракт зепа.
    //
    // ⚠ Здесь `return {bound:0, failed:refs.length}` вместо throw, и это ПРОТИВОПОЛОЖНО соседнему
    // `writePaymentRegistry`. Разница не в аккуратности, а в моменте: реестр пишется ДО дела, и его
    // отказ ещё может быть исправлен повтором джобы; привязки ставятся ПОСЛЕ маркера, поэтому
    // повтора у них не будет никогда — бросок лишь отменил бы обработку остальных операций пачки,
    // ничего не починив. Отказ считается и попадает в строку итога.
    //
    // ⚠ Батч берётся ТОТ ЖЕ, что у остальных фан-аутов: четыре привязки в одном round-trip вместо
    // четырёх — на выписке в сотни строк это разница в бюджете портала, а не в стиле.
    bindActivity: async (activityId, refs, memberId) => {
      if (refs.length === 0) return { bound: 0, failed: 0 }
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return { bound: 0, failed: refs.length }
        const batch = await resolvePortalCall.batch(memberId)
        return await bindActivityViaRest(activityId, refs, call, batch ?? undefined)
      } catch (e) {
        crmLog.warning(`portal ${memberId}: привязки дела ${activityId} не поставлены — ${logSafe(String((e as Error)?.message ?? e))}`)
        return { bound: 0, failed: refs.length }
      }
    },
    // Registry element for EVERY operation (#575) — see the dep's doc for why it is unconditional.
    // ⚠ `companyId` here is the CLIENT (or null): the element links the payer, and passing the
    // my-company fallback would label a stranger's payment as our own company's.
    writePaymentRegistry: async (item, companyId, memberId, provider, paymentSp) => {
      if (isDemoAccount(item.account)) return null
      const call = await resolvePortalCall(memberId)
      // ⚠ THROW, not `return null` — the same choice `writeLedger`/`applyAllocation`/`hasTriggerFact`/
      // `writeTriggerFact` make right here. A silent null would not reach the handler's `catch`, so a
      // portal whose token died mid-batch would produce ZERO registry elements while the run summary
      // still printed `registryFailed: 0` — «реестр работает штатно» during a total registry outage.
      // Throwing at least counts it; the activity write hits the same dead token a line later anyway.
      if (!call) throw new Error(`writePaymentRegistry: no portal token for ${memberId}`)
      try {
        return await writePaymentRegistryViaRest(item, companyId, provider, paymentSp, call)
      } catch (e) {
        // Logged HERE and rethrown: the handler counts the failure (and keeps the activity, see the
        // comment at its call site), but only this layer has the portal's actual error text. The
        // count alone would say «сколько», never «почему».
        //
        // ⚠ Через `logSafe`, потому что текст сюда приходит ОТ ПОРТАЛА, а не от нас: правило
        // PRIVACY.md §Логи требует этого от любого внешнего текста, и полагаться на то, что
        // Bitrix24 не эхает присланные значения, нельзя — это его выбор, а не наш инвариант.
        // (Замерено 2026-08-22: на отказе `crm.item.add` значения полей в `error_description` не
        // возвращаются, а нечисловое значение в `double`-поле портал вообще принимает молча. То
        // есть сегодня канала утечки нет — но обёртка стоит там, где правило её требует.)
        crmLog.error(`portal ${memberId}: реестр платежей не записан — ${logSafe(String((e as Error)?.message ?? e))}`)
        throw e
      }
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
      recognizeLog.info(`portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${summary}`)
      // Observability (#242): the resolver caps REST lookups at MAX_RESOLVED_INTENTS_PER_OP,
      // so any intents beyond that are silently dropped (a payer with a purpose stuffed full
      // of ids can't otherwise be seen). Surface the truncation so it's visible in logs.
      if (intents.length > MAX_RESOLVED_INTENTS_PER_OP) {
        recognizeLog.warning(`portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${intents.length} intents, capped to ${MAX_RESOLVED_INTENTS_PER_OP} for REST lookup (${intents.length - MAX_RESOLVED_INTENTS_PER_OP} dropped)`)
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
    loadNegativeStagePredicate: async (memberId, smartEntityTypeId) => {
      const call = await resolvePortalCall(memberId)
      if (!call) return null
      // Batch the per-funnel `crm.status.list` fan-out into one request (#191). The batch
      // shares the SAME memoised SDK client (rate-limiter bucket) as `call`.
      const batch = await resolvePortalCall.batch(memberId)
      const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call, batch, smartEntityTypeId)
      const suspicious = failOpenEntities(diagnostics)
      if (suspicious.length > 0) {
        const detail = suspicious.map((e) => {
          const d = e === 'invoice' ? diagnostics.invoice : e === 'deal' ? diagnostics.deal : diagnostics.smartProcess
          return `${e}(funnels=${d?.categories},neg=${d?.negativeStages},empty=${d?.emptyCategories})`
        }).join(' ')
        stageLog.warning(`portal ${memberId}: suspicious negative-stage load — ${detail} (a funnel with 0 lost/fail stages, or none enumerated) — check rights/config; those entities won't be stage-excluded (fail-open)`)
        // Program feedback (docs/FEEDBACK.md channel 2, fail-open signal). Fire-and-forget: this is
        // the hot resolution path — don't delay the predicate on a GitHub POST (fileProgramSignal
        // swallows internally, so the void promise never rejects). No account here, but only real
        // portals (call non-null above) reach this point → no demo gate needed.
        void fileProgramSignal(memberId, { type: 'fail-open', entities: suspicious })
      }
      return predicate
    },
    // Observe what each intent resolved to (log-only coverage). account/docId + value
    // sanitized (logSafe) like onRecognized; kind/status are safe internal data.
    onResolved: (item, resolutions, memberId) => {
      const summary = resolutions.map(r => `${r.kind}=${logSafe(r.value)}:${r.status}(${r.candidates.length})`).join(', ')
      resolveLog.info(`portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${summary}`)
    },
    // Observe the allocation decision (§2). This callback only LOGS; the durable record is the
    // SP-ledger distribution row (`writeLedger`, §9.3 #6 — Postgres allocation_fact retired).
    // Target id/kind are internal (CRM ids, not payer-controlled); account/docId sanitized.
    onAllocationDecision: (item, decision, triggerTargets, memberId) => {
      const detail = decision.action === 'allocate'
        ? `allocate ${decision.target.kind}#${decision.target.id}${decision.ambiguous ? ` ambiguous(+${decision.alternatives.length})` : ''}`
        : decision.action === 'manual'
          ? `manual(${decision.candidates.length} candidates, no exact match)`
          : 'none'
      allocateLog.info(`portal ${memberId}, op ${logSafe(item.account)}|${logSafe(item.docId)}: ${detail}${triggerTargets ? ` +${triggerTargets} trigger` : ''}`)
    },
    // Per-op outcome — the one line an operation gets when it matched NOTHING (see the dep's doc
    // in handlers.ts). The counterparty's account is the payload here on purpose: it is the exact
    // value `findCompany` looks up in the portal's requisites, so it turns an opaque «unmatched»
    // into «this number is not on any company in your CRM» — which is a thing the owner can act on.
    // Follows docs/PRIVACY.md §Логи: account/docId/counterparty account are logged, AMOUNTS ARE
    // NOT, and the purpose only behind the opt-in gate below.
    onOperation: (item, outcome, memberId) => {
      // Both the volume gate and the text live in `buildOpLogLine` — a pure function with an
      // executable test. Keeping them here made the gate verifiable only by reading the source,
      // and a review mutation proved the cost: `if (false && !shouldLogOperation(…)) return`
      // left the whole suite green while silently restoring the full #498 log volume.
      const line = buildOpLogLine(item, outcome, memberId, OP_LOG_MODE, STATEMENT_DEBUG_LOG)
      if (line) opLog.info(line)
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
        await notifyChatViaRest(item, dialogId, call, memberId)
      } catch (e) {
        crmLog.error(`chat notify failed, portal ${memberId}: ${(e as Error)?.message}`)
      }
    },
    // Idempotency pre-check for the AMOUNT mutation (#109 §2, Фаза A): is the target already
    // applied in B24 (payment `paid='Y'` / invoice on the configured paid stage)? Reads live
    // B24 state via the per-portal RestCall — the source of truth, so a redelivery never
    // re-pays (and it covers the pay-then-crash-before-fact window the fact left open). Demo
    // accounts GATED. No token → false (can't read → don't skip; `applyAllocation`'s no-token
    // branch then throws → clean retry). A read error propagates (fail the job).
    isTargetApplied: async (item, target, memberId, opts) => {
      if (isDemoAccount(item.account)) return false
      const call = await resolvePortalCall(memberId)
      if (!call) return false
      return readAllocationApplied(target, call, opts)
    },
    // Portal MUTATION for a decided allocate target (#109 §2): mark it paid
    // (`crm.item.payment.pay` / invoice `crm.item.update`). Demo accounts GATED (never real
    // REST). A REST error PROPAGATES (runs before the fact write, so a retry is clean).
    // Returns whether a portal write was actually applied.
    //
    // `!call` (no portal token) has TWO distinct causes we must NOT conflate (#77 review):
    //   - the target has NO v1 mutation anyway (trigger kind, or invoice w/o configured
    //     stage) — `buildAllocationMutation` is `null`, so there is nothing to write and
    //     ledger-only is correct → return false (no mutation, caller writes the SP row);
    //   - the target IS mutatable but the portal token is transiently unavailable (refresh
    //     failed / mid-batch uninstall) — returning false here would let the caller write the
    //     SP row for a payment we never paid; the row is idempotent, so a later retry finds it
    //     (`created:false`) and never counts `distributed` for the pay. A transient failure is
    //     NOT an uninstall, so `deletePortal` won't purge it — no self-heal. THROW instead →
    //     the job retries cleanly, no SP row until the pay lands.
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
      // legitimately writes nothing and is ledger-only). Returning false here would let the
      // caller write the durable SP row for a payment that was never applied; the row is
      // idempotent, so a retry finds it (`created:false`) and never counts `distributed` for
      // the eventual pay (the same poison the no-token branch throws to avoid). THROW so the
      // job retries; a genuinely permanent rejection surfaces via retry exhaustion, not a
      // silent success. (`skipped:'unsupported'` still returns false → ledger-only, unchanged.)
      if (!res.applied && res.skipped !== 'unsupported') {
        throw new Error(`applyAllocation: portal did not confirm ${res.method ?? 'pay'} for ${target.kind}#${target.id} (member ${memberId}) — retry`)
      }
      return res.applied
    },
    // Write the decided allocation to the SP-ledger (#109 §9.1/§9.3): payment carrier element +
    // distribution row + «осталось» recompute. Demo gated; no token → throw (the ledger write is
    // pending, like applyAllocation's no-token branch, so the job retries rather than silently
    // skipping). Idempotent by markers, so the retry is safe. Returns whether a NEW row was created.
    writeLedger: async (item, target, companyId, memberId, etids) => {
      if (isDemoAccount(item.account)) return false
      const call = await resolvePortalCall(memberId)
      if (!call) throw new Error(`writeLedger: no portal token for ${memberId} — retry (ledger write pending)`)
      const res = await writeLedgerAllocation(etids.paymentSp, etids.distributionSp, item, target, companyId, call)
      return res.rowCreated
    },
    // TRIGGER dedup pre-check on the SP-ledger marker (#109 §9.3 #6 — replaces the Postgres
    // `hasAllocationFact` for the trigger path). Demo gated; no token → throw (like writeLedger,
    // the check is pending → clean retry, never a false «not fired» that would double-fire).
    hasTriggerFact: async (item, target, memberId, etids) => {
      if (isDemoAccount(item.account)) return false
      const call = await resolvePortalCall(memberId)
      if (!call) throw new Error(`hasTriggerFact: no portal token for ${memberId} — retry (dedup check pending)`)
      return hasTriggerLedgerFact(etids.distributionSp, item, target, call)
    },
    // Record a fired TRIGGER in the SP-ledger as a zero-amount marker row (#109 §9.3 #6 — replaces
    // the Postgres `recordAllocation` for the trigger path). Demo gated; no token → throw (the write
    // is pending → clean retry). Idempotent by marker. Returns whether a NEW row was created.
    writeTriggerFact: async (item, target, companyId, memberId, etids) => {
      if (isDemoAccount(item.account)) return false
      const call = await resolvePortalCall(memberId)
      if (!call) throw new Error(`writeTriggerFact: no portal token for ${memberId} — retry (trigger record pending)`)
      const res = await writeTriggerLedgerFact(etids.paymentSp, etids.distributionSp, item, target, companyId, call)
      return res.created
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
    // Deferred CRM writes (#578 registry / #585 bindings). Both enqueues are BEST-EFFORT: demo
    // accounts are never queued, and an enqueue failure is swallowed (without Redis it is a no-op
    // anyway) — a repair job has no right to abort the very batch it exists to complete.
    enqueueRegistryRetry: async (item, companyId, memberId, provider, paymentSp) => {
      try {
        if (isDemoAccount(item.account)) return
        await enqueueRegistryWrite({ memberId, providerId: provider, item, companyId, paymentSp })
      } catch (e) {
        crmLog.warning(`portal ${memberId}: дозапись реестра не поставлена — ${logSafe(String((e as Error)?.message ?? e))}`)
      }
    },
    enqueueBindRetry: async (activityId, refs, memberId) => {
      try {
        await enqueueActivityBind({ memberId, activityId, refs })
      } catch (e) {
        crmLog.warning(`portal ${memberId}: дозапись привязок не поставлена — ${logSafe(String((e as Error)?.message ?? e))}`)
      }
    },
    // Durable retry (#79): a missed trigger fire ('retry' outcome) is handed to the trigger-fire
    // queue so it self-heals with backoff. BEST-EFFORT — never throws (a trigger only signals). Demo
    // gated (defensive; applyTrigger already returns 'skip' for demo). No Redis ⇒ enqueue no-ops ⇒
    // graceful degrade to single-shot. The job carries only target ids + the app CODE (no financial PII).
    enqueueTriggerRetry: async (item, target, memberId, code) => {
      try {
        if (isDemoAccount(item.account)) return
        await enqueueTriggerFire({
          memberId,
          triggerCode: code,
          targetKind: target.kind,
          targetId: target.id,
          ...(target.entityTypeId != null ? { targetEntityTypeId: target.entityTypeId } : {}),
          opKey: dedupKey(item)
        })
      } catch (e) {
        triggerLog.warning(`enqueue retry failed for ${target.kind}#${target.id} — ${(e as Error)?.message}`)
      }
    },
    // Post an ambiguous/manual allocation notice to the error chat. Same guarantees as
    // notifyChat: demo accounts gated, no token → skip, whole body swallow+logged (a chat
    // failure must never fail the job).
    notifyError: async (item, decision, dialogId, memberId) => {
      if (isDemoAccount(item.account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifyAllocationErrorViaRest(item, decision, dialogId, call, memberId)
      } catch (e) {
        crmLog.error(`alloc error notify failed, portal ${memberId}: ${(e as Error)?.message}`)
      }
    },
    // «Номер распознан, цель не найдена» (#421) — те же гарантии, что у notifyError.
    notifyUnresolved: async (item, identifiers, dialogId, memberId, truncated) => {
      if (isDemoAccount(item.account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifyUnresolvedViaRest(item, identifiers, dialogId, call, truncated, memberId)
      } catch (e) {
        crmLog.error(`unresolved notify failed, portal ${memberId}: ${(e as Error)?.message}`)
      }
    },
    // «Настройка распознавания не подходит порталу» (#572) — те же гарантии, что у notifyUnresolved.
    // ⚠ Платёж не передаётся: сообщение про НАСТРОЙКУ, а не про операцию, и шлётся раз за прогон.
    // ⚠ Демо-гейт стоит на ПАЧКЕ, а не на операции, и это единственный способ его тут поставить:
    // соседи (`notifyError`/`notifyUnresolved`/`notifyUnmatched`) смотрят на `item.account`, а
    // сюда item не приходит по построению. Без гейта комментарий «те же гарантии» был бы ложью, а
    // демо-путь, привязанный к настоящему memberId, писал бы в живой чат клиента.
    notifySettingsError: async (reason, dialogId, memberId, account) => {
      if (isDemoAccount(account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifySettingsErrorViaRest(reason, dialogId, call, memberId)
      } catch (e) {
        crmLog.error(`settings-error notify failed, portal ${memberId}: ${(e as Error)?.message}`)
      }
    },
    // Post an UNMATCHED-client notice to the error chat (#91). Same guarantees as notifyError:
    // demo gated, no token → skip, whole body swallow+logged (a chat failure must never fail the job).
    notifyUnmatched: async (item, dialogId, recordedToMyCompany, memberId) => {
      if (isDemoAccount(item.account)) return
      try {
        const call = await resolvePortalCall(memberId)
        if (!call) return
        await notifyUnmatchedViaRest(item, dialogId, recordedToMyCompany, call, memberId)
      } catch (e) {
        crmLog.error(`unmatched notify failed, portal ${memberId}: ${(e as Error)?.message}`)
      }
    },
    // Read-before-write dedup guard (#259): search Bitrix24 for our marker
    // (ORIGINATOR_ID + ORIGIN_ID; key = ORIGIN_ID = account|docId). The marker is written
    // by the activity write itself (todo.add + marker update, #495), so B24 is the source of truth — no DB
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
      await deleteBatchesForPortal(dbQuery, memberId)
      await deleteMetricsForPortal(dbQuery, memberId)
      await deleteBankTokensForPortal(dbQuery, memberId) // stage-5 bank creds — a removed app keeps none
      await deleteRatingForPortal(dbQuery, memberId) // «оцените приложение» state — kept рядом с авторизацией
      // ⚠ Аренда single-flight (#538) сама не исчезнет: у неё нет свипа, а рассуждение «просроченную
      // перезапишет следующий захват» держится на том, что захват когда-нибудь будет. У удалённого
      // портала его не будет никогда, и строка с его member_id жила бы в базе и бэкапах вечно.
      await deleteLeasesForPortal(dbQuery, memberId)
      forgetBot(memberId) // кэш чат-бота в памяти процесса (#496) — вместе со всем остальным
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
  return new Worker<EventJob>(Q_EVENTS, async job => withSpan('b24-events', {
    // Job-level trace span (#78). Safe shape only: event kind + hashed portal, never creds.
    'job.queue': 'b24-events',
    'job.kind': job.data.kind,
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleEventJob(job.data, deps)), { connection: connectionOptions() })
}

// ── crm-sync stalled-reprocessing guard (#163, port from ai-price-import) ────────────────────
// crm-sync idempotency is read-before-write by a B24 marker (findActivityByMarker → crm.item.list,
// then crm.activity.todo.add + the marker update that stamps ORIGINATOR_ID/ORIGIN_ID, #495). That is
// a TOCTOU: it protects SEQUENTIAL retries (crash recovery — a committed write leaves the marker, so
// the retry finds it) but NOT CONCURRENT reprocessing of one job. BullMQ redelivers a job to a SECOND
// worker once the first worker's lock is deemed STALLED; if the first is still mid-write,
// both find "no marker" and both write → a DUPLICATE activity (Bitrix does not enforce ORIGIN_ID
// uniqueness within a single call). The same window applies to the allocation mutations.
//
// A pg advisory lock around find→write would serialize it fully, but it must HOLD a pooled connection
// across the REST write — the pool is `max: 10` (db/client.ts), so raising crm concurrency / replicas
// would starve it (settings reads, status/metrics writes, token loads all block). Rejected for that.
//
// Instead we shut the false-stall window without touching pg: BullMQ RENEWS a job's lock every
// lockDuration/2 while the async handler runs, and crm-sync's awaits are REST I/O (they do not block
// the event loop), so the renewal timer keeps firing — a LIVE worker only stalls if its loop is
// blocked > lockDuration/2. Raising lockDuration well above worst-case write latency + GC jitter makes
// a false stall of a live crm worker effectively impossible, so the second worker never runs
// concurrently with the first → no duplicate. maxStalledCount:1 bounds a GENUINELY crashed job to one
// recovery redelivery, which read-before-write makes safe (a committed write left the marker → the
// redelivery finds it). Residual (accepted): a real >60s event-loop block AND an in-flight uncommitted
// write on the same tick — vanishingly unlikely (crm-sync does no heavy CPU), and self-corrects on the
// next retry. Effective only while crm-sync stays serial (concurrency 1); documented in docs/QUEUES.md.
export const CRM_LOCK_DURATION_MS = 60_000
export const CRM_STALLED_INTERVAL_MS = 60_000
export const CRM_MAX_STALLED_COUNT = 1

/** BullMQ lock options for the crm-sync worker (#163). We keep `stalledInterval === lockDuration` as a
 *  conservative margin (the real anti-false-stall guard is BullMQ's lock-existence check, not the
 *  interval relationship — a live worker's renewed lock is never reclaimed). Pure → unit-tested. */
export function crmLockTuning(): { lockDuration: number, stalledInterval: number, maxStalledCount: number } {
  return {
    lockDuration: CRM_LOCK_DURATION_MS,
    stalledInterval: CRM_STALLED_INTERVAL_MS,
    maxStalledCount: CRM_MAX_STALLED_COUNT
  }
}

/** The throughput workers (fetch/parse/crm-sync) — safe to run on N scaled replicas
 *  (Redis hands each job to exactly one). `concurrency` (default 1) applies to fetch/parse;
 *  **crm-sync is PINNED to 1** (#163 — see its Worker below) so raising QUEUE_CONCURRENCY can't
 *  silently make it in-process-concurrent and reintroduce the find→write TOCTOU.
 *  ⚠ Making crm-sync concurrent OR running >1 replica needs (a) a per-portal REST limiter (else a
 *  big batch hits B24 `QUERY_LIMIT` — batch/`callBatch` is the real lever) and (b) ATOMIC dedup.
 *  Dedup is the B24 marker (`findActivityByMarker` → `todo.add` + update stamps ORIGINATOR_ID/
 *  ORIGIN_ID atomically, #259), but the search→write is still two calls: under parallelism two
 *  workers could both miss the marker and double-write a dela (TOCTOU) — see #109/#259/PROCESSING §1.
 *  fetch/parse scale freely. See docs/QUEUES.md. */
export function startThroughputWorkers(
  deps: HandlerDeps,
  opts: {
    concurrency?: number
    fetchRate?: { max: number, duration: number }
    /** Prior's own limiter (already expressed in JOBS — see providerJobRate). */
    priorFetchRate?: { max: number, duration: number }
    /** Prior's own slot count (its jobs are long-running; see Q_FETCH_PRIOR). */
    priorConcurrency?: number
  } = {}
): Worker[] {
  const connection = connectionOptions()
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const priorConcurrency = Math.max(1, opts.priorConcurrency ?? concurrency)
  return [
    // A8: the bank-fetch worker hits the real Alfa API (~100 req/min per OAuth client). BullMQ's
    // worker `limiter` is GLOBAL across all replicas on the same queue — the counter is a Redis
    // key (`<prefix>:<queue>:limiter`, INCR'd in Lua), NOT a per-process counter (verified against
    // the installed bullmq 5.x source). So this ONE bucket caps live Alfa calls across the whole
    // fleet at max/duration. Our app has a single Alfa client_id, so a global cap is the correct
    // model (per-group/`groupKey` limiting is a BullMQ Pro-only feature). Default 80/60s — 80 % of Alfa's documented cap (QUEUE_FETCH_RATE_*).
    // Parse/crm-sync aren't rate-limited here (crm-sync throttles via the SDK RestrictionManager).
    // Follow-up: reactive 429 handling via Worker.RateLimitError + rateLimit() if Alfa 429s.
    new Worker<FetchJob>(Q_FETCH, async job => withSpan('bank-fetch', {
      // Job-level trace span (#78). Safe shape only: provider + hashed portal, never account/creds.
      'job.queue': 'bank-fetch',
      'job.provider': job.data.providerId,
      'portal.hash': portalHash(job.data.memberId)
    }, () => handleFetchJob(job.data, deps), r => ({ 'job.op_count': r.fetched })), {
      connection,
      concurrency,
      ...(opts.fetchRate ? { limiter: { max: opts.fetchRate.max, duration: opts.fetchRate.duration } } : {})
    }),
    // Prior's fetch queue — same handler, SEPARATE queue so it gets its own Redis-backed limiter
    // and its own slots (Q_FETCH_PRIOR): a Prior job costs ~10 bank requests and can run for
    // minutes, so sharing Alfa's queue would both under-count its request spend and head-of-line
    // block every other portal. Its `max` is already in JOBS (providerJobRate divided the bank's
    // request budget by the per-job cost).
    new Worker<FetchJob>(Q_FETCH_PRIOR, async job => withSpan('bank-fetch', {
      'job.queue': 'bank-fetch-prior',
      'job.provider': job.data.providerId,
      'portal.hash': portalHash(job.data.memberId)
    }, () => handleFetchJob(job.data, deps), r => ({ 'job.op_count': r.fetched })), {
      connection,
      concurrency: priorConcurrency,
      ...(opts.priorFetchRate ? { limiter: { max: opts.priorFetchRate.max, duration: opts.priorFetchRate.duration } } : {})
    }),
    new Worker<ParseJob>(Q_PARSE, async job => withSpan('file-parse', {
      // Job-level trace span (#78). The ONLY pipeline stage with no auto child span (pure CPU
      // parse, no I/O) — so without this its latency/outcome is otherwise invisible.
      'job.queue': 'file-parse',
      'job.provider': job.data.providerId,
      'portal.hash': portalHash(job.data.memberId)
    }, async () => {
      try {
        const res = await handleParseJob(job.data, deps)
        // Два РАЗНЫХ тупика, и путать их нельзя. Оба оставляют загрузку без `crm-sync`, а значит
        // без итога — то есть возвращают ровно тот молчащий импорт, ради которого заведён #417.
        if (res.parsed === 0) {
          // Файл разобран, но операций в нём нет.
          await persistBatchError(job.data, 'В файле не найдено операций — проверьте, что это выписка клиент-банка.')
        } else if (!res.chained) {
          // Операции есть, но очередь недоступна (Redis отвалился между разбором и передачей).
          // Сказать здесь «не найдено операций» — прямая ложь: сотрудник пошёл бы проверять файл
          // вместо того, чтобы повторить загрузку.
          await persistBatchError(job.data, 'Очередь обработки недоступна — повторите загрузку позже.')
        }
        return res
      } catch (e) {
        // A parse failure = the statement format wasn't recognized (docs/FEEDBACK.md channel 2,
        // format signal). Attach the RAW file that failed to parse (decoded, capped) for reproduction
        // — it's client data, but the receiving repo is private and this IS the file to debug. Decode
        // is best-effort (a format failure isn't a decode failure, but guard anyway). File a
        // best-effort program issue (fire-and-forget so the job fails fast), then RE-THROW so BullMQ
        // retry/failure is unchanged. A file-parse job is always a real manual upload (demo uses the
        // fetch path), so no demo gate — pass no account.
        let fileText: string | undefined
        try {
          fileText = decodeUploadText(Buffer.from(job.data.contentBase64, 'base64')).slice(0, MAX_FILE_EMBED)
        } catch { /* undecodable → attach no file */ }
        void fileProgramSignal(job.data.memberId, { type: 'format', providerId: job.data.providerId, fileText })
        // Итог загрузки помечаем провалом ТОЛЬКО на последней попытке: показать сотруднику
        // «не разобралось» и через минуту молча передумать — хуже, чем подождать.
        if (isFinalAttempt(job)) {
          await persistBatchError(job.data, 'Не удалось разобрать файл — формат выписки не распознан.')
        }
        throw e
      }
    }, r => ({ 'job.op_count': r.parsed })), { connection, concurrency }),
    new Worker<CrmSyncJob>(Q_CRM, async (job) => {
      // Job-level trace span (#78) — no-op unless telemetry is on. Only SAFE shape/outcome
      // attributes (counts, provider, hashed portal); never operation content.
      return withSpan('crm-sync', {
        'job.queue': 'crm-sync',
        'job.provider': job.data.providerId,
        'job.op_count': job.data.items?.length ?? 0,
        'portal.hash': portalHash(job.data.memberId)
      }, async () => {
        let summary
        try {
          summary = await handleCrmSyncJob(job.data, deps)
        } catch (e) {
          // У `crm-sync` ретраев нет (attempts не задан), поэтому первый же throw — терминальный:
          // без этой ветки загрузка осталась бы в «принято» НАВСЕГДА, а UI обещал сотруднику
          // результат. Помечаем провал и пробрасываем — поведение очереди не меняется.
          if (job.data.source === 'parse') {
            await persistBatchFailure(job.data, 'Обработка не завершилась — попробуйте загрузить файл ещё раз.')
          }
          throw e
        }
        // ⚠ БЕЗУСЛОВНАЯ запись уровня прогона (#498). Её раньше не было вовсе: сводка считалась,
        // уезжала в БД и метрики, но в лог не попадала — то есть в логе не существовало ни одной
        // записи, которая переживёт ротацию и объяснит, что произошло. Это O(прогонов), а не
        // O(операций), поэтому масштаб её не съедает.
        crmLog.info(runSummaryLine(job.data.memberId, summary, OP_LOG_MODE))
        // Persist the run for the in-portal status card (#5) — LATEST run per portal.
        // Best-effort: a status-persist failure must NOT fail the job (the CRM writes
        // already happened). Demo batches never touch the real portal's status row.
        await persistImportResult(job.data, summary)
        // Итог КОНКРЕТНОЙ загрузки (#417) — то, чего ждёт сотрудник на экране `/import`.
        await persistBatchResult(job.data, summary)
        // Accumulate LIFETIME per-portal counters for the dashboard (#78). Same
        // best-effort/demo-gated contract — bookkeeping must never fail a job.
        await bumpMetrics(job.data, summary)
        // Program feedback (docs/FEEDBACK.md channel 2): if the run «got confused», file a deduped,
        // rate-capped issue in the private repo. Same best-effort/demo-gated contract.
        await fileProgramFeedback(job.data, summary)
        return summary
      }, summary => ({
        'proc.recognized': summary.recognized,
        'proc.resolved': summary.resolved,
        'proc.allocated': summary.allocated,
        'proc.ambiguous': summary.ambiguous,
        'proc.manual': summary.manual,
        'proc.distributed': summary.distributed,
        'proc.ledger_written': summary.ledgerWritten
      }))
      // #163: raise the BullMQ lock/stall window so a LIVE crm-sync worker is never falsely deemed
      // stalled → no concurrent redelivery double-writing an activity. maxStalledCount:1 keeps BullMQ's
      // default (one read-before-write-safe recovery of a truly crashed job) explicit. crm-sync ONLY
      // (find→write TOCTOU); the fetch/parse workers are pure/idempotent and keep BullMQ defaults.
      //
      // crm-sync is PINNED to concurrency 1 regardless of QUEUE_CONCURRENCY. The lock tuning only closes
      // the cross-worker STALLED-redelivery window; it does nothing against IN-PROCESS concurrency. Since
      // QUEUE_CONCURRENCY is a single shared knob (fetch/parse have a real reason to scale), letting it
      // raise crm-sync too would reintroduce the exact find→write TOCTOU this guards against. Until a
      // per-portal REST limiter + atomic dedup land (docs/QUEUES.md), crm-sync stays serial by construction.
    }, { connection, concurrency: 1, ...crmLockTuning() })
  ]
}

/** Live deps for the feedback outbox worker (#61): re-POST via the same transport as the route, and
 *  bump the #195 metric on eventual success. If the channel is disabled (config null), a stray job
 *  is a PERMANENT failure (dropped, no retry) — normally none are enqueued (the route 503s first). */
export function liveFeedbackPostDeps(): FeedbackPostJobDeps {
  const config = resolveFeedbackConfig()
  const fetchImpl = globalThis.fetch as unknown as FeedbackFetchFn
  return {
    postIssue: async payload =>
      config ? postFeedbackIssue(config, payload, fetchImpl) : { ok: false, status: 0, retryable: false },
    recordMetric: (memberId, kind) =>
      bumpCounter(dbQuery, memberId, kind === 'up' ? FEEDBACK_METRICS.up : FEEDBACK_METRICS.down, 1)
  }
}

/** The feedback outbox worker (#61) — drains transiently-failed feedback issue posts, retrying with
 *  backoff (FEEDBACK_RETRY_OPTS). External POST + idempotent-ish (contentHash dedups), so it is safe
 *  on N scaled replicas like fetch/parse (not portal-ordered). No PII on the span (hashed portal only). */
export function startFeedbackWorker(deps: FeedbackPostJobDeps): Worker {
  return new Worker<FeedbackPostJob>(Q_FEEDBACK, async job => withSpan('feedback-post', {
    'job.queue': 'feedback-post',
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleFeedbackPostJob(job.data, deps)), { connection: connectionOptions() })
}

/** Live deps for the deferred-write workers (#578/#585): the same stored token and the same
 *  transports the synchronous path uses. No batch is handed to either — see `handleActivityBindJob`
 *  (a halted batch is exactly what the retry path must not repeat). */
export function liveRegistryWriteDeps(): RegistryWriteJobDeps {
  return {
    resolvePortalCall,
    writePaymentRegistry: writePaymentRegistryViaRest,
    findActivityId: findActivityByMarker,
    // ⚠ No batch — a single binding, and the same path the bindings retry takes.
    bindActivity: (activityId, refs, call) => bindActivityViaRest(activityId, refs, call)
  }
}

export function liveActivityBindDeps(): ActivityBindJobDeps {
  // ⚠ No batch is passed, and the port does not accept one: see `handleActivityBindJob`.
  return { resolvePortalCall, bindActivity: (activityId, refs, call) => bindActivityViaRest(activityId, refs, call) }
}

/** The registry-write retry worker (#578). The write is idempotent by the operation marker AND
 *  fills the columns of an element it finds, so a repeat is safe even on half-done work. */
export function startRegistryWorker(deps: RegistryWriteJobDeps): Worker {
  return new Worker<RegistryWriteJob>(Q_REGISTRY, async job => withSpan('registry-write', {
    'job.queue': 'registry-write',
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleRegistryWriteJob(job.data, deps)), { connection: connectionOptions() })
}

/** The activity-bind retry worker (#585). Adds only the pairs that are missing (it reads
 *  `binding.list` first), so a repeat does not turn into a stream of «already bound» errors. */
export function startBindingsWorker(deps: ActivityBindJobDeps): Worker {
  return new Worker<ActivityBindJob>(Q_BINDINGS, async job => withSpan('activity-bind', {
    'job.queue': 'activity-bind',
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleActivityBindJob(job.data, deps)), { connection: connectionOptions() })
}

/** Live deps for the trigger-retry worker (#79): re-fire via the SAME transport as the sync path,
 *  on the portal's stored OAuth token (the method needs app-context). No fact/metric is written here
 *  (fire-only — the audit row is written on the synchronous fire; see triggerFireJob.ts). */
export function liveTriggerFireDeps(): TriggerFireJobDeps {
  return { resolvePortalCall, executeTriggerViaRest }
}

/** The trigger-retry worker (#79) — re-fires missed «деньги пришли» signals with backoff
 *  (TRIGGER_RETRY_OPTS) so a transient / not-yet-registered miss self-heals. Idempotent signal
 *  (jobId dedups re-enqueue), N-replica-safe (not portal-ordered). No PII on the span. */
export function startTriggerWorker(deps: TriggerFireJobDeps): Worker {
  return new Worker<TriggerFireJob>(Q_TRIGGER, async job => withSpan('trigger-fire', {
    'job.queue': 'trigger-fire',
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleTriggerFireJob(job.data, deps)), { connection: connectionOptions() })
}

/** Save the crm-sync run summary as the portal's last import status (#5). Gated to
 *  real (non-demo) portals; swallows errors so status bookkeeping can't fail a job. */
/** Пометить загрузку провалившейся (#417). Best-effort: учёт не должен ронять джобу. */
async function persistBatchError(job: ParseJob, message: string): Promise<void> {
  try {
    await saveBatchError(dbQuery, job.memberId, job.fileHash, message)
  } catch (e) {
    importLog.error(`import_batch error save failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

/** Пометить провалом загрузку, чья обработка в `crm-sync` не завершилась (#417). Отдельно от
 *  парсерной версии — здесь на входе `CrmSyncJob`, и гейт демо-счетов тот же. */
async function persistBatchFailure(job: CrmSyncJob, message: string): Promise<void> {
  const account = job.items[0]?.account ?? ''
  if (account && isDemoAccount(account)) return
  try {
    await saveBatchError(dbQuery, job.memberId, job.batchId, message)
  } catch (e) {
    importLog.error(`import_batch error save failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

/** Записать итог РУЧНОЙ загрузки (#417). Только для `source: 'parse'` — у автоопроса банка нет
 *  сотрудника, который ждёт ответа на экране, и его прогоны учитываются в `import_result`.
 *  Best-effort и с гейтом демо-счетов — как и остальной учёт. */
async function persistBatchResult(
  job: CrmSyncJob,
  summary: { processed: number, created: number, notified: number, unmatched: number }
): Promise<void> {
  if (job.source !== 'parse') return
  const account = job.items[0]?.account ?? ''
  if (account && isDemoAccount(account)) return
  try {
    await saveBatchResult(dbQuery, job.memberId, job.batchId, {
      operations: summary.processed,
      created: summary.created,
      notified: summary.notified,
      unmatched: summary.unmatched
    })
  } catch (e) {
    importLog.error(`import_batch save failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

/**
 * Отметить обращение к банку: когда спросили и сколько отдал.
 *
 * ⚠ Лучшие усилия и НИКОГДА не бросает: это учёт, а не работа. Провал записи не должен ронять
 * джобу забора — иначе диагностика ломала бы то, что диагностирует.
 */
async function markFetchOutcome(job: FetchJob, ops: number): Promise<void> {
  if (!job.account || isDemoAccount(job.account)) return
  try {
    await markBankFetch(dbQuery, job.memberId, ops)
  } catch (e) {
    fetchLog.error(`fetch mark failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

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
    crmLog.error(`import_result save failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

/** Accumulate lifetime per-portal metric counters from a crm-sync run summary (#78).
 *  Gated to real (non-demo) portals; swallows errors so metrics can't fail a job. */
async function bumpMetrics(
  job: CrmSyncJob,
  summary: { processed: number, created: number, notified: number, unmatched: number, unresolved: number, recognized: number, resolved: number, allocated: number, distributed: number, ambiguous: number, manual: number, registryFailed: number, bindingsFailed: number, misconfigured: number }
): Promise<void> {
  const account = job.items[0]?.account ?? ''
  if (!account || isDemoAccount(account)) return
  try {
    await bumpCounters(dbQuery, job.memberId, metricsFromSummary(summary))
  } catch (e) {
    crmLog.error(`metrics bump failed, portal ${job.memberId}: ${(e as Error)?.message}`)
  }
}

/** File a program feedback issue for a «confusion» signal (docs/FEEDBACK.md channel 2), gated by:
 *  the channel being configured (GITHUB_FEEDBACK_*), Redis available (for dedup/cap), the demo/empty
 *  gate (when an account is known), and the dedup + hourly-cap gate. Best-effort — a feedback failure
 *  must never affect the caller. Shared by the confusion tail (crm-sync), the fail-open detector and
 *  the parse-failure (format) path. */
async function fileProgramSignal(memberId: string, signal: ProgramSignal, account?: string): Promise<void> {
  // Demo/empty gate ONLY when the account is known (confusion/format). fail-open has no account but
  // only real portals (with a stored OAuth token) reach its detector, so it needs no demo gate.
  if (account !== undefined && (!account || isDemoAccount(account))) return
  const config = resolveFeedbackConfig()
  if (!config) return // channel off (no GITHUB_FEEDBACK_* → fail-closed, like the employee channel)
  if (!queueEnabled()) return // need Redis for dedup + hourly cap; without it, don't risk spamming
  try {
    // fail-open is a persistent config state (a funnel with no lost/fail stage trips it on EVERY
    // run), so give it a longer dedup window (24h) — else a misconfigured portal files hourly. A
    // confusion/format shape is a per-run/per-upload event → the default 1h window.
    const opts = signal.type === 'fail-open' ? { dedupWindowSec: 24 * 3600 } : {}
    const gate = await claimProgramFeedbackSlot(programFeedbackGateDeps, memberId, programSignalSignature(signal), opts)
    if (!gate.file) return // deduped or hourly cap reached
    const payload = buildProgramFeedbackIssue({ memberId, commitSha: process.env.NUXT_PUBLIC_COMMIT_SHA, signal })
    await postFeedbackIssue(config, payload, globalThis.fetch as unknown as FeedbackFetchFn)
  } catch (e) {
    crmLog.error(`program feedback failed, portal ${memberId}: ${(e as Error)?.message}`)
  }
}

/** Confusion signal from a crm-sync run summary (unmatched/ambiguous/manual) + an optional redacted
 *  sample of the first confused op (for reproduction, private repo only). */
async function fileProgramFeedback(
  job: CrmSyncJob,
  summary: { unmatched: number, ambiguous: number, manual: number, sample?: ProgramSample }
): Promise<void> {
  // The demo gate keys on the batch's first account. The redacted sample can come from ANY item, so
  // this relies on crm-sync batches being account-homogeneous (demo load and real polls/imports are
  // always separate jobs) — now privacy-load-bearing (a demo run must not leak a real op), not just
  // for counting. That invariant holds by construction of the fetch/parse producers.
  const account = job.items[0]?.account ?? ''
  const { total, counts } = summarizeConfusion(summary)
  if (total === 0) return // nothing confused → no issue (skip before any config/Redis work)
  await fileProgramSignal(job.memberId, { type: 'confusion', counts, sample: summary.sample }, account)
}

/**
 * Live deps for the deletion-reconcile consumer (§9.2). `portalInstalled` and `loadSpConfig` are
 * REAL (token check + settings read via the portal's OAuth token). The reconcile ACTIONS are
 * currently LOG-ONLY placeholders — the actual ledger REST work (list/deactivate distributions,
 * recompute «осталось»). The `deal`/`invoice` TARGET branch is LIVE (deactivate rows + recompute
 * parents); `company`/`payment-carrier` error-chat and the `distribution`-row recompute stay log-only
 * (error-chat needs the errorChat dialog + message templates; a hard-deleted dist row carries no
 * parent link to recompute — the manual «пересчитать» button covers it). Each stub logs a PII-free line.
 */
/** Best-effort §9.2 error-chat notice for a deletion (company / carrier). Loads the portal's error
 *  chat from settings; no error chat configured → skip. Swallows failures (a chat error must never
 *  fail the reconcile job). PII-free: only the entity kind + id reach the message. */
async function notifyDeletionError(job: DeletionJob, kind: DeletionErrorKind, freed?: number): Promise<void> {
  try {
    const call = await livePortalSdkCall(job.memberId)
    if (!call) return
    const dialogId = parsePortalSettings(await readAppSettingVia(call, SETTINGS_KEY)).errorChat.dialogId
    if (!dialogId) {
      deletionLog.info(`${kind} #${logSafe(job.entityId)} (portal=${portalHash(job.memberId)}) — no error chat, skip`)
      return
    }
    await notifyDeletionErrorViaRest(kind, job.entityId, dialogId, call, freed !== undefined ? { freed } : {}, job.memberId)
  } catch (e) {
    deletionLog.warning(`error-chat notify failed: ${kind}, portal=${portalHash(job.memberId)}: ${(e as Error)?.message}`)
  }
}

export function liveDeletionDeps(): DeletionReconcileDeps {
  return {
    portalInstalled: async memberId => (await getApplicationToken(dbQuery, memberId)).length > 0,
    loadSpConfig: async (memberId) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return {}
      const cf = parsePortalSettings(await readAppSettingVia(call, SETTINGS_KEY)).recognition.configFields
      const p = paymentSpRef(cf)
      const d = distributionSpRef(cf)
      return {
        paymentSpEtid: p?.entityTypeId, paymentSpId: p?.id,
        distributionSpEtid: d?.entityTypeId, distributionSpId: d?.id
      }
    },
    // LIVE: a deleted deal/invoice frees the distributions pointing at it (§9.2).
    reconcileTargetDeletion: async (job, kind, cfg) => {
      // Need the FULL refs (entityTypeId + type id) for the ledger reconcile — classification used
      // only the entityTypeIds, but the field-name/list builders key off the type id.
      if (!cfg.paymentSpEtid || !cfg.paymentSpId || !cfg.distributionSpEtid || !cfg.distributionSpId) return 0
      const call = await livePortalSdkCall(job.memberId)
      if (!call) return 0
      const targetKind = kind === 'deal' ? 'deal' : 'invoice'
      const paymentSp = { entityTypeId: cfg.paymentSpEtid, id: cfg.paymentSpId }
      const distributionSp = { entityTypeId: cfg.distributionSpEtid, id: cfg.distributionSpId }
      const res = await reconcileTargetDeletion(paymentSp, distributionSp, targetKind, job.entityId, call)
      deletionLog.info(`target ${kind} #${logSafe(job.entityId)} freed=${res.freed} parents=${res.parentsRecomputed} manual=${res.manualParents} (portal=${portalHash(job.memberId)})`)
      // Notify the operator that a target was deleted and its distributions freed (§9.2), best-effort
      // (a chat failure must not fail the reconcile — the ledger is already reconciled above).
      if (res.freed > 0) await notifyDeletionError(job, targetKind, res.freed).catch(() => {})
      return res.freed
    },
    // LIVE: a deleted company / damaged carrier posts a §9.2 notice to the portal's error chat
    // (best-effort — a chat failure never fails the job; no error chat configured → skip).
    notifyCompanyDeleted: job => notifyDeletionError(job, 'company'),
    notifyCarrierDamaged: job => notifyDeletionError(job, 'payment-carrier'),
    // A hard-deleted dist row carries no parent link → can't target a recompute; manual «пересчитать» covers it.
    recomputeParent: async (job) => {
      deletionLog.info(`distribution row #${logSafe(job.entityId)} (portal=${portalHash(job.memberId)}) — recompute via manual «пересчитать»`)
    }
  }
}

/** The deletion-reconcile worker (§9.2). Runs at concurrency 1 on the PRIMARY/cron instance (like
 *  the event worker) so per-portal ledger reconciles stay ordered even when `worker` is scaled. */
export function startDeletionWorker(deps: DeletionReconcileDeps): Worker {
  return new Worker<DeletionJob>(Q_DELETIONS, async job => withSpan('b24-deletions', {
    // Job-level trace span (#78). Safe shape only: event code + hashed portal, never entity content.
    'job.queue': 'b24-deletions',
    'job.kind': job.data.eventCode,
    'portal.hash': portalHash(job.data.memberId)
  }, () => handleDeletionJob(job.data, deps), r => ({ 'job.outcome_kind': r.outcome })), { connection: connectionOptions() })
}
