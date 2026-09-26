// «Передать владельцу счёта» — отправка подключения банка сотруднику портала сообщением в чат
// (#19). Чистое ядро с DI; транспорты (портал, чат, хранение адресата) живут в маршруте.
//
// ⚠ ЗАЧЕМ. Подключение банка админское, а пароль от интернет-банка знает не администратор.
// Раньше единственным способом передать ссылку было скопировать её из поля и переслать вручную —
// то есть САМЫЙ ЧАСТЫЙ сценарий подключения приложением не поддерживался. Теперь администратор
// выбирает сотрудника штатным диалогом портала, а сообщение уходит от имени приложения.
//
// ⚠ ГЕЙТ ТОТ ЖЕ, что у «Подключить», и проходится РОВНО ОДИН РАЗ: `gateConnectAdmin` (портал
// установлен → фрейм-токен доказан для ЭТОГО домена → человек администратор → есть «моя компания»
// со счётом). Отправка ссылки — это то же самое действие, что подключение, просто чужими руками:
// послабление здесь означало бы, что любой сотрудник рассылает коллегам приглашения привязать
// банковские креды ко всему порталу.
//
// ⚠ ССЫЛКА ВЫПУСКАЕТСЯ ЗДЕСЬ ЖЕ, а не берётся с экрана. Её срок (`CONNECT_STATE_TTL_MS`) идёт с
// момента выпуска, и переслать уже показанную означало бы отдать получателю остаток чужого
// отсчёта — иногда секунды. Выпуск при отправке делает названный в сообщении срок правдой.
//
// ⚠ У АЛЬФЫ ССЫЛКИ НЕТ ВОВСЕ (#488): она подключается ключом API, который владелец счёта выпускает
// у себя в кабинете. Поэтому «передать» для неё — это инструкция, а не ссылка, и `precheckConnect`
// (он отвергает всё, кроме Приора) к этому пути не применяется.

import {
  BANK_KEY_GRANT_TTL_HOURS, BANK_KEY_GRANT_TTL_MS, CONNECT_STATE_TTL_MIN, CONNECT_STATE_TTL_MS
} from '../../app/utils/bankConnectTtl'
import { buildAlfaInvite, buildAlfaInviteGuide, buildPriorInvite } from '../../app/utils/bankConnectInvite'
import type { ChatAttachment } from '../../app/utils/chatAttach'
import { isValidPortalUserId, type BankContact } from '../../app/utils/bankContact'
import { buildConnectAuthorizeUrl, gateConnectAdmin, precheckConnect, type ConnectStartDeps, type ConnectStartResult } from './bankConnectStart'
import { describeUpstreamError } from './logSanitize'
import { ALFA_CLIENT_ID_MISSING } from './bankConnectKey'
import type { BankProviderId } from '../../app/types/statement'

/** Банки, которым есть что передать. `manual` — файловая загрузка, приглашать некуда. */
const INVITABLE: readonly BankProviderId[] = ['alfa-by', 'prior-by']

export interface InviteSendDeps extends Pick<
  ConnectStartDeps,
  'memberIdByDomain' | 'validateFrame' | 'myCompanyGate' | 'priorConfig' | 'buildPriorUrl' | 'secret' | 'log'
> {
  /** Отправить сообщение сотруднику (`dialogId` личного чата = его id). Бросает при отказе.
   *  `attachment` — шаги со снимками (только у Альфы) вместе с полным текстом: транспорт обязан
   *  пережить непринятие вложения порталом, отправив полный текст (`postChatMessage`). */
  sendMessage: (memberId: string, dialogId: string, text: string, attachment?: ChatAttachment | null) => Promise<void>
  /** Запомнить адресата на портале. Best-effort у вызывающего — исход влияет только на удобство. */
  rememberContact: (accessToken: string, domain: string, contact: BankContact) => Promise<void>
  /** Наш `client_id` для кабинета Альфы (из env). Пусто ⇒ инструкцию не собрать. */
  alfaClientId: () => string
  /** Публичный адрес приложения (`NUXT_PUBLIC_SITE_URL`) — из него строятся ссылки на картинки шагов.
   *  Пусто ⇒ картинок не будет, уйдёт полный текст инструкции: он самодостаточен и без них. */
  siteUrl: () => string
  /** ВНУТРЕННЯЯ ссылка портала на экран ввода ключа для этого сотрудника (#19). `null` ⇒ собрать
   *  её нечем (не настроен секрет подписи или код приложения) — сообщение не отправляем. */
  keyScreenLink: (input: { memberId: string, domain: string, provider: BankProviderId, userId: string, expMs: number }) => string | null
}

export interface InviteSendInput {
  accessToken: string
  domain: string
  provider: BankProviderId
  /** Кому отправляем — id сотрудника портала из штатного диалога выбора. */
  userId: string
  /** Имя на момент выбора; только для подписи в интерфейсе. */
  userName?: string
  /** Случайный nonce для state (как у «Подключить»). */
  nonce: string
  nowMs: number
  ttlMs?: number
}

/**
 * Собрать ссылку/инструкцию и отправить её выбранному сотруднику.
 *
 * Порядок проверок — от дешёвых к дорогим, и «моя компания» (внутри гейта) стоит до любого
 * обращения к банку: уткнуться в ненастроенный портал ПОСЛЕ того, как человек сходил в
 * интернет-банк, дороже всего.
 */
export async function handleSendBankInvite(deps: InviteSendDeps, input: InviteSendInput): Promise<ConnectStartResult> {
  const { accessToken, domain, provider, userId, nonce, nowMs } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  if (!INVITABLE.includes(provider)) {
    return { status: 400, body: { error: 'provider required' } }
  }
  // ⚠ Проверяем ДО похода в портал: опечатка в идентификаторе не должна стоить REST-вызова, а
  // главное — сообщение ушло бы не тому человеку, и узнать об этом было бы неоткуда.
  if (!isValidPortalUserId(userId)) {
    return { status: 400, body: { error: 'valid portal user id required' } }
  }
  // Только приоровский путь умеет отвечать «этот банк подключается ключом API» — у Альфы здесь
  // проверять нечего, её инструкция не зависит ни от state, ни от конфигурации OAuth.
  if (provider === 'prior-by') {
    const pre = precheckConnect(deps, provider, '')
    if (pre) return pre
  }

  const gate = await gateConnectAdmin(deps, { accessToken, domain })
  if (!gate.ok) return gate.res

  let text: string | null
  let ttlMin: number | undefined
  // ⚠ Картинки ТОЛЬКО у Альфы: у Приора владелец счёта ничего не выпускает руками — он открывает
  // присланную ссылку и подтверждает согласие на сайте банка, и снимать там нечего.
  let attachment: ChatAttachment | null = null
  if (provider === 'prior-by') {
    const ttlMs = input.ttlMs ?? CONNECT_STATE_TTL_MS
    const built = await buildConnectAuthorizeUrl(deps, {
      memberId: gate.memberId, provider, accountKey: '', nonce, nowMs, ttlMs
    })
    // Отказ банка/конфигурации отдаём КАК ЕСТЬ: он уже описан словами того пути, и второй слой
    // формулировок («не удалось отправить») скрыл бы, что дело не в чате, а в подключении.
    if (built.status !== 200) return built
    const link = String((built.body as { authorizeUrl?: unknown }).authorizeUrl ?? '')
    ttlMin = Math.round(ttlMs / 60_000) || CONNECT_STATE_TTL_MIN
    text = buildPriorInvite({ link, ttlMin })
  } else {
    // ⚠ ССЫЛКА ВНУТРЕННЯЯ, а не на банк: она открывает НАШ экран внутри портала, где владелец
    // счёта сам вставит ключ. Тем самым ключ вообще не попадает в чат — а он бессрочен и
    // отзывается только в кабинете банка.
    const link = deps.keyScreenLink({
      memberId: gate.memberId, domain, provider, userId, expMs: nowMs + BANK_KEY_GRANT_TTL_MS
    })
    if (!link) {
      // Тот же класс, что у `client_id` ниже: настройка СЕРВЕРА, и сказать это надо по-русски —
      // английский текст доезжает до экрана администратора как есть.
      return { status: 503, body: { error: 'на сервере приложения не задан секрет подписи ссылок (переменная SESSION_SECRET) — это настройка сервера приложения, а не портала' } }
    }
    const alfa = { clientId: deps.alfaClientId(), link, ttlHours: BANK_KEY_GRANT_TTL_HOURS }
    text = buildAlfaInvite(alfa)
    if (!text) {
      // Отсутствие `client_id` — состояние СЕРВЕРА, а не ошибка нажавшего: инструкция без него
      // приводит владельца счёта к обязательному полю, которое нечем заполнить.
      return { status: 503, body: { error: ALFA_CLIENT_ID_MISSING } }
    }
    ttlMin = BANK_KEY_GRANT_TTL_HOURS * 60
    // Шаги со снимками уходят вложением, а в тексте остаются вступление, ссылка и предупреждения;
    // полный текст едет рядом — на случай, когда портал вложение отвергнет.
    const guide = buildAlfaInviteGuide(alfa, deps.siteUrl())
    if (guide) {
      text = guide.text
      attachment = guide.attachment
    } else {
      // ⚠ Отсутствие картинок отправку НЕ отменяет (полный текст инструкции самодостаточен), но и
      // молчать о нём нельзя. Причина здесь ровно одна — адрес приложения непригоден для ссылки на
      // картинку: ввод уже проверен `buildAlfaInvite` выше, отказать осталось только адресу.
      // Снаружи это неотличимо от «портал не принял вложение», а чинится в совершенно другом
      // месте, поэтому две причины обязаны различаться в логе. ⚠ Фразу ищет `make chat-log`
      // (`scripts/prod-chat-log.sh`) — не менять порознь.
      deps.log?.('bank invite: картинки шагов не приложены — адрес приложения непригоден для ссылки')
    }
  }
  if (!text) {
    // Сюда попадаем, только если ссылка не прошла проверку билдера — то есть мы собрали бы
    // сообщение с нерабочим адресом. Молчать нельзя: получатель сходил бы в банк зря.
    return { status: 502, body: { error: 'connect link is malformed (nothing was sent)' } }
  }

  try {
    await deps.sendMessage(gate.memberId, userId, text, attachment)
  } catch (e) {
    deps.log?.(`bank invite: chat delivery failed: ${describeUpstreamError(e)}`)
    return { status: 502, body: { error: 'portal did not accept the message' } }
  }

  // ⚠ ПОСЛЕ отправки и best-effort: адресат — удобство следующего раза, и его отказ не отменяет
  // того, что сообщение уже доставлено. Обратный порядок означал бы «не смогли записать в
  // настройки ⇒ не отправили», то есть отказ от главного ради второстепенного.
  try {
    await deps.rememberContact(accessToken, domain, {
      userId,
      ...(input.userName?.trim() ? { name: input.userName.trim() } : {})
    })
  } catch (e) {
    deps.log?.(`bank invite: contact not remembered: ${describeUpstreamError(e)}`)
  }

  return { status: 200, body: { sent: true, provider, userId, ...(ttlMin ? { ttlMin } : {}) } }
}
