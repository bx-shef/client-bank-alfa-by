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
import { deleteToken } from '../utils/tokenStore'

/** Live side-effects for the handlers. Transports are stubs for now (return the
 *  demo batch / nothing) with TODOs pointing at the stage that fills them in. */
export function liveHandlerDeps(): HandlerDeps {
  return {
    // TODO stage 3/5: real Alfa/Prior transport. For now emits synthetic ops only
    // for DEMO- accounts (the load demo), and nothing for real accounts.
    fetchStatement: async job => demoItems(job),
    parseFile: async () => [], // TODO #19: wire clientBank parser → StatementItem[]
    findCompany: async () => null, // TODO stage 4: crm.requisite.bankdetail lookup
    writeActivity: async () => {}, // TODO stage 4: crm.activity.todo.add
    notifyChat: async () => {}, // TODO stage 6: im.message.add by chat rules
    deletePortal: async (memberId) => {
      if (process.env.DATABASE_URL) await deleteToken(dbQuery, memberId)
    },
    enqueueCrmSync
  }
}

/** Start one worker per queue. Returns them so the plugin can close on shutdown. */
export function startWorkers(deps: HandlerDeps): Worker[] {
  const connection = connectionOptions()
  return [
    new Worker<EventJob>(Q_EVENTS, async job => handleEventJob(job.data, deps), { connection }),
    new Worker<FetchJob>(Q_FETCH, async job => handleFetchJob(job.data, deps), { connection }),
    new Worker<ParseJob>(Q_PARSE, async job => handleParseJob(job.data, deps), { connection }),
    new Worker<CrmSyncJob>(Q_CRM, async job => handleCrmSyncJob(job.data, deps), { connection })
  ]
}
