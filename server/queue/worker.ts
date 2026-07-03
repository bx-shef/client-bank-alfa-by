// BullMQ worker runtime: binds each queue to its pure handler with live deps.
// Started once on server boot by server/plugins/queue.ts (only when REDIS_URL is
// set). For horizontal scale-out the same startWorkers() can run in a dedicated
// worker container (documented in docs/REFACTOR_PLAN.md) — the handlers don't care
// where they run. CRM-sync transports (findCompany/writeActivity + dedup) are LIVE;
// the bank fetch/parse transports are still stubs until stages 3/5 fill them in.

import { Worker } from 'bullmq'
import { connectionOptions } from './connection'
import { Q_CRM, Q_EVENTS, Q_FETCH, Q_PARSE } from './topology'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'
import { demoDelayMs, demoItems, isDemoAccount } from './cron'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from './handlers'
import { enqueueCrmSync } from './producers'
import { dbQuery } from '../db/client'
import { deleteToken, getToken, saveToken } from '../utils/tokenStore'
import { deleteDedupForPortal, getActivityId, rememberActivity } from '../utils/activityDedupStore'
import { decryptSecret } from '../utils/secretCrypto'
import { callRest } from '../utils/b24Rest'
import { ensureAccessToken } from '../utils/ensureAccessToken'
import { makePortalRestCall, type PortalRestDeps } from '../utils/portalRest'
import { findCompanyByAccount } from '../utils/companyLookup'
import { writeActivityViaRest } from '../utils/crmActivityWrite'

/** Portal-bound REST wiring for the CRM-sync transports (token store + refresh + REST). */
const portalRestDeps: PortalRestDeps = {
  loadToken: memberId => getToken(dbQuery, memberId),
  ensureFresh: token => ensureAccessToken(dbQuery, token),
  callRest
}

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
    parseFile: async () => [], // TODO #19: wire clientBank parser → StatementItem[]
    // Find the CRM company by the counterparty's settlement account. Demo accounts
    // are GATED (never touch a real portal's REST); an unknown portal (no token)
    // yields null → the op is counted unmatched and nothing is written.
    // TODO stage 5 (before real volume flows): (1) add a REST rate limiter on the
    // crm-sync worker (findCompany ~2 calls + writeActivity 1 call per op, no batching
    // → will hit B24 QUERY_LIMIT_EXCEEDED); (2) bind the per-portal RestCall ONCE per
    // job instead of per-op (findCompany + writeActivity each re-load+refresh today).
    findCompany: async (item, memberId) => {
      // Demo ops: pause (so crm-sync shows a backlog too) then skip — never REST.
      if (isDemoAccount(item.account)) {
        await demoPause(item.account)
        return null
      }
      const call = await makePortalRestCall(memberId, portalRestDeps)
      if (!call) return null
      return findCompanyByAccount(item.counterparty.account, call)
    },
    // Write the universal activity (crm.activity.todo.add) attached to the matched
    // company; returns the new activity id (for rememberActivity) or null when
    // skipped (demo account / no company → no owner / unknown portal).
    writeActivity: async (item, companyId, memberId) => {
      if (isDemoAccount(item.account) || !companyId) return null
      const call = await makePortalRestCall(memberId, portalRestDeps)
      if (!call) return null
      return writeActivityViaRest(item, companyId, call)
    },
    // TODO stage 6 (live wiring): post via notifyChatViaRest(item, dialogId, call) —
    // the message builder + REST wrapper (chatNotifyWrite.ts, chatMessage.ts) are
    // ready + tested. Blocked on real settings storage (#16): no chat target is
    // persisted yet, so wiring now would just skip every time. Gate demo accounts.
    // Before wiring, settle three points (review findings) so the contract lands once:
    //  1) resolve {dialogId, rules} ONCE per job in handleCrmSyncJob and thread them in
    //     (a HandlerDeps change) — else every op does a fresh readAppSetting REST call;
    //  2) decide whether chat fires for UNMATCHED income too — today notifyChat is only
    //     reached after a company matched, so payments from unknown counterparties are
    //     never announced (shouldNotifyChat defaults to announcing credits regardless);
    //  3) a live chat error must NOT fail the job after rememberActivity (the op would
    //     then be skipped on retry → message lost) — swallow/log, or track chat-sent
    //     separately from activity-remembered.
    notifyChat: async () => {},
    // Persistent dedup store (#9) — read-before-write guard, wired to Postgres.
    getActivityId: (memberId, key) => getActivityId(dbQuery, memberId, key),
    rememberActivity: async (memberId, key, activityId) => {
      await rememberActivity(dbQuery, memberId, key, activityId)
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
      await saveToken(dbQuery, {
        memberId: job.memberId,
        domain: job.domain,
        accessToken: c.accessToken,
        refreshToken: c.refreshTokenEnc ? decryptSecret(c.refreshTokenEnc) : '',
        expiresAt: c.expiresAt,
        applicationToken: c.applicationToken
      })
    },
    // Uninstall always erases EVERYTHING for the portal: token row + dedup map.
    deletePortal: async (memberId) => {
      await deleteToken(dbQuery, memberId)
      await deleteDedupForPortal(dbQuery, memberId)
    },
    enqueueCrmSync
  }
}

/** Start one worker per queue. Returns them so the plugin can close on shutdown. */
export function startWorkers(deps: HandlerDeps): Worker[] {
  const connection = connectionOptions()
  return [
    new Worker<EventJob>(Q_EVENTS, async job => handleEventJob(job.data, deps), { connection }),
    // TODO stage 5: once fetchStatement hits the real Alfa API (100 req/min), add a
    // limiter here — new Worker(..., { connection, limiter: { max: 100, duration: 60_000 } }).
    new Worker<FetchJob>(Q_FETCH, async job => handleFetchJob(job.data, deps), { connection }),
    new Worker<ParseJob>(Q_PARSE, async job => handleParseJob(job.data, deps), { connection }),
    new Worker<CrmSyncJob>(Q_CRM, async job => handleCrmSyncJob(job.data, deps), { connection })
  ]
}
