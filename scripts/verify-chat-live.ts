// Live verification for the chat-notification path (stage 6, dev-only, not part of the
// SSG build). Runs the REAL pure builder + transport (`buildChatMessage` →
// `notifyChatViaRest` → `im.message.add`) against a live test portal, proving that an
// operation actually posts to a Bitrix24 chat and returns a message id. Then DELETES the
// test message so the portal stays clean. Webhook comes from the git-ignored `.env.b24test`.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/verify-chat-live.ts
// (wired as `pnpm verify:chat`).

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err } from './lib/cli.mjs'
import { notifyChatViaRest } from '../server/utils/chatNotifyWrite.ts'
import { normalizeRecentChats } from '../server/utils/chatSearch.ts'
import { buildChatMessage } from '../app/utils/chatMessage.ts'
import type { StatementItem } from '../app/types/statement.ts'

loadDotEnv(['.env.b24test'], { explicit: false })

const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
if (!WEBHOOK) {
  err('B24_TEST_WEBHOOK missing in .env.b24test')
  process.exit(1)
}

// Same RestCall contract the transport expects: POST JSON → full {result,…} envelope,
// throw on a B24 error.
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

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    ok(`${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`)
  } else {
    fail++
    err(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

process.on('unhandledRejection', (e) => {
  err(`Прогон упал: ${(e as { message?: string })?.message ?? String(e)}`)
  process.exit(1)
})

head('Стадия 6 · live чат-уведомление · ' + WEBHOOK.replace(/\/rest\/\d+\/[^/]+/, '/rest/***/***'))

// A synthetic operation whose external fields carry BB-injection bait — proves the
// builder neutralizes it (the message must NOT contain a live [url=…] tag).
const item: StatementItem = {
  account: 'BY04ALFA30129000000000009100',
  docId: 'CHATVERIFY-1',
  docNum: '777',
  direction: 'credit',
  amount: 1234.56,
  currency: 'BYN',
  purpose: 'Оплата по счёту №777 [url=https://evil.example]клик[/url]',
  counterparty: { name: 'ООО «Ромашка» [b]жир[/b]', account: 'BY24CLIENT', unp: '191234567' },
  acceptDate: '2026-07-16'
}

// 1) The builder renders text and neutralizes payer-controlled BB.
const msg = buildChatMessage(item)
check('buildChatMessage: непустой текст', msg.length > 0, `${msg.length} симв.`)
check('buildChatMessage: BB плательщика нейтрализован (нет живого [url=…])', !/\[url=/i.test(msg))
check('buildChatMessage: сумма с кодом валюты', msg.includes('BYN'))

// 2) Pick a live chat target. Prefer a recent GROUP dialog (via the SAME prod normalizer
//    the picker uses — `normalizeRecentChats` reads `result.items`, drops 1:1 `type==='user'`,
//    and builds the id as `chat<chat_id ?? id>`); fall back to the current user's own id (a
//    1:1 self-chat) so the check still works on a fresh portal with no group chats.
let dialogId = ''
let targetKind = 'self'
try {
  const page = normalizeRecentChats(await call('im.recent.list'))
  if (page.items[0]) {
    dialogId = page.items[0].value
    targetKind = 'group'
  }
} catch { /* im.recent.list may be empty/unavailable — fall back below */ }
if (!dialogId) {
  const profile = (await call('profile')).result as { ID?: unknown } | undefined
  const uid = profile?.ID
  if (uid) dialogId = String(uid) // 1:1 self dialog
}
check('выбран DIALOG_ID для отправки', dialogId.length > 0, `${dialogId} (${targetKind})`)

// 3) Live post via the REAL transport, then verify + clean up.
if (dialogId) {
  const messageId = await notifyChatViaRest(item, dialogId, call)
  check('notifyChatViaRest: im.message.add вернул id сообщения', !!messageId, `msgId=${messageId}`)
  if (messageId) {
    const del = (await call('im.message.delete', { MESSAGE_ID: Number(messageId) })).result
    check('очистка: тестовое сообщение удалено', del === true || del === undefined, `del=${JSON.stringify(del)}`)
  }
}

head(fail === 0 ? `Все проверки пройдены (${pass})` : `${C.red}Провалено: ${fail}${C.reset} (пройдено ${pass})`)
process.exit(fail === 0 ? 0 : 1)
