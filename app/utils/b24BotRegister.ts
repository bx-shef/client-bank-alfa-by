/**
 * Pure builder for the `imbot.v2.Bot.register` call (#496) — so chat messages arrive from the APP,
 * not from whichever employee's OAuth token the worker happens to hold.
 *
 * WHY IT MATTERS MOST FOR THE ERROR CHAT. `im.message.add` posts as the token OWNER; there is no
 * other mode. So «Клиент не определён, заведите реквизит» reaches the accountant looking like a
 * message from a colleague — and it is that colleague who then gets asked about it.
 *
 * ⚠ TWO GENERATIONS OF THIS API. `imbot.register` / `imbot.message.add` are DEPRECATED; the live
 * pair is `imbot.v2.Bot.register` + `imbot.v2.Chat.Message.send`, scope `imbot`. Do not «simplify»
 * back to the short names.
 *
 * ⚠ `botToken` is for WEBHOOK-registered bots only and must never be sent under OAuth. `eventMode`
 * defaults to `fetch`, which is right for a bot that only ever sends — we expose no webhook URL for
 * the portal to call back into.
 *
 * Registration is IDEMPOTENT BY `code`: re-registering returns the existing bot and overwrites
 * nothing, so the install flow may call it on every (re)install with no dedup of our own.
 *
 * No SDK import — unit-testable; the transport is the caller's, like `b24TriggerRegister.ts`.
 */

import type { B24Call } from './b24EventBind'

/** Bot properties the portal shows next to each message. */
export interface BotRegistration {
  /** Idempotency key ON THE CLIENT'S PORTAL — see the warning on `B24_CHAT_BOT`. */
  code: string
  name: string
  /** Shown under the name, where a person's job title would be. */
  position: string
}

/**
 * Build the registration call, or `null` when the inputs are unusable — fail-safe, so the install
 * flow never sends a malformed registration.
 *
 * `TYPE: 'B'` is a plain bot (not a supervisor/human-handover type): it posts and nothing more,
 * which is the whole of what we need and the least the portal has to trust.
 */
export function buildBotRegisterCall(bot: BotRegistration): B24Call | null {
  const code = (bot?.code ?? '').trim()
  const name = (bot?.name ?? '').trim()
  const position = (bot?.position ?? '').trim()
  if (!code || !name) return null
  return {
    method: 'imbot.v2.Bot.register',
    params: {
      fields: {
        code,
        type: 'bot',
        // `eventMode` задан ЯВНО, хотя `fetch` и так умолчание: боту, который только пишет,
        // колбэки не нужны, а молчание об этом читалось бы как «забыли».
        eventMode: 'fetch',
        properties: { name, workPosition: position }
      }
    }
  }
}

/**
 * Обновление профиля бота — ИМЕННО СЮДА едет аватар (#496).
 *
 * ⚠ Регистрация ИДЕМПОТЕНТНА и НИЧЕГО НЕ ПЕРЕЗАПИСЫВАЕТ: портал, у которого бот уже есть, не
 * подхватит из `Bot.register` ни новое имя, ни появившийся позже аватар. Значит профиль надо
 * толкать отдельным вызовом.
 *
 * ⚠ Аватар НЕ кладётся в регистрацию намеренно. Портал вправе отвергнуть картинку по своим
 * правилам (тип/размер), и внутри регистрации этот отказ утащил бы за собой ВЕСЬ вызов: бота нет
 * вовсе, и каждое сообщение снова подписано именем сотрудника. Бот с картинкой по умолчанию —
 * несравнимо меньшая беда, поэтому рискованное поле живёт в вызове, который и так «лучшие усилия».
 */
export function buildBotProfileUpdateCall(
  botId: string,
  bot: BotRegistration,
  avatarBase64?: string
): B24Call | null {
  const id = Number(botId)
  const name = (bot?.name ?? '').trim()
  if (!Number.isInteger(id) || id <= 0 || !name) return null
  const properties: Record<string, unknown> = { name, workPosition: (bot?.position ?? '').trim() }
  if (avatarBase64) properties.avatar = avatarBase64
  return { method: 'imbot.v2.Bot.update', params: { botId: id, fields: { properties } } }
}

/**
 * Отправка сообщения ботом.
 *
 * ⚠ Форма параметров camelCase и вложенный `fields` — ЗАМЕРЕНО на живом портале 2026-09-17.
 * Прежняя версия слала `BOT_ID`/`DIALOG_ID`/`MESSAGE` (форма УСТАРЕВШЕГО `imbot.message.add`), и
 * это же было причиной того, что бот не работал вовсе: `Bot.register` отвечал `BOT_CODE_REQUIRED`.
 *
 * `urlPreview: false` — текст несёт назначение платежа, которое пишет плательщик: вставленная
 * ссылка не должна разворачиваться в карточку.
 */
export function buildBotSendCall(
  botId: string,
  dialogId: string,
  message: string,
  attach?: unknown
): B24Call | null {
  const id = Number(botId)
  const dialog = (dialogId ?? '').trim()
  const text = (message ?? '').trim()
  if (!Number.isInteger(id) || id <= 0 || !dialog || !text) return null
  return {
    method: 'imbot.v2.Chat.Message.send',
    params: {
      botId: id,
      dialogId: dialog,
      fields: { message: text, urlPreview: false, ...(attach ? { attach } : {}) }
    }
  }
}

/**
 * Добавить бота в ГРУППОВОЙ чат (`chat<N>`), иначе писать в него он не может.
 *
 * ⚠ ЗАМЕРЕНО на живом портале 2026-09-17, и это не предположение: отправка в группу до вступления
 * отвечает `ACCESS_DENIED`, после `im.chat.user.add` — проходит. Симптом был полностью молчаливым:
 * каждое сообщение честно откатывалось на `im.message.add` и приходило с подписью сотрудника, то
 * есть бот выглядел «настроенным и не работающим».
 *
 * ⚠ Только для `chat<N>`. У ЛИЧНОГО диалога (голый id пользователя — так уходит ссылка на
 * подключение банка, #19) членства не существует, `CHAT_ID` там не о чем; и вступать не нужно —
 * замерено, что личное сообщение бот отправляет без всякого вступления.
 *
 * `HIDE_HISTORY: 'Y'` — бот вступает, чтобы писать, а не чтобы прочитать всё сказанное до него.
 */
export function buildChatJoinCall(dialogId: string, botId: string): B24Call | null {
  const m = /^chat(\d+)$/.exec((dialogId ?? '').trim())
  const chatId = Number(m?.[1])
  const id = Number(botId)
  if (!m || !Number.isInteger(chatId) || chatId <= 0 || !Number.isInteger(id) || id <= 0) return null
  return { method: 'im.chat.user.add', params: { CHAT_ID: chatId, USERS: [id], HIDE_HISTORY: 'Y' } }
}

export function extractBotId(resp: Record<string, unknown>): string | null {
  const raw = resp?.result
  if (raw === null || typeof raw !== 'object') return positiveId(raw)
  const box = raw as Record<string, unknown>
  // ЗАМЕРЕНО 2026-09-17: портал отвечает `result.users[0].id` (карточка бота как пользователя).
  // Документация соседнего продукта описывает `result.bot.id` — принимаем обе формы: цена лишней
  // ветки ноль, а промах тихий (без id бот считается недоступным и всё уходит подписью сотрудника).
  const users = box.users
  const first = Array.isArray(users) ? users[0] as Record<string, unknown> | undefined : undefined
  const bot = box.bot as Record<string, unknown> | undefined
  return positiveId(first?.id) ?? positiveId(bot?.id) ?? positiveId(box.id ?? box.ID)
}

/** Положительное целое из чего угодно, иначе `null`. */
function positiveId(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? `${n}` : null
}

/**
 * Errors that mean «this portal will never have a bot», as opposed to «try again later».
 *
 * The distinction is the whole point of the fallback: these are properties of the client's portal,
 * not transient faults. Retrying them on every message would burn REST budget forever and still
 * deliver nothing — so we stop asking and post as the token owner instead. A network blip is NOT in
 * this list: it must stay retryable, or one bad minute would demote a healthy portal until restart.
 *
 * ⚠ THE MISSING-SCOPE SHAPE IS THE ONE THAT MATTERS MOST, and it does not say «ACCESS_DENIED».
 * Every portal installed before this feature keeps its old grant without `imbot` until it
 * reinstalls — that is the COMMON case, not the exotic one. This repo already learned what that
 * failure looks like on the wire (#408, `classifyProvisionError`): the machine-readable
 * `insufficient_scope` is often absent and all the SDK surfaces is the human sentence «The request
 * requires HIGHER PRIVILEGES than provided by the … token». Omitting those two would classify the
 * entire existing install base as «transient» and re-attempt registration on every single chat
 * message, forever, against a rate limit this codebase otherwise guards carefully.
 */
const PERMANENT_BOT_ERRORS = [
  'access_denied',
  'access denied',
  'bot_limit_exceeded',
  'error_method_not_found',
  'invalid_credentials',
  // Missing `imbot` scope — see the warning above.
  'insufficient_scope',
  'higher privileges'
]

/** Whether an error from the bot API means «give up on the bot for this portal». */
export function isPermanentBotError(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? error ?? ''}`.toLowerCase()
  return PERMANENT_BOT_ERRORS.some(code => text.includes(code))
}
