// Экран ВЛАДЕЛЬЦА СЧЁТА для ввода ключа API (#19) — чистые ядра двух маршрутов: «годна ли ссылка»
// и «принять ключ». DI, без сети и БД.
//
// ⚠ ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН, А НЕ «пришлите ключ администратору». Ключ API бессрочен и не
// ротируется: присланный в чат, он остаётся в истории портала навсегда, и отозвать его можно
// только в кабинете банка. Здесь ключ вводит тот, кто его выпустил, прямо в приложении — админ его
// не видит вовсе, в чате его нет, а в нашей базе он лежит шифрованным.
//
// ⚠ АВТОРИЗАЦИЯ — ТРИ УСЛОВИЯ, и ни одного достаточного в одиночку:
//   1) подпись гранта (наш HMAC, срок внутри);
//   2) портал фрейм-токена совпадает с порталом гранта — иначе ссылка, пересланная в другой
//      Bitrix24, где у человека тоже есть фрейм-токен, подключала бы банк не тому порталу;
//   3) `userId` фрейм-токена совпадает с тем, кому грант выдан — иначе любой сотрудник, которому
//      переслали сообщение, подключил бы СВОЙ банковский ключ к компании.
// Грант не секрет (он едет в чате), поэтому именно (2) и (3) делают его безопасным.
//
// ⚠ АДМИН-ГЕЙТА ЗДЕСЬ НЕТ, И ЭТО НЕ ПОСЛАБЛЕНИЕ. Экран для того и заведён, чтобы им пользовался
// НЕ администратор. Право на действие даёт не должность, а то, что администратор явно выбрал этого
// человека и подписал грант — то есть решение всё равно принимает админ, просто заранее.

import { ALFA_CLIENT_ID_MISSING, exchangeAndSaveKey, precheckKeyConnect, type ConnectKeyDeps, type ConnectKeyResult } from './bankConnectKey'
import { verifyKeyGrant, type BankKeyGrant } from './bankKeyGrant'
import type { BankProviderId } from '../../app/types/statement'

export interface KeySubmitDeps extends Pick<ConnectKeyDeps,
  'memberIdByDomain' | 'validateFrame' | 'config' | 'clientSecret' | 'exchange' | 'save' | 'log'> {
  /** HMAC-секрет гранта (тот же операторский SESSION_SECRET). Пусто ⇒ fail-closed. */
  secret: string
  /** Наш `client_id` для кабинета банка — показываем на экране рядом с полем ключа. */
  clientId: () => string
  /** Сказать открытым экранам портала, что подключение появилось (#19). BEST-EFFORT и НИКОГДА не
   *  влияет на исход: подключение уже создано, а живое обновление — удобство. */
  notifyConnected?: (memberId: string, provider: BankProviderId) => Promise<void>
}

export interface KeyRequestInput {
  accessToken: string
  domain: string
  /** Подписанный грант из `params[t]` внутренней ссылки. */
  token: string
  nowMs: number
}

type GateOk = { ok: true, grant: BankKeyGrant }
type GateFail = { ok: false, res: ConnectKeyResult }

/**
 * Общий гейт обоих маршрутов. Отдельная функция, потому что порядок проверок — часть защиты:
 * подпись раньше похода в портал (негодная ссылка не должна стоить REST-вызова), портал раньше
 * личности (сравнивать `userId` с чужим порталом бессмысленно).
 *
 * ⚠ Все отказы отвечают ОДНИМ текстом и кодом 403. Разные («грант просрочен» / «это не ваша
 * ссылка» / «портал не тот») подсказывали бы, какое из условий не сошлось, а человеку на этом
 * экране полезен ровно один ответ: попросите администратора прислать новую ссылку.
 */
async function gateKeyGrant(deps: KeySubmitDeps, input: KeyRequestInput): Promise<GateOk | GateFail> {
  const bad: GateFail = {
    ok: false,
    res: { status: 403, body: { error: 'ссылка недействительна или устарела — попросите администратора прислать новую' } }
  }
  const { accessToken, domain, token, nowMs } = input
  if (!accessToken || !domain) {
    return { ok: false, res: { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } } }
  }
  const grant = verifyKeyGrant(token, deps.secret, nowMs)
  if (!grant) return bad

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { ok: false, res: { status: 409, body: { error: 'portal not installed (no key)' } } }
  if (memberId !== grant.memberId) return bad

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { ok: false, res: { status: 403, body: { error: 'invalid frame token for this portal' } } }
  }
  if (!frame.userId || frame.userId !== grant.userId) return bad

  return { ok: true, grant }
}

/**
 * «Годна ли ссылка и что показывать»: провайдер и наш `client_id` для кабинета банка.
 *
 * ⚠ Отдельный маршрут, а не «показать форму и узнать при отправке»: человек уходит в банк
 * выпускать ключ и возвращается с ним. Узнать, что ссылка протухла, ПОСЛЕ этой работы — худший
 * момент из возможных.
 */
export async function handleKeyRequestInfo(deps: KeySubmitDeps, input: KeyRequestInput): Promise<ConnectKeyResult> {
  const gate = await gateKeyGrant(deps, input)
  if (!gate.ok) return gate.res
  const clientId = deps.clientId().trim()
  if (!clientId) {
    // То же, что у приглашения: без `client_id` человек упрётся в обязательное поле кабинета.
    return { status: 503, body: { error: ALFA_CLIENT_ID_MISSING } }
  }
  return { status: 200, body: { ok: true, provider: gate.grant.provider, clientId } }
}

export interface KeySubmitInput extends KeyRequestInput {
  apiKey: string
  /** Идентификатор гранта подключения — тот же смысл, что у `nonce` админского пути. */
  nonce: string
}

/** Принять ключ от владельца счёта и создать подключение. */
export async function handleSubmitBankKey(deps: KeySubmitDeps, input: KeySubmitInput): Promise<ConnectKeyResult> {
  // ⚠ Форму ключа проверяем ДО гейта: она не требует ни портала, ни сети, а пустое поле — самый
  // частый исход (человек нажал «Подключить», не вставив ключ).
  const provider: BankProviderId = 'alfa-by'
  const pre = precheckKeyConnect(deps, provider, input.apiKey)
  if (pre) return pre

  const gate = await gateKeyGrant(deps, input)
  if (!gate.ok) return gate.res
  // ⚠ Провайдер берём ИЗ ГРАНТА, а не из тела запроса: тело пишет клиент, грант подписан нами.
  if (gate.grant.provider !== provider) {
    return { status: 400, body: { error: `provider ${gate.grant.provider} not available for key connect` } }
  }

  const res = await exchangeAndSaveKey(deps, {
    memberId: gate.grant.memberId,
    provider,
    apiKey: input.apiKey,
    nonce: input.nonce,
    nowMs: input.nowMs
  })

  // ⚠ Только на УДАЧЕ и только после сохранения: сообщение «банк подключён» открытому экрану
  // администратора — это утверждение о состоянии, и послать его раньше записи значило бы показать
  // ему подключение, которого нет. Отказ уведомления проглатываем — подключение уже создано, и
  // ронять из-за него ответ владельцу счёта значило бы просить его ввести ключ второй раз.
  if (res.status === 200 && deps.notifyConnected) {
    try {
      await deps.notifyConnected(gate.grant.memberId, provider)
    } catch (e) {
      deps.log?.(`bank key: connected notice not delivered: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }
  return res
}
