// BullMQ connection + queue factory. Lazy: nothing connects to Redis at import
// time — a Queue is created only on first getQueue() call, so SSG/build and unit
// tests never need a running Redis. Guarded on REDIS_URL, mirroring db/client.ts.
//
// We pass connection *options* (parsed from REDIS_URL), not an ioredis instance,
// so BullMQ builds the client with its own bundled ioredis — no direct ioredis
// import and no version-coupling between our ioredis and BullMQ's.

import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Q_EVENTS, type QueueName } from './topology'

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

/** PING the Redis backing the queues, via a cached Queue's shared ioredis client (no new
 *  connection beyond the queue's own). Resolves true on `PONG`; REJECTS on a `timeoutMs`
 *  deadline. The deadline is ESSENTIAL: on an unreachable-but-configured Redis, BullMQ's
 *  `queue.client` awaits `waitUntilReady`, which only rejects on an `end` event — with
 *  ioredis reconnecting forever (`maxRetriesPerRequest: null`) that never fires, so an
 *  un-bounded ping would hang the readiness probe in exactly the outage it must detect.
 *  The readiness probe wraps the rejection to `false` → clean 503. Throws if REDIS_URL is
 *  unset (guard with queueEnabled() first). */
export function pingRedis(timeoutMs = 2000): Promise<boolean> {
  const ping = (async (): Promise<boolean> => {
    // BullMQ types `client` as IRedisClient (no `ping` on the interface), but the underlying
    // ioredis client has it — narrow to the one method we use rather than cast to `any`.
    const client = (await getQueue(Q_EVENTS).client) as unknown as { ping: () => Promise<string> }
    return (await client.ping()) === 'PONG'
  })()
  // Swallow a late rejection if the timeout wins the race (else it's an unhandled rejection).
  ping.catch(() => {})
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs)
    // Don't let the deadline timer keep the event loop alive on its own.
    if (typeof t.unref === 'function') t.unref()
  })
  return Promise.race([ping, timeout])
}

/** Claim a one-shot cooldown slot for `key`, lasting `ttlSec` (Redis `SET key 1 EX ttl NX`).
 *  Returns true when the slot was claimed (caller may proceed), false when a prior claim is still
 *  within its TTL (cooldown active). A store-free, self-expiring, per-portal throttle — used by the
 *  manual poll (#54) so a portal admin can't outrun the bank rate. Uses the shared queue client
 *  (no new connection). Throws if REDIS_URL is unset — guard with queueEnabled() first. */
export async function claimCooldownSlot(key: string, ttlSec: number): Promise<boolean> {
  // ioredis exposes `set(key, val, 'EX', seconds, 'NX')` → 'OK' when set, null when NX fails.
  const client = (await getQueue(Q_EVENTS).client) as unknown as {
    set: (...args: unknown[]) => Promise<unknown>
  }
  const res = await client.set(`cooldown:${key}`, '1', 'EX', Math.max(1, Math.floor(ttlSec)), 'NX')
  return res === 'OK'
}

/** Increment a counter `key` and return the new value, setting a TTL on first creation (Redis
 *  `INCR` then `EXPIRE` when the value is 1). A self-expiring per-window counter — used by the
 *  program feedback hourly cap (docs/FEEDBACK.md). Uses the shared queue client (no new connection).
 *  Throws if REDIS_URL is unset — guard with queueEnabled() first. */
export async function incrementWithTtl(key: string, ttlSec: number): Promise<number> {
  const client = (await getQueue(Q_EVENTS).client) as unknown as {
    incr: (k: string) => Promise<number>
    expire: (k: string, s: number) => Promise<unknown>
  }
  const namespaced = `count:${key}`
  const value = await client.incr(namespaced)
  // EXPIRE on EVERY increment (not just the first): INCR+EXPIRE isn't atomic, so a crash right after
  // a fresh INCR would otherwise orphan a TTL-less key forever. Refreshing the TTL each time is
  // leak-free and harmless here — the key embeds a wall-clock bucket, so a sliding TTL just lets the
  // (already bucket-scoped) counter self-clean ~ttl after its last use.
  await client.expire(namespaced, Math.max(1, Math.floor(ttlSec)))
  return value
}

/** Close all cached Queue connections (graceful shutdown symmetry with workers). */
export async function closeQueues(): Promise<void> {
  const open = [...queues.values()]
  queues.clear()
  await Promise.all(open.map(q => q.close()))
}
