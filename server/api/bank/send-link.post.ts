// POST /api/bank/send-link — передать подключение банка ВЛАДЕЛЬЦУ СЧЁТА сообщением в чат (#19).
// Тонкий I/O поверх чистого `handleSendBankInvite`; гейт тот же, что у «Подключить».
//
// Тело: `{ provider, userId, userName? }`. `userId` — сотрудник портала, выбранный штатным
// диалогом (`$b24.dialog.selectUser`), то есть значение ПРИХОДИТ ИЗВНЕ и проверяется маской в
// чистом ядре, прежде чем стать `DIALOG_ID` личного чата.
//
// ⚠ Referrer-Policy — как у `connect.post.ts`: у Приора мы здесь выпускаем authorize-URL с
// подписанным state, и, хотя наружу он не возвращается, режим ответа держим тот же.

import { randomBytes } from 'node:crypto'
import { handleSendBankInvite } from '../../utils/bankInviteSend'
import { liveConnectDeps } from '../../utils/bankConnectDeps'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { postChatMessage } from '../../utils/chatNotifyWrite'
import { bearerToken, handleWriteSetting } from '../../utils/settingsHandler'
import { BANK_CONTACT_KEY, serializeBankContact } from '../../../app/utils/bankContact'
import { buildAppUriLink } from '../../../app/utils/appUriLink'
import { APP_SLIDER_PLACE_BANK_KEY, APP_URI_PLACE_PARAM } from '../../../app/config/b24'
import { appModuleIdFromEnv } from '../../utils/bankKeyDeps'
import { signKeyGrant } from '../../utils/bankKeyGrant'
import { resolveAuthConfig } from '../../utils/session'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import type { BankProviderId } from '../../../app/types/statement'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-send-link.post', method: 'POST', op: 'bank.send_link', domain },
    async (span) => {
      const body = await readBody(event).catch(() => null) as
        { provider?: string, userId?: string, userName?: string } | null
      setResponseHeader(event, 'Referrer-Policy', 'no-referrer')

      const { status, body: out } = await handleSendBankInvite({
        ...liveConnectDeps(),
        // Сообщение уходит ОТ ИМЕНИ ПРИЛОЖЕНИЯ (#496) на СОХРАНЁННОМ токене портала, а не фрейм-
        // токеном нажавшего: иначе инструкция по доступу к деньгам компании приходила бы как
        // записка от коллеги, и спрашивали бы потом с него. Откат на `im.message.add` внутри
        // `postChatMessage` — там же, где он нужен остальным пяти видам сообщений.
        sendMessage: async (memberId, dialogId, text) => {
          const call = await livePortalSdkCall(memberId)
          if (!call) throw new Error('portal token is not available')
          await postChatMessage(dialogId, text, call, memberId)
        },
        // ⚠ Через ЕДИНСТВЕННЫЙ choke point записи `app.option` (#182), а не своим вызовом:
        // он же проверяет `profile.ADMIN`. Лишний `profile` на редкое ручное действие дешевле
        // второго места, где приложение пишет настройки портала.
        rememberContact: async (accessToken, dom, contact) => {
          const value = serializeBankContact(contact)
          if (!value) return
          const res = await handleWriteSetting({ callRest: frameRestCall }, accessToken, dom, value, BANK_CONTACT_KEY)
          if (res.status !== 200) throw new Error(`app.option.set failed: ${res.status}`)
        },
        alfaClientId: () => (process.env.ALFA_OAUTH_CLIENT_ID || '').trim(),
        // ⚠ ВНУТРЕННЯЯ ссылка портала (#19) — та же механика, что у ссылок на экраны приложения:
        // `/marketplace/view/<код>/?params[place]=…`. Значит бухгалтера аутентифицирует САМ
        // Битрикс24, а подписанный грант лишь именует, кому она выдана; сервер сверит одно с
        // другим. Внешней ссылки с секретом внутри здесь нет по построению.
        keyScreenLink: ({ memberId, domain, provider, userId, expMs }) => {
          const secret = resolveAuthConfig(process.env).secret
          const t = signKeyGrant({ memberId, provider, userId, exp: expMs }, secret)
          if (!t) return null // нет секрета ⇒ грант не подписать ⇒ ссылка была бы мёртвой
          return buildAppUriLink(domain, appModuleIdFromEnv(), {
            [APP_URI_PLACE_PARAM]: APP_SLIDER_PLACE_BANK_KEY,
            t
          })
        }
      }, {
        accessToken: token,
        domain,
        provider: (body?.provider || '').trim() as BankProviderId,
        userId: (body?.userId || '').trim(),
        userName: (body?.userName || '').trim(),
        nonce: randomBytes(16).toString('hex'),
        nowMs: Date.now()
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return out
    }
  )
})
