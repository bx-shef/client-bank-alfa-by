// Кому передавать подключение банка — сотрудник портала, у которого есть доступ к интернет-банку
// (#19). Чистое ядро: ключ хранения, форма записи, разбор.
//
// ⚠ ЗАЧЕМ ВООБЩЕ ОТДЕЛЬНЫЙ АДРЕСАТ. Подключение банка — админское действие, а пароль от
// интернет-банка знает не администратор, а владелец счёта (обычно бухгалтер). До сих пор
// единственным способом передать ссылку было скопировать её из поля и переслать мессенджером
// вручную — то есть самый частый сценарий подключения не поддерживался вовсе.
//
// ⚠ ХРАНИТСЯ ПОД СВОИМ КЛЮЧОМ `app.option`, а не внутри `PortalSettings` (`SETTINGS_KEY`), и это
// не вкусовщина. Большой блоб настроек редактируется формой с ЯВНЫМИ Save/Cancel: админ открывает
// экран, правит исключения, а потом жмёт «Передать бухгалтеру». Запиши мы адресата в тот же блоб
// с сервера — форма, сохранённая следом, затёрла бы его СВОЕЙ копией, прочитанной до записи, и
// адресат пропал бы молча. Отдельный ключ снимает гонку по построению: `app.option.set` пишет
// ровно переданные ключи.
//
// ⚠ Имя хранится как УДОБСТВО интерфейса, а адресуемся мы `userId`: имя в портале меняется
// (замужество, перевод, правка карточки), и сравнивать по нему нельзя. Пустое/кривое имя — не
// ошибка, просто подпись станет «сотрудник #12».

/** Ключ `app.option`, под которым живёт адресат. Свой, не `SETTINGS_KEY` — см. шапку. */
export const BANK_CONTACT_KEY = 'cb_bank_contact_v1'

/** Максимум для имени — та же логика, что у прочих строк настроек: хранить чужой ввод без потолка
 *  незачем, а `app.option` общий на приложение. */
const MAX_NAME = 120

export interface BankContact {
  /** Идентификатор сотрудника портала. Он же `DIALOG_ID` личного чата, куда уйдёт сообщение. */
  userId: string
  /** Имя на момент выбора — только для подписи в интерфейсе. */
  name?: string
}

/**
 * Годится ли значение как идентификатор сотрудника портала.
 *
 * ⚠ Строгая маска, а не `Number(v) > 0`: значение приходит из диалога портала, то есть извне, и
 * едет в `DIALOG_ID` личного чата. `'12abc'` у `Number` даёт `NaN`, но `'12 '` прошло бы — и
 * сообщение ушло бы не туда либо никуда, без единого симптома.
 */
export function isValidPortalUserId(v: unknown): v is string {
  return typeof v === 'string' && /^[1-9][0-9]{0,17}$/.test(v)
}

/** Разобрать хранимое значение. Мусор ⇒ `null` — «адресата нет», а не полузаполненная запись. */
export function parseBankContact(raw: unknown): BankContact | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const userId = typeof o.userId === 'string' ? o.userId.trim() : ''
  if (!isValidPortalUserId(userId)) return null
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_NAME) : ''
  return name ? { userId, name } : { userId }
}

/** Сериализовать для `app.option.set`. Возвращает `null`, если писать нечего. */
export function serializeBankContact(contact: BankContact | null): string | null {
  if (!contact || !isValidPortalUserId(contact.userId)) return null
  const name = (contact.name ?? '').trim().slice(0, MAX_NAME)
  return JSON.stringify(name ? { userId: contact.userId, name } : { userId: contact.userId })
}

/**
 * Идентификатор личного чата с адресатом для `parent.imOpenMessenger` — ЧИСЛОМ, как просит SDK
 * (документация метода: `dialogId` это `userId` либо `chatXXX`; без параметра открывается список
 * чатов — ровно то, на что пожаловался владелец 2026-09-17).
 *
 * ⚠ Проверка на БЕЗОПАСНОЕ целое — не формальность: маска допускает 18 цифр, а `Number` за
 * пределами 2^53 округляет, то есть открыл бы переписку с ДРУГИМ сотрудником — и выглядело бы это
 * как исправно работающая кнопка. Не влезло ⇒ `null`, и вызывающий честно говорит, что не смог.
 */
export function contactDialogId(contact: BankContact | null): number | null {
  if (!contact || !isValidPortalUserId(contact.userId)) return null
  const n = Number(contact.userId)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Подпись адресата для интерфейса и логов: имя, иначе честное «сотрудник #id». */
export function contactLabel(contact: BankContact | null): string {
  if (!contact) return ''
  return contact.name?.trim() || `сотрудник #${contact.userId}`
}
