// Чтение запомненного адресата подключения банка (#19) — чистое ядро с DI, маршрут поверх него
// тонкий. Вынесено из роута по той же причине, что и остальные хендлеры: гейт админа и разбор
// хранимого значения должны проверяться вызовом, а не чтением `defineEventHandler` глазами.

import { BANK_CONTACT_KEY, parseBankContact, type BankContact } from '../../app/utils/bankContact'
import { handleReadSetting, verifyFrameAdmin, type HandlerResult, type SettingsIO } from './settingsHandler'

/**
 * Кому в прошлый раз передавали подключение банка.
 *
 * ⚠ Админский, как и весь `/api/bank/*`: значение называет конкретного сотрудника портала, и
 * читать его вправе тот же, кто вправе банк подключать. Отказ чтения токена ⇒ 502 (fail-closed),
 * не-админ ⇒ 403.
 *
 * ⚠ Мусор в хранимом значении — это `contact: null`, а не 502: «запомненного адресата нет» и
 * «сервер сломался» лечатся по-разному, а внешне обе ветки дают пустую подпись.
 */
export async function handleReadBankContact(
  io: SettingsIO, accessToken: string, domain: string
): Promise<HandlerResult & { body: { contact?: BankContact | null, error?: string } }> {
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  const admin = await verifyFrameAdmin(io, accessToken, domain)
  if (!admin.ok) return { status: admin.status ?? 502, body: { error: 'upstream error' } }
  if (!admin.isAdmin) return { status: 403, body: { error: 'bank contact requires a portal administrator' } }

  const res = await handleReadSetting(io, accessToken, domain, BANK_CONTACT_KEY)
  if (res.status !== 200) return { status: res.status, body: { error: 'upstream error' } }
  return { status: 200, body: { contact: parseBankContact((res.body as { value?: unknown }).value) } }
}
