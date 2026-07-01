// BullMQ connection + queue factory. Lazy: nothing connects to Redis at import
// time — a Queue is created only on first getQueue() call, so SSG/build and unit
// tests never need a running Redis. Guarded on REDIS_URL, mirroring db/client.ts.
//
// We pass connection *options* (parsed from REDIS_URL), not an ioredis instance,
// so BullMQ builds the client with its own bundled ioredis — no direct ioredis
// import and no version-coupling between our ioredis and BullMQ's.

import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { QueueName } from './topology'

const queues = new Map<QueueName, Queue>()

/** True when a Redis DSN is configured — producers/workers no-op when it isn't
 *  (SSG/dev without Redis, or a just-installed backend). */
export function queueEnabled(): boolean {
  return !!process.env.REDIS_URL?.trim()
}

/** The Redis DSN, or throw — the queue pipeline needs Redis (like DATABASE_URL). */
export function redisUrl(): string {
  const url = process.env.REDIS_URL?.trim()
  if (!url) throw new Error('REDIS_URL is not set')
  return url
}

/** BullMQ connection options parsed from REDIS_URL. `maxRetriesPerRequest: null`
 *  is required by BullMQ (blocking commands). Pure given the env; throws if unset. */
export function connectionOptions(): ConnectionOptions {
  const u = new URL(redisUrl())
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null
  }
}

// Sensible defaults for every queue: retry transient failures with exponential
// backoff, and cap retained jobs so completed/failed don't grow Redis unbounded
// (BullMQ keeps them all by default). Producers can still override per job.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 }
}

/** Lazily create (and cache) a BullMQ Queue by name. Throws if REDIS_URL is unset. */
export function getQueue(name: QueueName): Queue {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, { connection: connectionOptions(), defaultJobOptions: DEFAULT_JOB_OPTIONS })
    queues.set(name, q)
  }
  return q
}

/** Close all cached Queue connections (graceful shutdown symmetry with workers). */
export async function closeQueues(): Promise<void> {
  const open = [...queues.values()]
  queues.clear()
  await Promise.all(open.map(q => q.close()))
}
