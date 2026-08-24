// POST /api/ops/bank-disconnect { id } — оператор отключает НЕРАБОЧЕЕ банк-подключение с /queues
// (#599). Сессия оператора + CSRF-заголовок (изменяющее состояние действие, тот же гейт, что у
// /api/ops/app-rating). Логика — в чистом `handleOpsBankDisconnect`; здесь только I/O и проводка
// пометки в чат ошибок портала.
//
// ⚠ Пометка идёт на ХРАНИМОМ OAuth-токене портала (как §9.2 в воркере): читаем errorChat из
// настроек и шлём `postChatMessage`. Best-effort: чат может быть не настроен/недоступен — это не
// отменяет уже выполненного удаления.

import { CSRF_HEADER, SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { handleOpsBankDisconnect } from '../../utils/bankDisconnectOpsHandler'
import { getBankAccountInfoById, deleteBankTokenById } from '../../utils/bankTokenStore'
import { livePortalSdkCall } from '../../utils/liveDeps'
import { readAppSettingVia } from '../../utils/appSettings'
import { SETTINGS_KEY, parsePortalSettings } from '../../../app/utils/settings'
import { buildBankDisconnectNotice } from '../../../app/utils/bankDisconnectNotice'
import { postChatMessage } from '../../utils/chatNotifyWrite'
import { portalHash } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'
import { useServerLogger } from '../../utils/serverLogger'

const log = useServerLogger('bank-connect')

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  if (!getHeader(event, CSRF_HEADER)) {
    setResponseStatus(event, 403)
    return { error: 'missing csrf header' }
  }
  const body = await readBody(event).catch(() => ({})) as { id?: unknown }

  const res = await handleOpsBankDisconnect({
    now: Date.now,
    getRow: id => getBankAccountInfoById(dbQuery, id),
    remove: (memberId, id, key) => deleteBankTokenById(dbQuery, memberId, id, key),
    // Пометка клиенту — best-effort. Свой try/catch: отказ чата не должен превращаться в 500 после
    // уже выполненного удаления. Кто отключил (оператор) — в лог, но НЕ в сообщение клиенту.
    notify: async (row, reason) => {
      try {
        log.info(`portal ${portalHash(row.memberId)}: ${row.provider} #${row.id} — отключено оператором (нерабочее: ${reason})`)
        const call = await livePortalSdkCall(row.memberId)
        if (!call) return
        const dialogId = parsePortalSettings(await readAppSettingVia(call, SETTINGS_KEY)).errorChat.dialogId
        if (!dialogId) return
        await postChatMessage(dialogId, buildBankDisconnectNotice(row.provider, row.accountKey, reason), call, row.memberId)
      } catch (e) {
        log.warning(`bank-disconnect notice failed (portal ${portalHash(row.memberId)}): ${(e as Error)?.message}`)
      }
    }
  }, body?.id)

  setResponseStatus(event, res.status)
  return res.body
})
