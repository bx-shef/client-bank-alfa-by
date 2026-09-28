// Send a chat message AS THE APP, falling back to «as the token owner» when the portal cannot host
// a bot (#496).
//
// WHY THE FALLBACK IS NOT OPTIONAL. Two documented refusals decide whether this works on a given
// portal, and neither is our bug: `ACCESS_DENIED` (the REST API is a paid-plan feature) and
// `BOT_LIMIT_EXCEEDED`. The error chat is the ONLY channel that reaches the accountant — going
// silent there would trade a cosmetic problem (message signed by a colleague) for the actual
// failure this whole product exists to prevent (nobody learns the payment did not land). So on any
// bot failure we post the same text the old way.
//
// ⚠ SCOPE IS A RE-CONSENT. `imbot` was added to B24_REQUIRED_SCOPES, and a portal installed before
// that keeps its old grant until someone reinstalls the app. Such portals will fail registration
// forever — which is exactly the case the fallback covers, and the reason it must be permanent
// rather than a launch-week crutch.

import {
  buildBotProfileUpdateCall, buildBotRegisterCall, buildBotSendCall, buildChatJoinCall,
  extractBotId, isPermanentBotError
} from '../../app/utils/b24BotRegister'
import { hasAttachBlocks, type ChatAttach } from '../../app/utils/chatAttach'
import { BOT_AVATAR_BASE64 } from './botAvatar'
import { B24_CHAT_BOT } from '../../app/config/b24'
import type { RestCall } from './companyLookup'
import { describeUpstreamError } from './logSanitize'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('chat')

/** REST method that posts a message as a bot. ⚠ `imbot.message.add` is the DEPRECATED generation. */
export const BOT_MESSAGE_METHOD = 'imbot.v2.Chat.Message.send'

/**
 * Per-portal bot id, resolved once per process. `null` means «this portal will not have a bot» —
 * cached just as deliberately as a positive answer, because the alternative is re-attempting a
 * registration the portal has already refused on every single message, forever.
 *
 * In memory, not in the database: a portal that changes plan gets its bot on the next restart, and
 * that is a fair price for keeping a schema out of a purely operational cache.
 */
const botIdByPortal = new Map<string, string | null>()

/**
 * «Боту не дали писать в этот чат» — ровно тот отказ, который лечится вступлением.
 *
 * ⚠ Тот же код `ACCESS_DENIED` означает и «REST только на коммерческих тарифах», но тот приходит на
 * РЕГИСТРАЦИЮ и до отправки дело не доходит вовсе. Здесь мы уже в ветке отправки существующим
 * ботом, поэтому единственная цена ошибочного вывода — один отвергнутый `im.chat.user.add`, после
 * которого мы всё равно откатываемся на прежний маршрут.
 */
function isAccessDenied(error: unknown): boolean {
  const code = `${(error as { code?: unknown })?.code ?? ''}`.toUpperCase()
  if (code) return code === 'ACCESS_DENIED'
  // Конверт без машинного кода — смотрим текст: у SDK он иногда единственное, что доезжает.
  return `${(error as Error)?.message ?? ''}`.toLowerCase().includes('access_denied')
}

/**
 * Когда последний раз сказали в лог об отказе бота: ключ `<портал>|<вид>` → момент, мс.
 *
 * ⚠ Заведено по жалобе владельца 2026-09-28: «бота вообще не вижу», сообщения и дела — от имени
 * установившего. Три пути отказа молчали НАВСЕГДА: временная ошибка регистрации, ответ регистрации
 * без id и отказ отправки без вложения. Снаружи всё это неотличимо от «бот работает», а причину
 * нельзя было прочитать нигде.
 * ⚠ НЕ чаще раза в час на портал и вид, а не на каждое сообщение: сообщений в чат на живом портале
 * сотни в день, и безусловная строка забила бы лог повтором одной и той же причины.
 * ⚠ Но и НЕ «раз за жизнь процесса» (так было в первой редакции, находка ревью): `make chat-log`
 * читает окно в несколько часов, а процесс живёт сутками. Единственная строка давно уехала бы за
 * окно, и отчёт уверенно печатал бы «ни одного отказа бота», пока каждое сообщение уходит от
 * сотрудника. Раз в час — строка есть в любом окне, в котором сообщения вообще отправлялись.
 */
const reported = new Map<string, number>()

/** Как часто повторять строку об одном и том же отказе бота на одном портале. */
export const BOT_FALLBACK_REPORT_INTERVAL_MS = 60 * 60 * 1000

/** Почему бот на портале недоступен НАВСЕГДА (до рестарта): причина кэшированного отказа. Без неё
 *  повтор строки на закэшированном пути нечем было бы наполнить. */
const refusalByPortal = new Map<string, string>()

type BotFallbackKind = 'register' | 'register-shape' | 'send' | 'unavailable'

const FALLBACK_WHAT: Record<BotFallbackKind, string> = {
  'register': 'регистрация бота не удалась',
  'register-shape': 'портал ответил на регистрацию бота без id',
  'send': 'бот не принял сообщение',
  'unavailable': 'бот недоступен на портале'
}

/** Сказать в лог о причине, по которой сообщение уйдёт НЕ от бота, — не чаще раза в час на портал
 *  и вид отказа. */
export function reportBotFallback(memberId: string, kind: BotFallbackKind, reason: string): void {
  const key = `${memberId}|${kind}`
  const now = Date.now()
  const last = reported.get(key)
  if (last !== undefined && now - last < BOT_FALLBACK_REPORT_INTERVAL_MS) return
  reported.set(key, now)
  log.info(`${FALLBACK_WHAT[kind]}, сообщение уйдёт от имени владельца токена: ${reason}`)
}

/** Exposed for tests — a module-level cache would otherwise leak between cases. */
export function resetBotCache(): void {
  botIdByPortal.clear()
  reported.clear()
  refusalByPortal.clear()
}

/** Forget one portal — called on ONAPPUNINSTALL, where every other per-portal store is purged too.
 *  Not a leak worth fearing (the key only ever arrives through an authenticated path, so growth is
 *  bounded by portals that really installed us), but leaving one store out of the uninstall sweep is
 *  how a store quietly stops being swept at all. */
export function forgetBot(memberId: string): void {
  botIdByPortal.delete(memberId)
  refusalByPortal.delete(memberId)
  for (const key of reported.keys()) if (key.startsWith(`${memberId}|`)) reported.delete(key)
}

/**
 * Resolve this portal's bot id, registering it if needed.
 *
 * Registration is idempotent by `code`, so calling it here is not a duplicate of the one on
 * `/install`: that one makes the bot exist promptly, this one covers portals installed BEFORE the
 * bot existed, and portals whose install-time registration failed transiently.
 *
 * ⚠ A transient failure is NOT cached. Only a documented permanent refusal demotes the portal;
 * a network blip must leave it eligible, or one bad minute would sign every message with an
 * employee's name until the next restart.
 */
export async function resolveBotId(memberId: string, call: RestCall): Promise<string | null> {
  const cached = botIdByPortal.get(memberId)
  if (cached !== undefined) {
    // ⚠ Закэшированный отказ тоже напоминает о себе (не чаще раза в час): иначе постоянная причина
    // прозвучала бы в логе один раз при первом сообщении и дальше не нашлась бы ни в каком окне.
    if (cached === null) reportBotFallback(memberId, 'unavailable', refusalByPortal.get(memberId) ?? 'без описания')
    return cached
  }

  const registration = buildBotRegisterCall(B24_CHAT_BOT)
  if (!registration) return null // unreachable with the shipped constant; fail-safe anyway

  try {
    const resp = await call(registration.method, registration.params)
    const id = extractBotId(resp)
    // ⚠ Кэшируем ТОЛЬКО положительный ответ. Непонятный, но не бросивший — это не «у портала
    // никогда не будет бота», а «мы не разобрали форму»: имена полей конверта мы угадываем, и один
    // нетипичный ответ навсегда (до рестарта) отключал бы бота на портале, не оставив ни симптома.
    // Отрицательный вывод делает только ветка `catch` ниже, и только по документированному отказу.
    if (id) {
      botIdByPortal.set(memberId, id)
      await pushBotProfile(id, call)
    } else {
      reportBotFallback(memberId, 'register-shape', JSON.stringify(resp?.result ?? null).slice(0, 200))
    }
    return id
  } catch (error) {
    if (isPermanentBotError(error)) {
      // «Не бывает» — запоминаем, чтобы не спрашивать на каждом сообщении. Сказать об этом ВСЛУХ:
      // молчание здесь неотличимо от «бот работает», а самый частый повод попасть сюда — старая
      // установка без скоупа `imbot`, которую чинит переустановка приложения.
      const reason = describeUpstreamError(error)
      botIdByPortal.set(memberId, null)
      refusalByPortal.set(memberId, reason)
      reportBotFallback(memberId, 'unavailable', reason)
      return null
    }
    // Транзиентная ошибка: не кэшируем, следующая попытка спросит заново. Но и не молчим (см. `reported`).
    reportBotFallback(memberId, 'register', describeUpstreamError(error))
    return null
  }
}

/**
 * Толкнуть на портал имя, должность и АВАТАР бота (#496).
 *
 * ⚠ Отдельным вызовом, потому что регистрация идемпотентна и ничего не перезаписывает: портал, у
 * которого бот уже есть, иначе навсегда остался бы с прежним профилем и без картинки.
 *
 * ⚠ ЛУЧШИЕ УСИЛИЯ И НИКОГДА НЕ БРОСАЕТ: это оформление, а не доставка. Но отказ ПОВТОРЯЕТСЯ БЕЗ
 * АВАТАРА — имя и картинка едут одним вызовом, и портал, отвергший картинку, не применил бы
 * НИЧЕГО, то есть бот остался бы с именем по умолчанию. Повтор безусловный, а не по кодам ошибок
 * картинки: исход «потеряли имя» одинаков при любом отказе первого вызова, а лишний вызов раз на
 * портал на процесс не стоит ничего.
 */
export async function pushBotProfile(botId: string, call: RestCall): Promise<void> {
  const withAvatar = buildBotProfileUpdateCall(botId, B24_CHAT_BOT, BOT_AVATAR_BASE64)
  if (!withAvatar) return
  try {
    await call(withAvatar.method, withAvatar.params)
    return
  } catch (error) {
    log.info(`профиль бота не применён, повторяю без аватара: ${(error as Error)?.message ?? 'без описания'}`)
  }
  const plain = buildBotProfileUpdateCall(botId, B24_CHAT_BOT)
  if (!plain) return
  try {
    await call(plain.method, plain.params)
  } catch (error) {
    log.info(`профиль бота не применён и без аватара: ${(error as Error)?.message ?? 'без описания'}`)
  }
}

/**
 * Post `text` to `dialogId` as the bot; returns the message id, or `null` when the bot route was
 * unavailable and the caller should fall back.
 *
 * ⚠ ЭТО МЕТОД ВТОРОГО ПОКОЛЕНИЯ, И ФОРМА У НЕГО СВОЯ. Он принимает `botId`/`dialogId`, а само
 * содержимое — во ВЛОЖЕННОМ `fields` со строчными именами (`message`, `attach`, `urlPreview`).
 * Первая редакция слала сюда форму `im.message.add` (`BOT_ID`/`DIALOG_ID`/`MESSAGE`/`ATTACH`
 * верхним уровнем), и это был отказ ХУДШЕГО вида: текст доходил (портал разобрал его по
 * совместимости), а вложение и запрет превью — нет, молча. Снаружи «картинки не работают».
 *
 * ⚠ `urlPreview: false` — по той же причине, что и на втором маршруте: в тексте бывает содержимое,
 * которое пишет плательщик, и вставленная ссылка не должна разворачиваться в карточку.
 *
 * ⚠ `attach` ОПУСКАЕТСЯ, а не шлётся пустым, когда прикладывать нечего: портал проверяет коллекцию
 * блоков и на негодную форму отвечает `ATTACH_ERROR`, а пустая — ровно такая. Переживут ли картинки
 * дорогу — забота вызывающего (`postChatMessage` повторяет без них); здесь задача одна: не
 * выдумывать вложение, которого никто не просил.
 */
export async function sendAsBot(
  botId: string,
  dialogId: string,
  text: string,
  call: RestCall,
  attach?: ChatAttach | null
): Promise<string | null> {
  const send = buildBotSendCall(botId, dialogId, text, hasAttachBlocks(attach) ? attach : null)
  if (!send) return null
  try {
    return extractBotMessageId(await call(send.method, send.params))
  } catch (error) {
    // ⚠ ЕДИНСТВЕННАЯ ветка, где отказ ЛЕЧИТСЯ, а не откатывается: бот пишет только в тот групповой
    // чат, участником которого он является. Замерено на живом портале — до вступления
    // `ACCESS_DENIED`, после `im.chat.user.add` сообщение проходит.
    //
    // ⚠ Вступаем ПО ОТКАЗУ, а не заранее на каждом сообщении: вступление нужно один раз на чат за
    // всю жизнь портала, а проактивный вызов стоил бы лишнего REST на КАЖДОЕ сообщение — на выписке
    // в сотни строк это сотни вызовов из общего лимита портала ради состояния, которое уже верное.
    // ⚠ Вступаем ТОЛЬКО на отказ доступа, а не на любой. Поймано собственным тестом: отказ портала
    // по ВЛОЖЕНИЮ (`ATTACH_ERROR`, #19) шёл сюда же, и мы добавляли бота в чат и слали повтор — два
    // лишних вызова в портал на каждую картинку, которую он не принял, и всё это до отката, который
    // и есть лекарство от той беды. Признак — машинный код ответа, а не текст описания.
    if (!isAccessDenied(error)) throw error
    const join = buildChatJoinCall(dialogId, botId)
    if (!join) throw error
    await call(join.method, join.params)
    return extractBotMessageId(await call(send.method, send.params))
  }
}

/**
 * Read the message id out of an `imbot.v2.Chat.Message.send` reply.
 *
 * ⚠ Lives HERE, next to the method it parses, and NOT next to `im.message.add`'s extractor. The two
 * envelopes genuinely differ — `im.message.add` answers a bare scalar, the v2 methods wrap their
 * payload — and a single «find an id somewhere» helper would lose the envelope check on the scalar
 * side, where a wrong shape is silent.
 *
 * ⚠ The field names are INFERRED, not confirmed live. That is survivable only because `postChatMessage`
 * treats «no exception» as delivery: a shape we fail to read costs us the id in a log line, not a
 * duplicated message. Do not reintroduce a fallback keyed on this returning null.
 */
export function extractBotMessageId(resp: Record<string, unknown>): string | null {
  const raw = resp?.result
  const value = raw !== null && typeof raw === 'object'
    ? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).ID ?? (raw as Record<string, unknown>).messageId
    : raw
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? `${n}` : null
}
