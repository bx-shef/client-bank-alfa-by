// Проводка запроса «какие счета покрывает согласие» к живому банку — ОДНА на всех (#615).
//
// ⚠ Вынесено из роута сверки счетов (`server/api/bank/matrix.get.ts`), когда тот же список
// понадобился фоновому подтверждению счетов. Двух копий тут быть не должно: выбор заголовков
// зависит от банка (#20/#461), и разойдись копии — счета одного банка молча перестали бы
// подтверждаться, а выглядело бы это как «банк их не отдаёт», то есть указывало не на ту сторону.
//
// ⚠ ОЖИДАНИЕ ЛОКА — ПАРАМЕТР, а не константа внутри, хотя копий и одна. Вызывающих двое, и
// правильное значение у них РАЗНОЕ: на экране сверки человек, и ждать ему нельзя (#539), а
// фоновому подтверждению ждать долго правильно — оно никого не задерживает. Зашей мы сюда
// человеческое значение, фоновый проход бросал бы работу при каждом плановом продлении токена;
// зашей машинное — админ десять секунд держал бы соединение из пула ради шанса выиграть у
// держателя, который сам ограничен пятнадцатью.

import { accountsRequestHeaders, type BankSideListDeps } from './bankAccountList'
import { bankApiConfig } from './bankFetch'
import { ensureBankToken } from './ensureBankToken'
import { listBankTokensForPortal } from './bankTokenStore'
import { randomUUID } from 'node:crypto'
import type { BankProviderId } from '../../app/types/statement'
import { dbQuery } from '../db/client'

/**
 * GET a JSON resource with the provider's own headers. The auth header never appears in the thrown
 * message — only the status and the upstream text, which the caller sanitises.
 *
 * ⚠ ЗАГОЛОВКИ ЗАВИСЯТ ОТ БАНКА (#20). Приор проверяет заголовок взаимодействия FAPI на ЛЮБОМ вызове и
 * делает это ДО тела (#461): запрос с одним `Authorization` он отвергает. Прежняя версия слала
 * ровно его, и счета Приора в сверке не появлялись НИКОГДА — а поскольку отказ здесь fail-soft по
 * провайдеру, выглядело это как «банк их не отдаёт», то есть указывало не на ту сторону.
 * ⚠ Сам ВЫБОР заголовков — в чистом `accountsRequestHeaders`, и там же общий билдер заголовков
 * Приора: здесь утверждение «для Приора шлём его заголовки» было бы непроверяемым.
 */
export async function getBankJson(provider: BankProviderId, url: string, accessToken: string): Promise<unknown> {
  const fetchJson = $fetch as unknown as (
    url: string,
    opts: { method: string, headers: Record<string, string>, timeout: number }
  ) => Promise<unknown>
  // Выбор заголовков — в чистом `accountsRequestHeaders`: здесь он был бы непроверяем, а
  // ошибиться в нём значит потерять счета целого банка молча (#20).
  const headers = accountsRequestHeaders(provider, accessToken, randomUUID())
  try {
    return await fetchJson(url, { method: 'GET', headers, timeout: 20_000 })
  } catch (e) {
    const status = (e as { status?: number })?.status
    throw new Error(`банк не ответил${status ? ` (${status})` : ''}`, { cause: e })
  }
}

export function bankSideDeps(lockWait: string): BankSideListDeps {
  return {
    tokens: memberId => listBankTokensForPortal(dbQuery, memberId),
    // ⚠ Ожидание лока — КОРОТКОЕ (#539). Умолчание в 10 с здесь означало бы, что админ, открывший
    // экран сверки в момент планового продления токена, десять секунд держит соединение из пула
    // (пул — 10, из него же берут readiness-проба и все остальные порталы) ради шанса выиграть у
    // держателя, который сам ограничен 15 секундами. Дождаться нельзя — можно только не мешать.
    ensureFresh: token => ensureBankToken(token, undefined, { lockWait }),
    // Reuses the statement transport's config resolver, so a deployment can never end up asking
    // one host for the account list and another for the statement.
    apiBase: provider => bankApiConfig(provider)?.base ?? null,
    getJson: getBankJson
  }
}
