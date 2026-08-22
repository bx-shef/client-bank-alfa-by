// Live verification for the #575 PAYMENT REGISTRY write path (dev-only, not part of SSG).
//
// #575 turned the payment SP from an allocation trace into a REGISTRY: an element is written for
// EVERY operation, carrying who paid, when, from which account and what for. Two things about that
// cannot be settled by unit tests, because they are claims about what a real Bitrix24 portal does:
//
//   1. an SP provisioned BEFORE #575 must SELF-HEAL — the eight registry fields have to arrive on a
//      smart process that already exists, otherwise the owner's live portal never gets the columns;
//   2. the values have to survive the round trip — `crm.item.add` accepts unknown UF keys silently
//      (measured 2026-08-22), so a wrong field name does not fail, it just vanishes. Only reading
//      the element back proves the column was actually written.
//
// Steps:
//   1. provisionDistributionSp     — create/self-heal both SPs + fields (idempotent)
//   2. writePaymentRegistryViaRest — one synthetic operation
//   3. crm.item.get                — assert ALL EIGHT registry fields round-tripped
//   4. repeat step 2               — assert idempotency (same element id, no second element)
//   5. teardown                    — delete the created item (and, with --purge-sp, the SP types)
//
// ⚠ The operation is SYNTHETIC and stays synthetic. This file is committed to a PUBLIC repository
// and it writes to a portal: a real statement row here would publish a counterparty's account
// number, УНП and payment purpose (see docs/PRIVACY.md).
//
// Run:  pnpm verify:registry            (webhook, .env.b24test)
//       pnpm verify:registry --oauth    (prod transport, .env.b24oauth — ROTATES the refresh token)
//       add --keep to leave the created element on the portal.

import { readFileSync, writeFileSync } from 'node:fs'
import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err } from './lib/cli.mjs'
import { provisionDistributionSp } from '../server/utils/distributionSpProvision.ts'
import { writePaymentRegistryViaRest, DIRECTION_LABELS } from '../server/utils/paymentRegistryWrite.ts'
import { PAYMENT_SP_FIELDS, buildUfFieldNameCamel, type SpRef } from '../app/config/distributionSp.ts'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import type { StatementItem } from '../app/types/statement.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'

type RestCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const useOauth = process.argv.includes('--oauth')
const keep = process.argv.includes('--keep')

loadDotEnv(['.env.b24test'], { explicit: false })
loadDotEnv(['.env.b24oauth'], { explicit: false })

function webhookCall(): RestCall {
  const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
  if (!WEBHOOK) {
    err('B24_TEST_WEBHOOK missing in .env.b24test')
    process.exit(1)
  }
  return async (method, params = {}) => {
    const res = await httpRequest(WEBHOOK + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params)
    })
    const j = res.json as Record<string, unknown> | undefined
    if (j && j.error) throw new Error(`${method}: ${j.error} ${(j as { error_description?: string }).error_description || ''}`.trim())
    if (!j) throw new Error(`${method}: non-JSON (HTTP ${res.status})`)
    return j
  }
}

async function oauthCall(): Promise<{ call: RestCall, label: string }> {
  const env = (k: string) => (process.env[k] ?? '').trim()
  const memberId = env('B24_OAUTH_MEMBER_ID')
  const domain = env('B24_OAUTH_DOMAIN')
  const req = {
    B24_OAUTH_DOMAIN: domain, B24_OAUTH_MEMBER_ID: memberId,
    B24_OAUTH_ACCESS_TOKEN: env('B24_OAUTH_ACCESS_TOKEN'), B24_OAUTH_REFRESH_TOKEN: env('B24_OAUTH_REFRESH_TOKEN'),
    B24_CLIENT_ID: env('B24_CLIENT_ID'), B24_CLIENT_SECRET: env('B24_CLIENT_SECRET')
  }
  const missing = Object.entries(req).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    err(`--oauth: не хватает env: ${missing.join(', ')}`)
    process.exit(1)
  }
  const token: PortalToken = {
    memberId, domain, accessToken: env('B24_OAUTH_ACCESS_TOKEN'), refreshToken: env('B24_OAUTH_REFRESH_TOKEN'),
    applicationToken: '', expiresAt: Date.now() + Number(env('B24_OAUTH_EXPIRES_IN') || 3600) * 1000
  }
  const deps: SdkPortalDeps = {
    loadToken: async () => token,
    // ⚠ Пишем ротированный токен ОБРАТНО в .env.b24oauth. Bitrix24 ротирует refresh на каждом
    // обновлении, поэтому «просто проигнорировать» (как делает соседний verify-distribution)
    // означает, что файл протухает после ПЕРВОГО же прогона и следующий запуск падает на
    // `invalid_grant` — то есть живую проверку нельзя повторить, а повторяемость и есть её смысл.
    // Файл в .gitignore; портал — тестовый.
    saveToken: async (t) => {
      try {
        persistOauthEnv(t.accessToken, t.refreshToken)
        console.log(`${C.dim}   (токен обновлён, .env.b24oauth перезаписан)${C.reset}`)
      } catch (e) {
        err(`не удалось сохранить обновлённый токен: ${String((e as Error)?.message ?? e)}`)
      }
    },
    creds: { clientId: env('B24_CLIENT_ID'), clientSecret: env('B24_CLIENT_SECRET') },
    now: Date.now,
    scope: B24_REQUIRED_SCOPES.join(',')
  }
  const call = await makePortalSdkCall(memberId, deps)
  if (!call) {
    err('--oauth: makePortalSdkCall вернул null')
    process.exit(1)
  }
  return { call: call as RestCall, label: `OAuth ${domain}` }
}

/** Переписать access/refresh в .env.b24oauth, сохранив остальные строки и порядок. */
function persistOauthEnv(accessToken: string, refreshToken: string): void {
  const file = '.env.b24oauth'
  const lines = readFileSync(file, 'utf8').split('\n')
  const set = (key: string, value: string) => {
    const i = lines.findIndex(l => l.startsWith(`${key}=`))
    if (i >= 0) lines[i] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
  }
  set('B24_OAUTH_ACCESS_TOKEN', accessToken)
  set('B24_OAUTH_REFRESH_TOKEN', refreshToken)
  writeFileSync(file, lines.join('\n'))
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    ok(`${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`)
  } else {
    fail++
    err(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Synthetic operation. ⚠ Every value is made up — see the privacy note in the header. */
const stamp = process.env.REGISTRY_PROBE_STAMP || String(Math.floor(Date.now() / 1000))
const OP: StatementItem = {
  account: `BY00PROBE${stamp}`,
  docId: `probe-${stamp}`,
  direction: 'credit',
  amount: 1234.56,
  currency: 'BYN',
  purpose: 'Оплата по счёту СЧ-1 (синтетическая проба #575)',
  counterparty: {
    name: 'ООО «Проба Реестра»',
    unp: '000000000',
    account: `BY00CPTY${stamp}`,
    bank: 'Проба-банк'
  },
  acceptDate: '2026-08-21T00:00:00+03:00'
}

async function main() {
  head('#575 — реестр платежей, живая проверка')
  const { call, label } = useOauth ? await oauthCall() : { call: webhookCall(), label: 'webhook .env.b24test' }
  console.log(`${C.dim}транспорт: ${label}${C.reset}\n`)

  head('1. Провижининг (создание или САМОЛЕЧЕНИЕ существующего СП)')
  const prov = await provisionDistributionSp(call)
  const sp: SpRef = prov.payment
  check('СП «платежи» доступен', sp.entityTypeId > 0 && sp.id > 0, `entityTypeId=${sp.entityTypeId} id=${sp.id}`)
  console.log(`${C.dim}   добавлено полей на этом прогоне: ${prov.addedFields}${C.reset}`)

  head('2. Запись элемента реестра')
  const id = await writePaymentRegistryViaRest(OP, null, 'alfa-by', sp, call)
  check('элемент записан', !!id, `id=${id}`)
  if (!id) {
    process.exit(1)
  }

  head('3. Чтение обратно — восемь полей реестра')
  // ⚠ Именно этот шаг и есть смысл живой проверки: `crm.item.add` молча глотает неизвестный UF-ключ,
  // поэтому опечатка в имени поля НЕ падает — значение просто исчезает. Видно это только чтением.
  const got = await call('crm.item.get', { entityTypeId: sp.entityTypeId, id })
  const item = ((got.result as { item?: Record<string, unknown> })?.item) ?? {}
  const uf = (postfix: string) => item[buildUfFieldNameCamel(sp.id, postfix)]
  // ⚠ Дата сверяется по КАЛЕНДАРНОЙ ЧАСТИ, а не байт-в-байт. Поле типа `date` не возвращает
  // присланную строку: портал нормализует её в свой часовой пояс и отдаёт, например,
  // `2026-08-21T03:00:00+03:00` на вход `2026-08-21`. Значение при этом верное — сравнивать надо то,
  // что поле означает (сутки), а не его представление. Именно поэтому в поле уходит голая
  // `YYYY-MM-DD`: сырой момент портал пересчитал бы, и `…T23:30:00Z` уехал бы на сутки вперёд.
  const gotDate = String(uf(PAYMENT_SP_FIELDS.operationDate.postfix) ?? '').slice(0, 10)
  check('дата операции доехала без сдвига суток', gotDate === OP.acceptDate.slice(0, 10),
    `получено ${gotDate}, ждали ${OP.acceptDate.slice(0, 10)}`)
  const expected: Array<[string, string, unknown]> = [
    ['направление', PAYMENT_SP_FIELDS.direction.postfix, DIRECTION_LABELS.credit],
    ['контрагент', PAYMENT_SP_FIELDS.counterparty.postfix, OP.counterparty.name],
    ['счёт контрагента', PAYMENT_SP_FIELDS.counterpartyAccount.postfix, OP.counterparty.account],
    ['УНП контрагента', PAYMENT_SP_FIELDS.counterpartyUnp.postfix, OP.counterparty.unp],
    ['назначение', PAYMENT_SP_FIELDS.purpose.postfix, OP.purpose],
    ['наш счёт', PAYMENT_SP_FIELDS.ownAccount.postfix, OP.account],
    ['банк', PAYMENT_SP_FIELDS.bank.postfix, 'Альфа-Банк']
  ]
  for (const [human, postfix, want] of expected) {
    check(`${human} доехало`, uf(postfix) === want, `получено ${JSON.stringify(uf(postfix))}, ждали ${JSON.stringify(want)}`)
  }
  check('сумма доехала', Number(uf(PAYMENT_SP_FIELDS.total.postfix)) === OP.amount, `получено ${JSON.stringify(uf(PAYMENT_SP_FIELDS.total.postfix))}`)
  check('валюта доехала', uf(PAYMENT_SP_FIELDS.currency.postfix) === OP.currency)

  head('4. Идемпотентность — повтор не создаёт второй элемент')
  const again = await writePaymentRegistryViaRest(OP, null, 'alfa-by', sp, call)
  check('повтор вернул ТОТ ЖЕ элемент', again === id, `первый=${id}, повтор=${again}`)

  head('5. Уборка')
  if (keep) {
    console.log(`${C.dim}   --keep: элемент ${id} оставлен на портале${C.reset}`)
  } else {
    await call('crm.item.delete', { entityTypeId: sp.entityTypeId, id })
    ok(`элемент ${id} удалён`)
  }

  console.log(`\n${fail === 0 ? C.green : C.red}ИТОГ: ${pass} пройдено, ${fail} провалено${C.reset}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  err(String((e as Error)?.message ?? e))
  process.exit(1)
})
