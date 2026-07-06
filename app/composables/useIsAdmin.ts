import { ref } from 'vue'
import { useB24 } from '~/composables/useB24'

// Whether the current portal user is a Bitrix24 administrator. The frame SDK
// exposes this synchronously via `$b24.auth.isAdmin` (populated from IS_ADMIN in
// the install/handshake data — see @bitrix24/b24jssdk frame AuthManager). We gate
// the settings UI on it: a non-admin sees a warning instead of the form.
//
// `inPortal` distinguishes "outside the iframe" (no SDK, admin unknown → not
// blocked, standalone/dev) from "in the portal, not admin" (blocked). Call
// `check()` after useB24().init() (onMounted). No REST call needed.
export function useIsAdmin() {
  const inPortal = ref(false)
  const isAdmin = ref(false)

  function check() {
    const b24 = useB24()
    inPortal.value = b24.isInit()
    if (!inPortal.value) {
      isAdmin.value = false
      return
    }
    try {
      isAdmin.value = Boolean(b24.getOrThrow().auth.isAdmin)
    } catch {
      isAdmin.value = false
    }
  }

  return { inPortal, isAdmin, check }
}
