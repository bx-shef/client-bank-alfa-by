// Bitrix24 outgoing-event webhook endpoint: POST /api/b24/events.
// Reads the raw (form-urlencoded, PHP-bracket) body and hands it to
// handleEventRequest, which verifies (fail-closed by application_token) and applies
// the mutation: enqueue onto the b24-events queue (primary — the consumer is the
// single writer) OR, if the queue is unavailable, write the store synchronously as
// a fallback. B24 does NOT resend online events, so the fallback is what prevents a
// lost install when Redis is down. See docs/B24_EVENTS.md.

import { parseBracketForm } from '../../../app/utils/b24Events'
import { dbQuery } from '../../db/client'
import { handleEventRequest } from '../../utils/b24EventsHandler'
import { getApplicationToken, saveToken } from '../../utils/tokenStore'
import { LIVE_PORTAL_PURGE_DEPS, portalPurgeReasonText, purgePortalStorage } from '../../utils/portalPurge'
import { encryptSecret } from '../../utils/secretCrypto'
import { enqueueEvent, enqueueDeletion } from '../../queue/producers'
import { rawOauthRefresh, verifyInstallMember, type OAuthFetchFn } from '../../utils/verifyInstallMember'
import { useServerLogger } from '../../utils/serverLogger'
import { portalHash } from '../../utils/telemetryAttributes'

const log = useServerLogger('b24-events')
// ⚠ Канал ТОТ ЖЕ, что у пути через очередь: секция «КТО ОТКЛЮЧАЛ БАНК» (#641) грепает `[bank-connect]`,
// и строка в «своём» канале осталась бы невидимой ровно для той диагностики, ради которой пишется.
const bankConnectLog = useServerLogger('bank-connect')

export default defineEventHandler(async (event) => {
  const envToken = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  // #162: bind the install member_id to the OAuth grant. Needs the app's OAuth creds to refresh; if
  // they're unset, refresh is impossible anyway (crm-sync/keep-alive are dead too) → binding degrades
  // off and install behaves as before (application_token-only). Fixed OAuth host → no SSRF.
  const clientId = process.env.B24_CLIENT_ID?.trim() || ''
  const clientSecret = process.env.B24_CLIENT_SECRET?.trim() || ''
  const bindInstallMember = clientId && clientSecret
    ? (memberId: string, refreshToken: string) => verifyInstallMember(memberId, refreshToken, {
        refresh: rawOauthRefresh(globalThis.fetch as unknown as OAuthFetchFn, { clientId, clientSecret })
      })
    : undefined
  try {
    const raw = (await readRawBody(event)) || ''
    const payload = parseBracketForm(raw)

    const result = await handleEventRequest(payload, {
      envToken,
      loadStoredToken: memberId => getApplicationToken(dbQuery, memberId),
      enqueue: enqueueEvent,
      enqueueDeletion,
      saveCredentials: async (token, eventTs) => {
        await saveToken(dbQuery, token, eventTs)
      },
      // Uninstall erases everything we hold about the portal. B24 does NOT resend online events, so
      // this sync fallback is the only chance to purge when Redis is down.
      // `eventTs` records the ordering tombstone (#77) so a stale register can't resurrect.
      //
      // ⚠ ДО #654 ЗДЕСЬ СТИРАЛСЯ ТОЛЬКО `portal_tokens`, при том что комментарий обещал «purge».
      // Недостиранными оставались БАНКОВСКИЕ КРЕДЫ, а `bankTokenKeepAlive` намеренно вынесен
      // из-под гейта Redis (#489) и продолжал их обновлять каждый час — бессрочно. Ни один
      // уборщик до них не дотягивался: #574 выбирает кандидатов из `portal_tokens` (строки уже
      // нет), #599 хоронит по возрасту токена (токен свежий, его же и продлевают). Приложение
      // удалено, портала у нас нет — а доступ к счёту клиента лежит и поддерживается живым.
      //
      // ⚠ Список хранилищ НЕ повторяем: он в `portalPurge.ts`, и разошёлся он ровно потому, что
      // существовал в двух экземплярах.
      deletePortal: async (memberId, eventTs) => {
        // ⚠ След в журнале ДО стирания — по тем же двум причинам, что и на пути через очередь
        // (#641): это разрушительный путь, и он был ЕДИНСТВЕННЫМ, не оставлявшим в логе ничего.
        // Портал хешируется: строки прямо сейчас уничтожаются, и лог остаётся единственным
        // пережившим упоминанием связи «этот портал ↔ мы держали его банковские креды».
        // Формулировка — НАМЕРЕНИЕ: шагов семь, транзакции нет, «стёрли» было бы утверждением о
        // том, чего ещё не произошло. Аварийный путь достижим только при недоступном Redis, и
        // именно поэтому его молчание было незаметно.
        bankConnectLog.warning(
          `portal ${portalHash(memberId)}: стираем ВСЁ, включая подключения к банкам — `
          + `${portalPurgeReasonText('uninstall')}, аварийный путь без очереди (#654)`
        )
        await purgePortalStorage(dbQuery, memberId, eventTs, LIVE_PORTAL_PURGE_DEPS)
      },
      encrypt: encryptSecret,
      now: () => Date.now(),
      bindInstallMember
    })

    if (result.action) {
      // member_id is a non-secret routing id; outcome tells whether the worker will
      // persist (queued) or we already wrote it here (sync-fallback, Redis down).
      log.info(`${result.action.type} member_id=${result.action.memberId} (${result.outcome})`)
    }

    setResponseStatus(event, result.status)
    return result.body
  } catch (err) {
    // Verify read / enqueue AND sync fallback both failed, or a malformed body:
    // log server-side (no secrets — the message may carry a memberId but never a
    // token) and return 500. Nitro would otherwise leak err.message into the body.
    log.error(`handler error: ${(err as Error)?.message}`)
    setResponseStatus(event, 500)
    return { error: 'internal error' }
  }
})
