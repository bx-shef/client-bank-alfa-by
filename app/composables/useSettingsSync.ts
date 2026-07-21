import { onScopeDispose } from 'vue'
import { B24PullClientManager } from '@bitrix24/b24jssdk'
import { useB24 } from './useB24'
import { LANDING_MARKET_CODE } from '~/utils/landing'
import { SETTINGS_RELOAD_COMMAND, buildSettingsReloadEvent } from '~/utils/settingsSync'

// Cross-instance settings sync (pattern from bitrix24/b24-ai-starter). After an admin saves settings,
// `notifyReload()` fires `pull.application.event.add` on the app's pull channel; other open instances
// subscribed via `subscribeReload()` re-read settings live — so a second admin's open form doesn't
// overwrite with stale values. Both sides are BEST-EFFORT and never throw: the send is a plain REST
// call, and the receive needs the portal's pull server (may be off / unavailable), so it degrades to a
// no-op. Our settings still autosave locally; this only keeps *other* open instances fresh.
// ⚠ Pull channel semantics (module id / command routing) are portal-specific — verify on a live portal.

/** App code as registered on the portal = the pull `MODULE_ID` / subscribe `moduleId`. */
function appModuleId(): string {
  return String(useRuntimeConfig().public.b24MarketCode || LANDING_MARKET_CODE)
}

export function useSettingsSync() {
  const { init, get } = useB24()

  /** Tell other open instances to reload settings. Best-effort — a pull failure never blocks a save. */
  async function notifyReload(): Promise<void> {
    try {
      await init()
      const frame = get()
      if (!frame) return
      await frame.callMethod('pull.application.event.add', buildSettingsReloadEvent(appModuleId()))
    } catch {
      // pull unavailable / not framed → skip; cross-instance sync is a nicety, not correctness
    }
  }

  /**
   * Subscribe to the reload command; calls `onReload` when another instance saves. Returns an
   * unsubscribe fn (also auto-disposed with the calling scope). Best-effort: if the portal pull
   * client can't start, this is a silent no-op.
   */
  function subscribeReload(onReload: () => void): () => void {
    let disposed = false
    let dispose: (() => void) | null = null
    let pull: InstanceType<typeof B24PullClientManager> | null = null

    const teardown = () => {
      try {
        dispose?.()
        pull?.destroy?.()
      } catch { /* ignore */ }
      dispose = null
      pull = null
    }

    void (async () => {
      try {
        await init()
        if (disposed) return
        const frame = get()
        if (!frame) return
        const moduleId = appModuleId()
        pull = new B24PullClientManager({ b24: frame, restApplication: moduleId })
        // The SDK dispatches this callback ONLY for the subscribed command bucket (reload.options),
        // so react unconditionally; there's no {command} arg to re-check.
        dispose = pull.subscribe({ moduleId, command: SETTINGS_RELOAD_COMMAND, callback: () => onReload() })
        // disposed mid-await → drop the just-built client
        if (disposed) {
          teardown()
          return
        }
        await pull.start()
        if (disposed) teardown()
      } catch {
        // pull server off / not framed → no live sync; local autosave still works
      }
    })()

    const unsubscribe = () => {
      disposed = true
      teardown()
    }
    onScopeDispose(unsubscribe)
    return unsubscribe
  }

  return { notifyReload, subscribeReload }
}
