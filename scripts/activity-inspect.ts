// Read-only inspection of an activity written by the app: WHO owns it and WHAT it is bound to.
//
// Why it exists (#26). The activity list showed a smart-process element in the «Клиент» and
// «Сделка/Лид» columns instead of the payer's company. Our code sets the owner to a COMPANY
// (`buildTodoActivity` → ownerTypeId=4) and adds the registry element only as a BINDING, so the
// symptom and the code disagree — and guessing which is right from the outside is exactly the
// habit that produced wrong conclusions before. This prints the portal's own answer.
//
// ⚠ READ-ONLY by construction: it knows only `crm.activity.get` and `crm.activity.binding.list`.
// No update/delete method is imported, so it cannot change anything even by mistake.
//
// Run:  B24_TEST_WEBHOOK=https://<портал>/rest/<id>/<token>/ \
//         node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/activity-inspect.ts --id <activityId>
// (wired as `pnpm activity:inspect -- --id 2095`)

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, warn, err } from './lib/cli.mjs'

loadDotEnv(['.env.b24test'], { explicit: false })

const webhook = (process.env.B24_TEST_WEBHOOK ?? '').trim()
const idArg = process.argv[process.argv.indexOf('--id') + 1]

/** Названия типов CRM — чтобы в выводе стояло «компания», а не голое число. */
const OWNER_TYPE: Record<string, string> = {
  1: 'лид', 2: 'сделка', 3: 'контакт', 4: 'компания', 7: 'предложение', 31: 'счёт (SP 31)'
}

function typeName(id: unknown): string {
  const key = String(id ?? '')
  return OWNER_TYPE[key] ?? `смарт-процесс (entityTypeId=${key || '—'})`
}

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${webhook.replace(/\/+$/, '')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  const body = await res.json() as { result?: unknown, error_description?: string, error?: string }
  if (body.error) throw new Error(`${body.error}: ${body.error_description ?? ''}`)
  return body.result
}

async function main(): Promise<void> {
  if (!webhook || webhook.includes('your-portal')) {
    err('Нет вебхука. Задайте B24_TEST_WEBHOOK (см. .env.b24test.example).')
    process.exit(2)
  }
  if (!idArg) {
    err('Укажите дело: --id <activityId> (номер из колонки ID в списке дел).')
    process.exit(2)
  }

  head(`Дело ${idArg}`)
  const activity = await call('crm.activity.get', { id: Number(idArg) }) as Record<string, unknown>
  console.log(`  Заголовок:     ${String(activity.SUBJECT ?? '—')}`)
  console.log(`  Владелец:      ${typeName(activity.OWNER_TYPE_ID)} #${String(activity.OWNER_ID ?? '—')}`)
  console.log(`  Наш маркер:    ${String(activity.ORIGINATOR_ID ?? '—')} / ${String(activity.ORIGIN_ID ?? '—')}`)

  head('Привязки')
  const bindings = await call('crm.activity.binding.list', { activityId: Number(idArg) }) as Array<Record<string, unknown>>
  if (!bindings?.length) {
    warn('  привязок нет')
  } else {
    for (const b of bindings) {
      console.log(`  ${typeName(b.entityTypeId ?? b.ENTITY_TYPE_ID)} #${String(b.entityId ?? b.ENTITY_ID ?? '—')}`)
    }
  }

  head('Как читать')
  console.log(`  Владелец ${C.bold}компания${C.reset} — код отработал верно, и «Клиент» в списке дел`)
  console.log('  строится порталом из привязок, а не из владельца: тогда лечится составом привязок.')
  console.log(`  Владелец ${C.bold}смарт-процесс${C.reset} — пишем не то, и чинить надо запись дела.`)
  ok('Готово (ничего не изменено).')
}

main().catch((e) => {
  err(String((e as Error)?.message ?? e))
  process.exit(1)
})
