// Shared queue observability read: per-queue BullMQ job counts (waiting/active/
// completed/failed/delayed/paused). Used by both guarded endpoints —
// GET /api/queues (B24_APPLICATION_TOKEN, console/diagnostics) and
// GET /api/ops/queues (operator session, the /queues monitor). DI over the queue
// accessors so it is unit-testable without Redis.

import { getQueue, queueEnabled } from './connection'
import { QUEUE_NAMES, type QueueName } from './topology'

export interface QueuesSnapshot {
  /** false when the queue bus is off (no REDIS_URL) — the monitor shows a note. */
  enabled: boolean
  /** Per-queue job counts, keyed by queue name. Empty when disabled. */
  queues: Record<string, unknown>
}

/**
 * Read per-queue job counts. Injected deps default to the live BullMQ accessors;
 * tests pass fakes. Returns `{ enabled: false }` when the bus is off (no Redis).
 */
export async function readQueueCounts(
  isEnabled: () => boolean = queueEnabled,
  countsOf: (name: QueueName) => Promise<unknown> = name => getQueue(name).getJobCounts()
): Promise<QueuesSnapshot> {
  if (!isEnabled()) return { enabled: false, queues: {} }
  const queues: Record<string, unknown> = {}
  for (const name of QUEUE_NAMES) queues[name] = await countsOf(name)
  return { enabled: true, queues }
}
