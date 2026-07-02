/**
 * Pure builder for the `event.bind` / `event.unbind` batch the install script
 * runs so the backend receives Bitrix24 server events (ONAPPINSTALL / ONAPPUNINSTALL).
 *
 * `event.get` lists only THIS app's bindings, so every entry belongs to us:
 * - a wanted event already bound to `handlerUrl` → leave it (idempotent re-install);
 * - a wanted event bound elsewhere (stale handler from an old deploy/domain) → unbind;
 * - a wanted event with no matching binding → bind.
 *
 * No SDK import — unit-testable without the b24jssdk runtime. Transport (the actual
 * `actions.v2.batch.make`) is the caller's (install.vue), mirroring b24Placements.ts.
 */

/** One binding as returned by the `event.get` REST method. */
export interface EventBinding {
  event: string
  handler: string
}

/** A single REST call for a batch (`{ method, params }`). */
export interface B24Call {
  method: string
  params: Record<string, unknown>
}

export interface EventBindPlan {
  /** Stale bindings to remove first (best-effort — a missing one is fine). */
  unbind: B24Call[]
  /** Bindings to create for events not already pointing at `handlerUrl`. */
  bind: B24Call[]
}

/**
 * @param existing bindings from `event.get` (this app only)
 * @param events   events we want bound (case-insensitive; normalised to upper-case)
 * @param handlerUrl absolute URL of the backend events endpoint
 */
export function buildEventBindCalls(
  existing: EventBinding[],
  events: readonly string[],
  handlerUrl: string
): EventBindPlan {
  const wanted = events.map(e => e.toUpperCase())
  const wantedSet = new Set(wanted)

  const unbind: B24Call[] = []
  const boundToUs = new Set<string>()
  for (const b of existing) {
    const ev = (b?.event ?? '').toUpperCase()
    if (!wantedSet.has(ev)) continue
    if (b.handler === handlerUrl) boundToUs.add(ev)
    else unbind.push({ method: 'event.unbind', params: { event: ev, handler: b.handler } })
  }

  const bind: B24Call[] = []
  for (const ev of wanted) {
    if (!boundToUs.has(ev)) bind.push({ method: 'event.bind', params: { event: ev, handler: handlerUrl } })
  }

  return { unbind, bind }
}
