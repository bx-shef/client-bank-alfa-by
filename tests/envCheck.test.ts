import { describe, expect, it } from 'vitest'
import { checkBackendEnv } from '../server/utils/envCheck'

// A base env where everything is valid — each test perturbs one field.
const GOOD: NodeJS.ProcessEnv = {
  B24_TOKEN_ENC_KEY: 'a'.repeat(64), // 64 hex chars → 32 bytes
  DATABASE_URL: 'postgres://app:pw@db:5432/app',
  REDIS_URL: 'redis://redis:6379',
  B24_CLIENT_ID: 'local.abc',
  B24_CLIENT_SECRET: 'shh',
  B24_APPLICATION_TOKEN: ''
}

describe('checkBackendEnv', () => {
  it('reports no errors/warnings on a valid env', () => {
    const r = checkBackendEnv(GOOD)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('warns on a HALF-configured bank (some but not all OAuth creds), silent when absent or complete', () => {
    // none set → no bank warning (feature simply off)
    expect(checkBackendEnv(GOOD).warnings.some(w => /Банк/.test(w))).toBe(false)
    // partial Alfa → warning naming the missing var
    const half = checkBackendEnv({ ...GOOD, ALFA_OAUTH_CLIENT_ID: 'cid', ALFA_OAUTH_CLIENT_SECRET: 'sec' })
    expect(half.warnings.some(w => /Банк Альфа/.test(w) && /ALFA_OAUTH_TOKEN_URL/.test(w))).toBe(true)
    // all three → no warning
    const full = checkBackendEnv({ ...GOOD, ALFA_OAUTH_CLIENT_ID: 'cid', ALFA_OAUTH_CLIENT_SECRET: 'sec', ALFA_OAUTH_TOKEN_URL: 'https://a/token' })
    expect(full.warnings.some(w => /Банк Альфа/.test(w))).toBe(false)
  })

  it('errors when B24_TOKEN_ENC_KEY is missing', () => {
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: '' })
    expect(r.errors.some(e => e.includes('B24_TOKEN_ENC_KEY'))).toBe(true)
  })

  it('errors when B24_TOKEN_ENC_KEY decodes to the wrong length (the 31-byte trap)', () => {
    // 62 hex chars → not the /^[0-9a-fA-F]{64}$/ form → parsed as base64 → 46 bytes ≠ 32.
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: 'a'.repeat(62) })
    expect(r.errors.some(e => e.includes('32 байта'))).toBe(true)
  })

  it('accepts a base64 key that decodes to 32 bytes', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64')
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY: b64 })
    expect(r.errors).toEqual([])
  })

  it('errors on a placeholder B24_APPLICATION_TOKEN (case-insensitive)', () => {
    for (const v of ['CHANGE_ME', 'changeme', 'xxx', 'placeholder']) {
      const r = checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: v })
      expect(r.errors.some(e => e.includes('B24_APPLICATION_TOKEN'))).toBe(true)
    }
  })

  it('accepts an empty B24_APPLICATION_TOKEN (multi-tenant bootstrap) and a real-looking value', () => {
    expect(checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: '' }).errors).toEqual([])
    expect(checkBackendEnv({ ...GOOD, B24_APPLICATION_TOKEN: '51856fefc120afa4b628cc82d3935cce' }).errors).toEqual([])
  })

  it('errors when DATABASE_URL is missing', () => {
    const r = checkBackendEnv({ ...GOOD, DATABASE_URL: '' })
    expect(r.errors.some(e => e.includes('DATABASE_URL'))).toBe(true)
  })

  it('warns (not errors) when OAuth client creds are missing', () => {
    const r = checkBackendEnv({ ...GOOD, B24_CLIENT_ID: '', B24_CLIENT_SECRET: '' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => w.includes('B24_CLIENT_ID'))).toBe(true)
  })

  it('warns (not errors) when REDIS_URL is missing — queue off, sync fallback', () => {
    const r = checkBackendEnv({ ...GOOD, REDIS_URL: '' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => w.includes('REDIS_URL'))).toBe(true)
  })

  it('#242 P1: errors when prod has an operator password but no SESSION_SECRET (fail-closed lockout)', () => {
    const r = checkBackendEnv({ ...GOOD, NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
    expect(r.errors.some(e => e.includes('SESSION_SECRET'))).toBe(true)
  })

  it('#242 P1: no SESSION_SECRET error when the key is set, or outside production, or no operator password', () => {
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw', SESSION_SECRET: 'K' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'development', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
    expect(checkBackendEnv({ ...GOOD, NODE_ENV: 'production' })
      .errors.some(e => e.includes('SESSION_SECRET'))).toBe(false)
  })
})

describe('B24_TOKEN_ENC_KEY_OLD (ротация ключа)', () => {
  const GOOD = { B24_TOKEN_ENC_KEY: 'a'.repeat(64), DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv

  it('битый прежний ключ — ошибка: расшифровка молча его пропустит, это единственный громкий сигнал', () => {
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY_OLD: 'a'.repeat(62) } as NodeJS.ProcessEnv)
    expect(r.errors.some(e => e.includes('B24_TOKEN_ENC_KEY_OLD'))).toBe(true)
  })

  it('совпадающий прежний ключ — предупреждение: ротация не начата', () => {
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY_OLD: 'a'.repeat(64) } as NodeJS.ProcessEnv)
    expect(r.warnings.some(w => w.includes('B24_TOKEN_ENC_KEY_OLD'))).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('тот же ключ в другой записи (hex vs base64) тоже ловится — сравнение побайтовое', () => {
    const base64Same = Buffer.from('a'.repeat(64), 'hex').toString('base64')
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY_OLD: base64Same } as NodeJS.ProcessEnv)
    expect(r.warnings.some(w => w.includes('B24_TOKEN_ENC_KEY_OLD'))).toBe(true)
  })

  it('валидный ОТЛИЧНЫЙ прежний ключ — тишина (штатное окно ротации)', () => {
    const r = checkBackendEnv({ ...GOOD, B24_TOKEN_ENC_KEY_OLD: 'b'.repeat(64) } as NodeJS.ProcessEnv)
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => w.includes('B24_TOKEN_ENC_KEY_OLD'))).toBe(false)
  })
})

describe('Телеграм-канал оповещений (#426)', () => {
  const GOOD = { B24_TOKEN_ENC_KEY: 'a'.repeat(64), DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv
  const TOKEN = '1234567890:AAF-abcdefghijklmnopqrstuvwxyz012345'
  const hasTg = (r: { warnings: string[] }) => r.warnings.some(w => w.includes('Телеграм'))

  it('канал не задан — тишина: невыключенный канал это штатный деплой, а не ошибка', () => {
    expect(hasTg(checkBackendEnv(GOOD))).toBe(false)
  })

  it('корректная пара — тишина', () => {
    expect(hasTg(checkBackendEnv({ ...GOOD, TELEGRAM_ALERT_BOT_TOKEN: TOKEN, TELEGRAM_ALERT_CHAT_ID: '-100123' } as NodeJS.ProcessEnv))).toBe(false)
  })

  it('задан только токен — предупреждение: оператор думает, что за ним следят, а алерты пропадают', () => {
    expect(hasTg(checkBackendEnv({ ...GOOD, TELEGRAM_ALERT_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv))).toBe(true)
  })

  it('задан только chat id — предупреждение', () => {
    expect(hasTg(checkBackendEnv({ ...GOOD, TELEGRAM_ALERT_CHAT_ID: '-100123' } as NodeJS.ProcessEnv))).toBe(true)
  })

  it('обрезанный токен — предупреждение (опечатка ловится на старте, а не при первой аварии)', () => {
    expect(hasTg(checkBackendEnv({ ...GOOD, TELEGRAM_ALERT_BOT_TOKEN: '123:short', TELEGRAM_ALERT_CHAT_ID: '-100123' } as NodeJS.ProcessEnv))).toBe(true)
  })

  it('это предупреждение, не ошибка — приложение поднимается и работает как раньше', () => {
    expect(checkBackendEnv({ ...GOOD, TELEGRAM_ALERT_BOT_TOKEN: 'oops' } as NodeJS.ProcessEnv).errors).toEqual([])
  })
})

describe('Крипто-шлюз Приора: адресация (#455)', () => {
  const GOOD = { B24_TOKEN_ENC_KEY: 'a'.repeat(64), DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv
  const BANK = 'https://apibel.priorbank.by:9345'
  const GW = 'http://avtunproxy:1080'
  const warns = (env: Record<string, string>, re: RegExp) =>
    checkBackendEnv({ ...GOOD, ...env } as NodeJS.ProcessEnv).warnings.some(w => re.test(w))

  it('ничего не задано — тишина (фича выключена)', () => {
    expect(warns({}, /API_BASE|AUTHORIZE_BASE|РАЗНЫЕ адреса/)).toBe(false)
  })

  it('обычная конфигурация без шлюза — тишина', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: BANK, PRIOR_OAUTH_TOKEN_URL: `${BANK}/oauth2/token` }, /РАЗНЫЕ адреса|непригоден|авторизации/)).toBe(false)
  })

  // Главная ловушка cutover'а: переменные независимы, перевели одну — забыли вторую, и обновление
  // токена продолжает тихо ходить на старый хост, пока импорт не встанет.
  it('рассинхрон API_BASE и TOKEN_URL — предупреждение', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW, PRIOR_OAUTH_TOKEN_URL: `${BANK}/oauth2/token`, PRIOR_OAUTH_AUTHORIZE_BASE: BANK }, /РАЗНЫЕ адреса/)).toBe(true)
  })

  it('совпадающий origin при разных путях — тишина', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW, PRIOR_OAUTH_TOKEN_URL: `${GW}/oauth2/token`, PRIOR_OAUTH_AUTHORIZE_BASE: BANK }, /РАЗНЫЕ адреса/)).toBe(false)
  })

  it('http на ПУБЛИЧНЫЙ хост в API_BASE — предупреждение (токен ушёл бы открытым текстом)', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: 'http://apibel.priorbank.by:9345' }, /API_BASE непригоден/)).toBe(true)
  })

  // Негодный API_BASE НЕ должен вдобавок обвиняться во «внутреннем адресе»: оператор пойдёт
  // искать шлюз, которого нет, вместо того чтобы починить схему. Одна причина — одно сообщение.
  it.each(['http://apibel.priorbank.by:9345', 'apibel.priorbank.by', 'ftp://host'])(
    'негодный API_BASE не даёт ЛОЖНОГО «внутренний адрес»: %s', (base) => {
      expect(warns({ PRIOR_OAUTH_API_BASE: base }, /указывает на внутренний адрес/)).toBe(false)
      expect(warns({ PRIOR_OAUTH_API_BASE: base }, /API_BASE непригоден/)).toBe(true)
    })

  it('внутренний адрес в AUTHORIZE_BASE — предупреждение (его открывает браузер)', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW, PRIOR_OAUTH_AUTHORIZE_BASE: GW }, /AUTHORIZE_BASE непригоден/)).toBe(true)
  })

  it('внутренний API_BASE без публичного AUTHORIZE_BASE — предупреждение', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW }, /авторизации/)).toBe(true)
  })

  // Самая коварная форма: подключение и первая выписка проходят, а рефреш встаёт через час —
  // отказ отложен и никак не связан по времени с забытой переменной.
  it('API_BASE без TOKEN_URL — предупреждение про отложенный отказ рефреша', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: BANK }, /ОБНОВЛЕНИЕ токена|TOKEN_URL — нет/)).toBe(true)
  })

  it('обе заданы — про рефреш молчим', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: BANK, PRIOR_OAUTH_TOKEN_URL: `${BANK}/oauth2/token` }, /ОБНОВЛЕНИЕ токена/)).toBe(false)
  })

  it('TOKEN_URL без API_BASE — про рефреш молчим (не наш случай)', () => {
    expect(warns({ PRIOR_OAUTH_TOKEN_URL: `${BANK}/oauth2/token` }, /ОБНОВЛЕНИЕ токена/)).toBe(false)
  })

  it('внутренний API_BASE + публичный AUTHORIZE_BASE — тишина (штатная схема со шлюзом)', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW, PRIOR_OAUTH_AUTHORIZE_BASE: BANK, PRIOR_OAUTH_TOKEN_URL: `${GW}/oauth2/token` }, /непригоден|авторизации|РАЗНЫЕ адреса/)).toBe(false)
  })
})
