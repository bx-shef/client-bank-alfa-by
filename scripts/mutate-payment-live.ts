// Live verification of the allocation MUTATION slice (§2, #109) against the seeded
// test portal (dev-only, not part of SSG). Exercises the REAL pure builder
// (`buildAllocationMutation`) and transport (`payAllocationViaRest`) that crm-sync
// uses when the `autoDistribute` gate is on. Webhook from git-ignored `.env.b24test`.
//
// SAFE BY DEFAULT — dry-run: shows the exact REST call it WOULD send, writes nothing.
//   pnpm mutate:test            # dry-run: print the mutation for the seed deal-payment
//   pnpm mutate:test --apply    # actually call crm.item.payment.pay, then confirm paid
//   pnpm mutate:test --revert   # restore: sale.payment.update PAID=N (scope sale)
//   pnpm mutate:test --invoice <id> --stage <stageId> [--apply]  # invoice → crm.item.update stageId
// Optional: --deal <id> (default 15 — seed «Сделка Опт» with one unpaid payment).

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err, warn } from './lib/cli.mjs'
import { findDealPayments } from '../server/utils/paymentLookup.ts'
import { buildAllocationMutation } from '../app/utils/allocationMutation.ts'
import { payAllocationViaRest } from '../server/utils/allocationMutationWrite.ts'

loadDotEnv(['.env.b24test'], { explicit: false })
const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
if (!WEBHOOK) {
  err('B24_TEST_WEBHOOK missing in .env.b24test')
  process.exit(1)
}

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const REVERT = argv.includes('--revert')
const dealArg = argv[argv.indexOf('--deal') + 1]
const DEAL_ID = argv.includes('--deal') && dealArg ? Number(dealArg) : 15
// Invoice-stage mode: `--invoice <id> --stage <stageId>` transitions a smart-invoice
// via the SAME builder/transport crm-sync uses (dry-run by default; --apply writes).
const invoiceArg = argv[argv.indexOf('--invoice') + 1]
const INVOICE_ID = argv.includes('--invoice') && invoiceArg ? invoiceArg : ''
const stageArg = argv[argv.indexOf('--stage') + 1]
const STAGE_ID = argv.includes('--stage') && stageArg ? stageArg : ''

const call = async (method: string, params: Record<string, unknown> = {}) => {
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

process.on('unhandledRejection', (e) => {
  err(`Прогон упал: ${(e as { message?: string })?.message ?? String(e)}`)
  process.exit(1)
})

const MODE = APPLY ? 'APPLY' : REVERT ? 'REVERT' : 'DRY-RUN'
const maskedHook = WEBHOOK.replace(/\/rest\/\d+\/[^/]+/, '/rest/***/***')

// ── Invoice-stage mode (§2 invoice slice) ──────────────────────────────────────
if (INVOICE_ID) {
  head(`#109 invoice-stage · счёт ${INVOICE_ID} → «${STAGE_ID}» · ${MODE} · ${maskedHook}`)
  if (!STAGE_ID) {
    err('Укажите целевую стадию: --stage <stageId> (напр. DT31_11:P).')
    process.exit(1)
  }
  // Show the current stage (for context / manual revert).
  const cur = await call('crm.item.list', { entityTypeId: 31, filter: { id: INVOICE_ID }, select: ['id', 'stageId', 'accountNumber'] })
  const item0 = ((cur.result as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])[0]
  console.log(`${C.dim}Текущий счёт: ${JSON.stringify(item0 ?? null)}${C.reset}`)
  const invTarget = { kind: 'invoice' as const, id: INVOICE_ID }
  const mutation = buildAllocationMutation(invTarget, { invoicePaidStageId: STAGE_ID })
  if (!mutation) {
    err('Мутация не построена (проверьте id счёта и стадию).')
    process.exit(1)
  }
  ok(`Построена мутация: ${C.reset}${mutation.method}(${JSON.stringify(mutation.params)})`)
  if (!APPLY) {
    head('DRY-RUN — ничего не записано. Повторите с --apply, чтобы перевести стадию.')
    process.exit(0)
  }
  let res
  try {
    res = await payAllocationViaRest(invTarget, call, { invoicePaidStageId: STAGE_ID })
  } catch (e) {
    err(`Портал отклонил перевод стадии: ${(e as Error)?.message}`)
    process.exit(1)
  }
  if (!res.applied) {
    err(`Мутация не применилась: ${JSON.stringify(res)}`)
    process.exit(1)
  }
  const after = await call('crm.item.list', { entityTypeId: 31, filter: { id: INVOICE_ID }, select: ['id', 'stageId'] })
  const item1 = ((after.result as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])[0]
  ok(`Стадия счёта ${INVOICE_ID} теперь: ${JSON.stringify(item1 ?? null)}`)
  head(`Готово. Вернуть прежнюю стадию: pnpm mutate:test --invoice ${INVOICE_ID} --stage <прежняя> --apply`)
  process.exit(0)
}

head(`#109 mutation slice · сделка ${DEAL_ID} · ${MODE} · ` + maskedHook)

// Read the deal's payments (include paid so we see the full picture).
const payments = await findDealPayments(DEAL_ID, { includePaid: true }, call)
if (payments.length === 0) {
  warn(`У сделки ${DEAL_ID} нет оплат — прогоните \`pnpm seed:b24\`. Нечего проводить.`)
  process.exit(1)
}
const target = payments[0]
console.log(`${C.dim}Цель: ${JSON.stringify(target)}${C.reset}`)

if (REVERT) {
  // Restore the fixture: mark the payment unpaid again (scope sale).
  await call('sale.payment.update', { id: Number(target.id), fields: { paid: 'N' } })
  const after = await findDealPayments(DEAL_ID, { includePaid: true }, call)
  ok(`Сторно выполнено — оплата ${target.id} снова НЕ оплачена (для повторного прогона).`)
  console.log(`${C.dim}${JSON.stringify(after[0])}${C.reset}`)
  process.exit(0)
}

// Build the mutation the SAME way crm-sync does (pure builder).
const mutation = buildAllocationMutation(target)
if (!mutation) {
  err(`Для цели ${target.kind} нет v1-мутации (ожидался deal-payment).`)
  process.exit(1)
}
ok(`Построена мутация: ${C.reset}${mutation.method}(${JSON.stringify(mutation.params)})`)

if (!APPLY) {
  head('DRY-RUN — ничего не записано. Повторите с --apply, чтобы провести оплату.')
  process.exit(0)
}

// APPLY: perform the real mutation through the SAME transport crm-sync uses. A REST
// error (e.g. the seed «Internal account» pay system needs a buyer balance —
// `BX_ERROR Insufficient funds`) is the transport's PROPAGATED throw; catch it here for a
// legible message instead of a raw stack (in `crm-sync` this same throw fails the job → retry).
let res
try {
  res = await payAllocationViaRest(target, call)
} catch (e) {
  err(`Портал отклонил проведение: ${(e as Error)?.message}`)
  warn('Это ПРАВИЛЬНОЕ поведение транспорта (ошибка проброшена → в бою джоба ушла бы в ретрай, факт не пишется).')
  warn('Оплата «Внутренний счёт» требует баланс покупателя; для банковского перевода `payment.pay` переключает флаг без баланса.')
  process.exit(1)
}
if (!res.applied) {
  err(`Мутация не применилась: ${JSON.stringify(res)}`)
  process.exit(1)
}
ok(`Оплата проведена (${res.method} id=${res.id}).`)

// Confirm the portal state actually flipped to paid.
const listAll = await call('crm.item.payment.list', { entityId: DEAL_ID, entityTypeId: 2 })
const rows = (listAll.result as Array<Record<string, unknown>> | undefined) ?? []
const row = rows.find(r => String(r.id) === String(target.id))
const nowPaid = row && String(row.paid) === 'Y'
if (nowPaid) {
  ok(`Подтверждено в портале: оплата ${target.id} теперь PAID=Y.`)
  head('Готово. Восстановить фикстуру: pnpm mutate:test --revert')
  process.exit(0)
}
err(`Оплата ${target.id} НЕ помечена оплаченной после вызова: ${JSON.stringify(row)}`)
process.exit(1)
