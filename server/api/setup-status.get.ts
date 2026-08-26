// GET /api/setup-status — server-side half of the setup-readiness checklist (#409/#405): how many
// bank accounts are connected, whether automatic polling is on and with what period, and when the
// last run finished. Auth = B24 frame token + X-B24-Domain, admin-only (same model as the bank
// routes). Thin I/O over the pure handler (server/utils/setupStatus.ts).
//
// Portal settings are deliberately NOT echoed here — the client already has them; duplicating them
// would create a second source of truth that can disagree with the settings form.

import { handleSetupStatus, type SetupStatusDeps } from '../utils/setupStatus'
import { findMyCompanyAccounts, myCompanyGate } from '../utils/myCompanyRequisites'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall, livePortalSdkCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { listBankAccountInfoForPortal } from '../utils/bankTokenStore'
import { getImportResult, getRecognitionMisconfig } from '../utils/importResultStore'
import { summarizeBankHealth, unhealthyConnections } from '../../app/utils/bankHealthOverview'
import { queueEnabled } from '../queue/connection'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../utils/telemetryAttributes'
import { dbQuery } from '../db/client'
import { isPendingAccountKey } from '../../app/utils/bankAccountKey'
import { pickAppOption } from '../utils/appSettings'
import { SETTINGS_KEY, parsePortalSettings } from '../../app/utils/settings'
import { paymentSpRef } from '../../app/config/distributionSp'

function liveDeps(): SetupStatusDeps {
  const interval = Number(process.env.CRON_INTERVAL_MIN ?? NaN)
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    // Подключения без выбранного счёта (#407) НЕ считаются: с них ничего не забрать, а зелёная
    // строка «банк подключён» на таком портале — ровно та ложная галочка, ради которой экран и
    // существует.
    // ⚠ Считаем не только НАЛИЧИЕ строки, но и СОСТОЯНИЕ подключения (#504): продлить его может
    // быть уже нечем (`no-refresh`) или поздно (`expired`), и тогда зелёная строка «банк подключён»
    // — та же ложная галочка, что и на ожидающем подключении, только дороже: импорт уже стоит.
    // Отсюда `listBankAccountInfoForPortal`, а не `…AccountsForPortal` — первый несёт свежесть.
    // ⚠ Ни одной собственной строки арифметики здесь нет, и это намеренно: роут не покрывается
    // юнит-тестами, а посчитанное по месту в этом проекте уже однажды можно было заменить на
    // константу, не уронив ни одного теста. Всё считает `summarizeBankHealth` — то самое ядро,
    // которым живёт экран оператора, и оно же само выносит ожидающие подключения из состояний.
    countAccounts: async (memberId) => {
      const rows = await listBankAccountInfoForPortal(dbQuery, memberId)
      const o = summarizeBankHealth(rows, Date.now())
      return {
        connected: o.total.connections - o.pending.connections,
        pending: o.pending.connections,
        unhealthy: unhealthyConnections(o),
        // Пауза (#576) считается ЗДЕСЬ, по тем же строкам, а не через `summarizeBankHealth`: та
        // сводка описывает ЗДОРОВЬЕ подключения, а пауза здоровьем не является — подключение живо,
        // токен продлевается. Смешать их значило бы показать выбор администратора как неполадку.
        // ⚠ Незавершённые не считаем: опрашивать там нечего, и пауза на них не ставится.
        paused: rows.filter(r => r.pollPaused && !isPendingAccountKey(r.accountKey)).length
      }
    },
    // BOTH conditions the cron actually needs, not just the flag: the scheduler returns early
    // without Redis (`queueEnabled`), so reporting the flag alone would show a confident green
    // «опрос включён» while nothing polls at all — the exact silent gap this screen exists to
    // expose, and the worst possible thing for it to get wrong.
    pollEnabled: (process.env.CRON_REAL_POLL ?? '0') === '1' && queueEnabled(),
    pollIntervalMin: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 5,
    // «Моя компания» с расчётным счётом (#493) — тем же фрейм-токеном админа. Отказ проглатывает
    // сам хендлер: строка тогда не рисуется, а остальной экран остаётся полезным.
    myCompany: async (domain, accessToken) =>
      myCompanyGate(await findMyCompanyAccounts((method, params) => frameRestCall(domain, accessToken, method, params))),
    lastRunMs: async (memberId) => {
      const run = await getImportResult(dbQuery, memberId)
      if (!run?.lastSyncAt) return null
      const ms = Date.parse(run.lastSyncAt)
      return Number.isFinite(ms) ? ms : null
    },
    // Persistent-признак misconfig карты распознавания (#595) — сырая причина, слот выделит хендлер.
    recognitionMisconfig: async (memberId) => {
      const m = await getRecognitionMisconfig(dbQuery, memberId)
      return m?.reason ?? null
    },
    // Какие поля смарт-процесс «Платежи» реально несёт (#46).
    //
    // ⚠ Читается на СТОРЕДНОМ токене портала, а не фрейм-токеном админа: это факт о портале, а не
    // о том, кто открыл настройки.
    // ⚠ `crm.item.fields`, а НЕ `userfieldconfig.list`: второму нужно право `userfieldconfig`,
    // которого у портала может не быть (требует переустановки приложения) — а именно на таком
    // портале проверка и нужнее всего. `crm.item.fields` обходится правом `crm`.
    // ⚠ `useOriginalUfNames:'N'` ПЕРЕДАЁТСЯ ЯВНО. Это умолчание метода, но опираться на умолчание,
    // когда есть выбор, незачем: под `'Y'` имена приходят в оригинальной форме, и хотя сверка её
    // переживёт (`normalizeFieldNameForCompare`), полагаться на две страховки разом не нужно.
    // ⚠ `null` при любой заминке — «не спросили» не должно краситься как «полей нет». Пустой
    // список полей это ТОЖЕ `null`, а не `[]`: `crm.item.fields` всегда возвращает системные поля,
    // поэтому пустота означает неожиданный ответ, а `[]` уехал бы клиенту как «нет ни одного поля»
    // и покрасил бы исправный портал красным (находка ревью).
    spFieldNames: async (memberId) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return null
      const cf = parsePortalSettings(pickAppOption(await call('app.option.get', {}), SETTINGS_KEY)).recognition.configFields
      const ref = paymentSpRef(cf)
      if (!ref) return null // СП не создан — про поля говорить нечего, строка и так красная
      const res = await call('crm.item.fields', { entityTypeId: ref.entityTypeId, useOriginalUfNames: 'N' })
      const fields = (res?.result as { fields?: Record<string, unknown> } | undefined)?.fields
      if (!fields || typeof fields !== 'object') return null
      const names = Object.keys(fields)
      return names.length > 0 ? names : null
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  // Дорогая проверка полей СП (#46) — только по явному запросу того экрана, который её показывает.
  const wantFields = getQuery(event).fields === '1'
  return withFrameRouteSpan(
    { name: 'http.setup-status.get', method: 'GET', op: 'setup.status', domain },
    async (span) => {
      const { status, body } = await handleSetupStatus(liveDeps(), { accessToken: token, domain, wantFields })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
