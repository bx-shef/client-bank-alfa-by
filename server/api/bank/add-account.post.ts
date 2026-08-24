// POST /api/bank/add-account — добавить ЕЩЁ ОДИН счёт к существующему подключению банка (#23).
// Auth = фрейм-токен + X-B24-Domain, admin-only: тот же гейт, что у connect/disconnect/pause —
// банковский доступ портало-широкий. Тонкий I/O над server/utils/bankAccounts.ts.
//
// ⚠ Зачем: согласие банк выдаёт на НАБОР счетов клиента, а строка у нас была одна на счёт. Значит
// второй счёт требовал повторного прохождения OAuth — то есть очередного похода ВЛАДЕЛЬЦА СЧЁТА в
// интернет-банк. У клиента с шестью счетами это шесть походов за тем, на что банк уже дал одно
// разрешение. Здесь новая строка заводится под ТЕМ ЖЕ грантом и делит с ним пару токенов.
//
// ⚠ Адресуется неизменяемым `id` исходной строки, а не номером счёта (#517): номер МЕНЯЕТСЯ, когда
// админ выбирает счёт незавершённому подключению, поэтому адрес из отрисованного списка может
// описывать уже другую строку. Номер едет рядом как ОЖИДАНИЕ вызывающего — расхождение это 409
// «список устарел», а не тихое добавление счёта не к тому подключению.

import { handleAddBankAccount, type AddAccountDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { addBankAccountToGrant, getBankRowGrant } from '../../utils/bankTokenStore'
import { withAdvisoryLock } from '../../utils/dbLock'
import { makeLockedAddAccount } from '../../utils/bankAccountAdd'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): AddAccountDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    // ⚠ Под ГРАНТОВЫМ локом — тем же, что держит обновление токена. Почему вставка новой строки
    // всё равно нуждается в нём, разобрано в `makeLockedAddAccount` и `addBankAccountToGrant`:
    // `INSERT … SELECT` при read committed читает предыдущую версию строки и может скопировать
    // refresh, который банк уже отозвал.
    add: makeLockedAddAccount({
      withLock: withAdvisoryLock,
      add: addBankAccountToGrant,
      grantOf: (memberId, id) => getBankRowGrant(dbQuery, memberId, id)
    })
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  type Raw = { id?: unknown, sourceAccountKey?: unknown, accountKey?: unknown }
  // Кривое/отсутствующее тело не должно давать 500 — проваливаемся в честный 400 обработчика.
  const raw = await readBody<Raw>(event).catch(() => ({} as Raw))
  return withFrameRouteSpan(
    { name: 'http.bank-add-account.post', method: 'POST', op: 'bank.accounts.add', domain },
    async (span) => {
      const { status, body } = await handleAddBankAccount(liveDeps(), {
        accessToken: token,
        domain,
        id: Number(raw?.id),
        sourceAccountKey: typeof raw?.sourceAccountKey === 'string' ? raw.sourceAccountKey : '',
        accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey : ''
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
