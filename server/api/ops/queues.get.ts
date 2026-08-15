// GET /api/ops/queues — queue counts for the operator monitor (/queues page).
// Gated by the OPERATOR SESSION cookie (cba_sess), so a logged-in employee's
// browser can read it (unlike /api/queues, which needs the B24_APPLICATION_TOKEN
// and is nginx-denied). When auth is not configured (no password) the zone is open,
// matching the client route guard. Read-only GET — no CSRF header needed. Same
// payload shape as /api/queues. See docs/AUTH.md, docs/QUEUES.md.

import { SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { readQueueCounts } from '../../queue/stats'
import { queueAlertState } from '../../utils/queueAlertState'
import { keepAlivePulse } from '../../utils/keepAliveState'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  // Health verdict alongside the depths (#426). The snapshot alone cannot tell «навалило работы»
  // from «встало» — that is what the periodic check on this same (cron) instance decides.
  // `alertsCheckedAt` is returned SEPARATELY and on purpose: before the first check an empty alert
  // list means «ещё не смотрели», not «всё хорошо», and the screen must not show one as the other.
  // On a worker-role instance (QUEUE_CRON=0) the check never runs, so it stays null there too —
  // correct, since nginx routes the operator zone to the primary.
  const health = queueAlertState()
  // Пульс продления банковских токенов (#504). Отдаётся РЯДОМ с вердиктом, а не внутри него:
  // тревога говорит «сломалось», а пульс отвечает на вопрос «а оно вообще живо?» — и до первой
  // тревоги ответ на него всё равно нужен. `null` = прогонов в этом процессе не было; экран обязан
  // показать это как «ещё не проверяли», а не как «всё хорошо».
  const pulse = keepAlivePulse()
  return {
    ...(await readQueueCounts()),
    alerts: health.alerts,
    alertsCheckedAt: health.checkedAtMs,
    keepAliveAt: pulse?.atMs ?? null,
    keepAliveSummary: pulse?.summary ?? null
  }
})
