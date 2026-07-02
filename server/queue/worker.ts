// BullMQ worker runtime: binds each queue to its pure handler with live deps.
// Started once on server boot by server/plugins/queue.ts (only when REDIS_URL is
// set). For horizontal scale-out the same startWorkers() can run in a dedicated
// worker container (documented in docs/REFACTOR_PLAN.md) — the handlers don't care
// where they run. The transport deps below are stubs until stages 3–6 fill them in.

import { Worker } from 'bullmq'
import { connectionOptions } from './connection'
import { Q_CRM, Q_EVENTS, Q_FETCH, Q_PARSE } from './topology'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'
import { demoItems } from './cron'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from './handlers'
import { enqueueCrmSync } from './producers'
import { dbQuery } from '../db/client'
import { deleteToken, saveToken } from '../utils/tokenStore'
import { deleteDedupForPortal, getActivityId, rememberActivity } from '../utils/activityDedupStore'
import { decryptSecret } from '../utils/secretCrypto'

/** Live side-effects for the handlers. Transports are stubs for now (return the
 *  demo batch / nothing) with TODOs pointing at the stage that fills them in. */
export function liveHandlerDeps(): HandlerDeps {
  return {
    // TODO stage 3/5: real Alfa/Prior transport. For now emits synthetic ops only
    // for DEMO- accounts (the load demo), and nothing for real accounts.
    fetchStatement: async job => demoItems(job),
    parseFile: async () => [], // TODO #19: wire clientBank parser → StatementItem[]
    // TODO stage 4 (live wiring): bind a per-portal RestCall (ensureAccessToken +
    // callRest for `memberId`) and delegate to findCompanyByAccount(
    // item.counterparty.account) from server/utils/companyLookup.ts (ready + tested).
    // Must GATE demo accounts (item.account starts with DEMO_ACCOUNT_PREFIX) so the
    // load demo never writes to a real portal's CRM.
    findCompany: async () => null,
    // TODO stage 4 (live wiring): build crm.activity.todo.add params via
    // app/utils/activity.ts buildTodoActivity and POST via the per-portal RestCall;
    // return the new activity id (for rememberActivity) or null when skipped.
    writeActivity: async () => null,
    notifyChat: async () => {}, // TODO stage 6: im.message.add by chat rules
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
