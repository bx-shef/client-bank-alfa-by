// Pure core for the app's PULL-CHANNEL events (pattern ported from bitrix24/b24-ai-starter's
// app-options slider: after a save it fires `pull.application.event.add` with COMMAND `reload.options`,
// and every open instance subscribed to the app's pull channel reloads its settings). Here we keep the
// SHAPE of that pull event pure + tested; the frame binding (send/subscribe) lives in useSettingsSync.

/** The pull command other instances listen for to re-read portal settings. */
export const SETTINGS_RELOAD_COMMAND = 'reload.options'

export interface PullEventParams {
  COMMAND: string
  PARAMS: Record<string, unknown>
  MODULE_ID: string
}

/**
 * Params for `pull.application.event.add` telling other open instances to reload settings.
 * `moduleId` = the application's code as registered on the portal (the pull channel key).
 */
export function buildSettingsReloadEvent(moduleId: string, from = 'app.options'): PullEventParams {
  return { COMMAND: SETTINGS_RELOAD_COMMAND, PARAMS: { from }, MODULE_ID: moduleId }
}

/** Whether an inbound pull command means "reload settings". */
export function isSettingsReloadCommand(command: string | undefined | null): boolean {
  return command === SETTINGS_RELOAD_COMMAND
}

/**
 * Команда «банк подключился» (#19): её шлёт СЕРВЕР, когда владелец счёта ввёл ключ API на своём
 * экране, а слушает открытая страница настроек администратора.
 *
 * ⚠ Отдельная команда, а не `reload.options`: реакция другая. Там перечитывают НАСТРОЙКИ портала,
 * здесь — списки подключений и сверку счетов. Слепить их в одну значило бы, что каждое сохранение
 * настроек дёргает банк за списком счетов, а каждое подключение перечитывает форму, которую
 * администратор, возможно, прямо сейчас правит.
 */
export const BANK_CONNECTED_COMMAND = 'bank.connected'

/** Params for `pull.application.event.add` telling an open admin screen that a bank connection
 *  appeared. `provider` — чей именно, чтобы экран мог не дёргать чужие списки. */
export function buildBankConnectedEvent(moduleId: string, provider: string): PullEventParams {
  return { COMMAND: BANK_CONNECTED_COMMAND, PARAMS: { provider }, MODULE_ID: moduleId }
}
