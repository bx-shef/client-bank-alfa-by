// Pure dedup + rate-cap decision for the «программа» feedback channel (docs/FEEDBACK.md): a broken
// format or a persistently-unmatched portal must NOT spawn hundreds of issues. Two guards over
// injected Redis primitives (DI → unit-testable without Redis):
//   1. DEDUP by problem-shape signature — the same set of confused kinds for a portal files at most
//      once per `dedupWindowSec` (a self-expiring NX slot).
//   2. PER-PORTAL HOURLY CAP — even across distinct signatures, never more than `hourlyCap` issues
//      per portal per hour (an INCR bucket).
// Both must pass to file. Mirrors the kit's «дедуп по корню + кап N/час».

export interface ProgramFeedbackGateDeps {
  /** SET key 1 EX ttl NX → true when freshly claimed, false when a prior claim is still live. */
  claimDedup: (key: string, ttlSec: number) => Promise<boolean>
  /** INCR key (+ EXPIRE on first) → the new count. */
  incrCap: (key: string, ttlSec: number) => Promise<number>
  /** Clock (ms) — injected for a deterministic hour bucket. */
  now: () => number
}

export interface ProgramFeedbackGateOptions {
  /** Dedup window for a given signature (default 1h). */
  dedupWindowSec?: number
  /** Max issues per portal per hour (default 10, like the kit). */
  hourlyCap?: number
}

export type ProgramFeedbackGate = { file: true } | { file: false, reason: 'dup' | 'cap' }

const HOUR_MS = 3_600_000

/**
 * Decide whether to file a program feedback issue for `memberId` with problem-shape `signature`.
 * Dedup is checked FIRST (cheap NX slot) so a repeat signature doesn't consume a cap slot; only a
 * fresh signature proceeds to the hourly INCR cap. Any Redis error propagates to the caller (which
 * swallows it best-effort). `signature` is caller-sanitized (a fixed `+`-joined kind list).
 */
export async function claimProgramFeedbackSlot(
  deps: ProgramFeedbackGateDeps,
  memberId: string,
  signature: string,
  opts: ProgramFeedbackGateOptions = {}
): Promise<ProgramFeedbackGate> {
  const window = Math.max(1, Math.floor(opts.dedupWindowSec ?? 3600))
  const cap = Math.max(1, Math.floor(opts.hourlyCap ?? 10))

  const fresh = await deps.claimDedup(`progfb:dedup:${memberId}:${signature}`, window)
  if (!fresh) return { file: false, reason: 'dup' }

  const bucket = Math.floor(deps.now() / HOUR_MS)
  const count = await deps.incrCap(`progfb:cap:${memberId}:${bucket}`, 3600)
  if (count > cap) return { file: false, reason: 'cap' }

  return { file: true }
}
