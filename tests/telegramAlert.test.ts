import { describe, expect, it } from 'vitest'
import {
  MAX_TELEGRAM_TEXT, resolveTelegramConfig, sendTelegramAlert,
  telegramConfigAttempted, type AlertFetchFn, type TelegramConfig
} from '../server/utils/telegramAlert'

// Telegram transport (#426). The security contract is the point: the bot token lives in the URL of
// every call, so it must never surface in a log, an error or a return value.

const TOKEN = '1234567890:AAF-abcdefghijklmnopqrstuvwxyz012345'
const cfg: TelegramConfig = { token: TOKEN, chatId: '-1001234567890' }

function fakeFetch(status: number | Error) {
  const calls: Array<{ url: string, body: string }> = []
  const fn: AlertFetchFn = async (url, init) => {
    calls.push({ url, body: init.body })
    if (status instanceof Error) throw status
    return { status }
  }
  return { fn, calls }
}

describe('resolveTelegramConfig', () => {
  it('resolves a well-formed pair', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: '-100123' })).toEqual({ token: TOKEN, chatId: '-100123' })
  })

  it('accepts a positive user id and an @channel', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: '778899' })).not.toBeNull()
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: '@ops_channel' })).not.toBeNull()
  })

  it('is OFF when unset — an unconfigured channel is a normal deployment', () => {
    expect(resolveTelegramConfig({})).toBeNull()
  })

  it('is OFF when HALF-configured (a token with nowhere to send would drop every alert)', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: TOKEN })).toBeNull()
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_CHAT_ID: '-100123' })).toBeNull()
  })

  it('rejects a truncated / malformed token rather than failing at send time', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: 'AAF-short', TELEGRAM_ALERT_CHAT_ID: '-100123' })).toBeNull()
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: '123:tooshort', TELEGRAM_ALERT_CHAT_ID: '-100123' })).toBeNull()
  })

  it('rejects a nonsense chat id', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: 'my chat' })).toBeNull()
  })
})

describe('telegramConfigAttempted', () => {
  it('distinguishes «выключен» from «настроен с опечаткой» (envCheck warns only on the latter)', () => {
    expect(telegramConfigAttempted({})).toBe(false)
    expect(telegramConfigAttempted({ TELEGRAM_ALERT_CHAT_ID: '-100123' })).toBe(true)
    expect(telegramConfigAttempted({ TELEGRAM_ALERT_BOT_TOKEN: 'oops' })).toBe(true)
  })
})

describe('sendTelegramAlert', () => {
  it('posts the text to the bot endpoint and reports success', async () => {
    const { fn, calls } = fakeFetch(200)
    expect(await sendTelegramAlert(cfg, 'очередь встала', fn)).toEqual({ ok: true, status: 200, retryable: false })
    expect(calls[0]!.url).toContain('/sendMessage')
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: '-1001234567890', text: 'очередь встала' })
  })

  it('sends PLAIN text — no parse_mode, so nothing in the message can escape into markup', async () => {
    const { fn, calls } = fakeFetch(200)
    await sendTelegramAlert(cfg, '*not bold* [x](y)', fn)
    expect(JSON.parse(calls[0]!.body).parse_mode).toBeUndefined()
  })

  it('truncates to the Telegram limit instead of being rejected at 4097 chars', async () => {
    const { fn, calls } = fakeFetch(200)
    await sendTelegramAlert(cfg, 'x'.repeat(MAX_TELEGRAM_TEXT + 500), fn)
    expect(JSON.parse(calls[0]!.body).text).toHaveLength(MAX_TELEGRAM_TEXT)
  })

  it('a network failure is retryable and leaks NOTHING (the error can echo the token URL)', async () => {
    const { fn } = fakeFetch(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`))
    const r = await sendTelegramAlert(cfg, 'x', fn)
    expect(r).toEqual({ ok: false, status: 0, retryable: true })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('429 and 5xx are retryable; 400/401/403 are not (a wrong chat id will never succeed)', async () => {
    for (const s of [429, 500, 503]) expect((await sendTelegramAlert(cfg, 'x', fakeFetch(s).fn)).retryable).toBe(true)
    for (const s of [400, 401, 403]) expect((await sendTelegramAlert(cfg, 'x', fakeFetch(s).fn)).retryable).toBe(false)
  })

  it('the result never carries the token', async () => {
    const r = await sendTelegramAlert(cfg, 'x', fakeFetch(403).fn)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('bounds the call with an abort signal (a hung send must not outlive the incident)', async () => {
    let signal: AbortSignal | undefined
    const fn: AlertFetchFn = async (_u, init) => {
      signal = init.signal
      return { status: 200 }
    }
    await sendTelegramAlert(cfg, 'x', fn)
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
