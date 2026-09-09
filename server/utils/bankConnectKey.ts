// Подключение Альфы КЛЮЧОМ API (Password Grant, #488) — чистое ядро с инъекцией side-effects.
//
// ⚠ ЗАЧЕМ ЭТО ВМЕСТО OAUTH. У Code Grant цепочка refresh живёт РОВНО 10 часов от авторизации, и
// продлить её нельзя ничем: 19 обменов по полчаса проходят, 20-й на 10 ч 03 мин отвергается —
// замерено дважды, второй раз с успешным обращением к API на каждой ступени (граница не сдвинулась
// ни на минуту). То есть серверное приложение на Code Grant требует живого входа владельца счёта в
// интернет-банк дважды в сутки, навсегда. Ключ API бессрочен, и мёртвая цепочка переиздаётся сама.
//
// ⚠ «Password Grant» — название банка, и оно вводит в заблуждение: пароля здесь нет. В `username`
// едет ключ API, который владелец счёта генерирует у себя в кабинете Альфа Бизнес Онлайн под наш
// `client_id` и там же может заблокировать или отозвать. Логин от банка клиент нам не отдаёт.
//
// ⚠ ГЕЙТЫ ОБЩИЕ с authorize-путём (`gateConnectAdmin`): портал установлен → фрейм-токен доказан
// для ЭТОГО домена → человек администратор → у портала есть «моя компания» со счётом. Своя копия
// этой последовательности была бы вторым списком того, кому можно привязать банковские креды ко
// всему порталу.
//
// ⚠ КЛЮЧ НЕ ПОПАДАЕТ НИКУДА, КРОМЕ ШИФРОВАННОГО ПОЛЯ: ни в лог, ни в ответ, ни в текст ошибки.
// Он опаснее refresh-токена — тот ротируется при каждом обмене и утёкший стареет сам, а ключ годен,
// пока клиент его не отзовёт. Ответ банка на отказ В ЛОГ пишется, но прогнанным через
// `redactValues` по фактически отправленным ключу и секрету — см. ветку `catch` ниже.

import type { BankProviderId } from '../../app/types/statement'
import { buildPasswordGrantBody, parseTokenResponse, type AlfaOAuthConfig } from '../../app/utils/alfaOauth'
import { isPendingAccountKey, provisionalAccountKey } from '../../app/utils/bankAccountKey'
import { gateConnectAdmin, type ConnectStartDeps } from './bankConnectStart'
import { describeUpstreamError, redactValues } from './logSanitize'
import type { BankToken } from './bankTokenStore'

/** Ответ роута: 200 + что подключили, либо 4xx/5xx + причина. */
export interface ConnectKeyResult {
  status: number
  body: Record<string, unknown>
}

export interface ConnectKeyDeps extends Pick<ConnectStartDeps,
  'memberIdByDomain' | 'validateFrame' | 'myCompanyGate' | 'log'> {
  /** Конфигурация Альфы из env (`null` ⇒ провайдер не настроен на этом стенде). */
  config: (provider: BankProviderId) => AlfaOAuthConfig | null
  /** `client_secret` приложения. Пусто ⇒ обмен невозможен, отвечаем 503 fail-closed. */
  clientSecret: () => string
  /** POST формы на `${baseUrl}/token`. Бросок = банк не ответил или отверг. */
  exchange: (baseUrl: string, body: URLSearchParams) => Promise<unknown>
  /** Сохранить подключение (шифрование ключа и refresh — внутри стора). */
  save: (token: BankToken) => Promise<void>
}

export interface ConnectKeyInput {
  accessToken: string
  domain: string
  provider: BankProviderId
  /** Ключ API, вставленный администратором. */
  apiKey: string
  /** Идентификатор гранта — тот же смысл, что у `state.nonce` в authorize-пути (#23). */
  nonce: string
  nowMs: number
}

/**
 * ⚠ Форма ключа НЕ проверяется маской. Банк её не документирует, а на скриншоте кабинета
 * идентификатор ключа — 64 знака; выдумай мы правило, оно однажды отвергло бы валидный ключ, и
 * человек искал бы ошибку у себя. Проверяем только непустоту и потолок длины (защита от того, что
 * в поле вставили файл), а годность решает сам банк — его ответ и есть проверка.
 */
const MAX_API_KEY_CHARS = 4096

/** Подключить банк по ключу API: обменять ключ на пару токенов и сохранить подключение. */
export async function handleBankConnectKey(
  deps: ConnectKeyDeps, input: ConnectKeyInput
): Promise<ConnectKeyResult> {
  const { accessToken, domain, provider, apiKey, nonce, nowMs } = input

  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  const key = apiKey.trim()
  if (!key) return { status: 400, body: { error: 'ключ API обязателен' } }
  if (key.length > MAX_API_KEY_CHARS) return { status: 400, body: { error: 'ключ API слишком длинный' } }

  // ⚠ Провайдер проверяем ДО гейтов: на «этот банк так не подключается» портал спрашивать незачем.
  const config = deps.config(provider)
  if (!config) {
    return { status: 400, body: { error: `provider ${provider} not available for key connect` } }
  }
  const clientSecret = deps.clientSecret()
  if (!clientSecret) {
    return { status: 503, body: { error: 'connect unavailable (no client secret configured)' } }
  }

  const gate = await gateConnectAdmin(deps, { accessToken, domain })
  if (!gate.ok) return gate.res

  let tokens
  try {
    const raw = await deps.exchange(config.baseUrl, buildPasswordGrantBody(config, key, clientSecret))
    tokens = parseTokenResponse(raw as Record<string, unknown>)
  } catch (e) {
    // ⚠ Текст банка НАРУЖУ не отдаём, но В ЛОГ отдаём — РЕДАКТИРОВАННЫМ. Первая редакция писала
    // только имя класса исключения (`FetchError`), и это оказалось отказом, который невозможно
    // разобрать: на живом подключении 2026-09-09 админ получил «банк не принял ключ API» и не мог
    // узнать, дело в ключе, в `client_id`, в адресе (песочница вместо боевого) или в сети — а
    // разбираются эти четыре причины в четырёх разных местах. Осторожность, доведённая до
    // неотличимости причин, перестаёт быть осторожностью.
    //
    // ⚠ Двойная редакция обязательна, и шаблонов ОДНИХ не хватает: `redactCredentials` ловит
    // ФОРМУ (`client_secret=…`, JWT), а банк волен процитировать голое ЗНАЧЕНИЕ ключа — оно едет
    // в `username=`, которого в шаблонах нет. `redactValues` вырезает ровно те две строки, что мы
    // только что отправили, поэтому промах шаблона ничего не открывает.
    deps.log?.(`alfa password grant failed: ${redactValues(describeUpstreamError(e), [key, clientSecret])}`)
    return {
      status: 502,
      body: { error: 'банк не принял ключ API. Проверьте, что ключ скопирован целиком, действителен и выпущен под наш Client ID' }
    }
  }

  // ⚠ Счёт НЕ выбирается здесь (решение владельца 2026-09-09): подключение приземляется под
  // временным ключом ровно так же, как после возврата из банка, и номер выбирается прежним экраном.
  const accountKey = provisionalAccountKey(nonce)
  // ⚠ Проверяем предикатом ВРЕМЕННОГО ключа, а не маской номера счёта: временный ключ намеренно
  // несёт префикс `~pending:`, невозможный в настоящем номере, и маска номера отвергла бы его
  // всегда. Первая редакция ошиблась ровно так, и поймал это тест.
  if (!isPendingAccountKey(accountKey)) {
    return { status: 500, body: { error: 'internal: bad provisional account key' } }
  }

  await deps.save({
    memberId: gate.memberId,
    provider,
    accountKey,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: nowMs + tokens.expiresIn * 1000,
    // Согласий у Альфы нет вовсе — 0 значит «неизвестно», а не «истекло» (#503).
    consentExpiresAt: 0,
    grantId: nonce,
    apiKey: key
  })

  return { status: 200, body: { connected: true, provider, accountKey } }
}
