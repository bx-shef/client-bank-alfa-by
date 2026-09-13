// GET /api/bank/contact — кому в прошлый раз передавали подключение банка (#19). Тонкий I/O над
// `handleReadBankContact`.
//
// ⚠ Свой ключ `app.option` (`BANK_CONTACT_KEY`), а не общий блоб настроек: тот редактируется
// формой с явными Save/Cancel, и запись адресата с сервера затиралась бы следующим сохранением
// формы — молча. Разбор причины — в `app/utils/bankContact.ts`.

import { handleReadBankContact } from '../../utils/bankContactHandler'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-contact.get', method: 'GET', op: 'bank.contact', domain },
    async (span) => {
      const { status, body } = await handleReadBankContact({ callRest: frameRestCall }, token, domain)
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
