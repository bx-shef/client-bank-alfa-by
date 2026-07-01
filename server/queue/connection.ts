// BullMQ connection + queue factory. Lazy: nothing connects to Redis at import
// time — a Queue (and its ioredis connection) is created only on first getQueue()
// call, so SSG/build and unit tests never need a running Redis. Guarded on
// REDIS_URL, mirroring server/db/client.ts. Producers/workers land with the
// pipeline stages (see server/queue/topology.ts, docs/REFACTOR_PLAN.md).

import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import type { QueueName } from './topology'

let connection: IORedis | undefined
const queues = new Map<QueueName, Queue>()

/** The Redis DSN, or throw — the queue pipeline needs Redis (like DATABASE_URL). */
export function redisUrl(): string {
  const url = process.env.REDIS_URL?.trim()
  if (!url) throw new Error('REDIS_URL is not set')
  return url
}

/** Shared ioredis connection. `maxRetriesPerRequest: null` is required by BullMQ
 *  (blocking commands); an `error` listener keeps a dropped connection from
 *  crashing the process. Created on first use. */
function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null })
    connection.on('error', err => console.error('[redis] connection error:', err.message))
  }
  return connection
}

/** Lazily create (and cache) a BullMQ Queue by name. Throws if REDIS_URL is unset. */
export function getQueue(name: QueueName): Queue {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, { connection: getConnection() })
    queues.set(name, q)
  }
  return q
}
