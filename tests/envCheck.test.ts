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

  it('локальный режим (#39): молчит на валидных/пустом, предупреждает на нераспознанном', () => {
    // Пусто → обычный режим, тихо.
    expect(checkBackendEnv({ ...GOOD, NUXT_PUBLIC_LOCAL_MODE: '' }).warnings.some(w => /LOCAL_MODE/.test(w))).toBe(false)
    // Явное включение — тоже тихо (это рабочий режим, не проблема).
    for (const v of ['1', 'true', 'on']) {
      expect(checkBackendEnv({ ...GOOD, NUXT_PUBLIC_LOCAL_MODE: v }).warnings.some(w => /LOCAL_MODE/.test(w))).toBe(false)
    }
    // Задан, но НЕ распознан — опасный случай (оператор думал, что включил): предупреждаем.
    const bad = checkBackendEnv({ ...GOOD, NUXT_PUBLIC_LOCAL_MODE: 'enable' })
    expect(bad.warnings.some(w => /NUXT_PUBLIC_LOCAL_MODE/.test(w) && /не распознан/.test(w))).toBe(true)
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

  it('предупреждает про ОБА крайних режима STATEMENT_OP_LOG — и шумный, и молчаливый (#498)', () => {
    // ⚠ Два предупреждения об одной переменной, и это не симметрия ради симметрии.
    // `all` — забытый калибровочный флаг: он возвращает строку `[op]` на КАЖДУЮ операцию, то есть
    // ровно тот объём, при котором замер дал четыре часа истории вместо суток. Снаружи это
    // выглядит просто «логи стали большими» — причину не связать с флагом.
    // `off` — обратная беда: он ничего не заливает, а ГАСИТ строки неприземлившихся операций,
    // единственную диагностику ненастроенного портала. Тогда пустой лог читается как «всё
    // хорошо» ровно на том портале, где не записалось ничто.
    expect(checkBackendEnv(GOOD).warnings.some(w => /STATEMENT_OP_LOG/.test(w))).toBe(false)
    // Умолчание и мусор — тихо: предупреждать про рабочий режим значит научить не читать warnings.
    for (const raw of ['notable', 'NOTABLE', '', 'verbose']) {
      expect(checkBackendEnv({ ...GOOD, STATEMENT_OP_LOG: raw }).warnings.some(w => /STATEMENT_OP_LOG/.test(w))).toBe(false)
    }
    const all = checkBackendEnv({ ...GOOD, STATEMENT_OP_LOG: ' ALL ' })
    expect(all.warnings.some(w => /STATEMENT_OP_LOG=all/.test(w) && /КАЖДУЮ/.test(w))).toBe(true)
    const off = checkBackendEnv({ ...GOOD, STATEMENT_OP_LOG: 'off' })
    expect(off.warnings.some(w => /STATEMENT_OP_LOG=off/.test(w) && /ВЫКЛЮЧЕН/.test(w))).toBe(true)
    // Ни один из режимов не ошибка — это настройка, а не брак конфигурации.
    expect(all.errors).toEqual([])
    expect(off.errors).toEqual([])
  })

  it('предупреждает про включённый STATEMENT_DEBUG_LOG — забытый флаг иначе ничем не виден', () => {
    // Флаг раскрывает назначения платежей в логе (docs/PRIVACY.md §Логи). Откат ручной, а признака
    // «всё ещё включён» нет нигде: назначения просто продолжают писаться. Строка при старте — то
    // единственное место, где это заметно раньше, чем по самому логу.
    expect(checkBackendEnv(GOOD).warnings.some(w => /STATEMENT_DEBUG_LOG/.test(w))).toBe(false)
    const on = checkBackendEnv({ ...GOOD, STATEMENT_DEBUG_LOG: '1' })
    expect(on.warnings.some(w => /STATEMENT_DEBUG_LOG/.test(w) && /НАЗНАЧЕНИЯ/.test(w))).toBe(true)
    // Любое другое значение — выключено (совпадает с `=== '1'` в воркере); иначе предупреждение
    // орало бы на стендах, где переменная просто объявлена нулём.
    for (const v of ['0', 'true', 'yes', '']) {
      expect(checkBackendEnv({ ...GOOD, STATEMENT_DEBUG_LOG: v }).warnings.some(w => /STATEMENT_DEBUG_LOG/.test(w))).toBe(false)
    }
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
    // Матчим по СУТИ сообщения (`ключ подписи cookie`), а не по подстроке `SESSION_SECRET`:
    // имя переменной упоминается и в соседней ошибке про незаданный пароль, и широкая проверка
    // ловила бы её тоже — тест краснел бы на совершенно другом правиле.
    const lockoutError = (env: Record<string, string | undefined>) =>
      checkBackendEnv(env).errors.some(e => e.includes('ключ подписи cookie'))
    expect(lockoutError({ ...GOOD, NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw', SESSION_SECRET: 'K' })).toBe(false)
    expect(lockoutError({ ...GOOD, NODE_ENV: 'development', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })).toBe(false)
    expect(lockoutError({ ...GOOD, NODE_ENV: 'production' })).toBe(false)
  })

  // Инцидент на проде: бэкенд крутился без пароля оператора, зона была fail-OPEN, и наружу
  // отдавались `member_id` всех установленных порталов. Теперь зона fail-closed, а недостающий
  // пароль — ошибка старта, а не молчание.
  it('в проде без пароля оператора — ошибка (зона закрыта, деплой недонастроен)', () => {
    const r = checkBackendEnv({ ...GOOD, NODE_ENV: 'production' })
    expect(r.errors.some(e => e.includes('PUBLIC_PAGE_BASIC_AUTH_PASS'))).toBe(true)
  })

  it('вне прода отсутствие пароля ошибкой не считается — там зона открыта осознанно', () => {
    const r = checkBackendEnv({ ...GOOD, NODE_ENV: 'development' })
    expect(r.errors.some(e => e.includes('PUBLIC_PAGE_BASIC_AUTH_PASS'))).toBe(false)
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

  // Ловушка cutover'а: переменные независимы, перевели одну внутрь сети — вторая осталась снаружи
  // по недосмотру. Предупреждаем именно про ПОЛОВИНЧАТЫЙ переезд, а не про сам факт разных адресов.
  it('половинчатый переезд на шлюз — предупреждение', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: GW, PRIOR_OAUTH_TOKEN_URL: `${BANK}/oauth2/token`, PRIOR_OAUTH_AUTHORIZE_BASE: BANK }, /внутрь сети/)).toBe(true)
  })

  // ⚠ Разные ПУБЛИЧНЫЕ адреса — законная конфигурация: банк разносит API, и BY-крипто требуется
  // серверу авторизации, а не ресурсному API. Предупреждать здесь значило бы приучать оператора
  // пролистывать предупреждения.
  it('разные публичные хосты у токена и ресурсов — тишина', () => {
    expect(warns({ PRIOR_OAUTH_API_BASE: BANK, PRIOR_OAUTH_TOKEN_URL: 'https://sso.priorbank.by:9544/oauth2/token', PRIOR_OAUTH_AUTHORIZE_BASE: BANK }, /внутрь сети/)).toBe(false)
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

describe('Хостовой набор корней (NODE_EXTRA_CA_CERTS)', () => {
  // Почему это вообще проверяется. Node возит СВОЙ список корней, и он не совпадает с системным:
  // боевой эндпоинт Альфа-Банка выстраивает цепочку до корня `AAA Certificate Services`, которого
  // во встроенном списке нет. Замерено вживую 2026-08-14 — `curl` и `openssl` с той же машины
  // проходили, а каждый вызов из контейнера умирал на SELF_SIGNED_CERT_IN_CHAIN. Развёртывание
  // отвечает на это пробросом хостового набора; здесь сторожим не сам факт, а самое опасное
  // состояние — «переменная задана, файла нет».
  const readable = (ok: boolean) => ({ caBundleReadable: () => ok })

  it('молчит, когда переменная не задана — большинству развёртываний она не нужна', () => {
    expect(checkBackendEnv(GOOD, readable(false)).warnings).toEqual([])
  })

  it('молчит, когда файл на месте', () => {
    const env = { ...GOOD, NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/host-ca-bundle.crt' }
    expect(checkBackendEnv(env, readable(true)).warnings).toEqual([])
  })

  it('предупреждает, когда задана, но файла нет — Node молча уйдёт на встроенные корни', () => {
    // Это не теоретический случай: docker при отсутствии хостового пути создаёт на его месте
    // КАТАЛОГ, Node такой «файл» игнорирует и продолжает работать — а симптом всплывает позже
    // и в другом месте, как «конкретный банк не отвечает».
    const env = { ...GOOD, NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/host-ca-bundle.crt' }
    const w = checkBackendEnv(env, readable(false)).warnings
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('NODE_EXTRA_CA_CERTS')
    expect(w[0]).toContain('SELF_SIGNED_CERT_IN_CHAIN')
    expect(checkBackendEnv(env, readable(false)).errors).toEqual([])
  })

  it('без пробы не гадает — чистое ядро не лезет в файловую систему само', () => {
    const env = { ...GOOD, NODE_EXTRA_CA_CERTS: '/nope' }
    expect(checkBackendEnv(env).warnings).toEqual([])
  })
})

describe('LOG_LEVEL (#529)', () => {
  // ⚠ Прецедент задан соседним STATEMENT_OP_LOG: за настройку, которая молча уносит диагностику,
  // предупреждаем на старте. `ERROR` опаснее — он забирает и `[fetch]`, и итог прогона, то есть
  // ровно те строки, которые рантбук велит читать в аварию.
  it('ERROR и выше предупреждают — иначе пропажу строк не с чем связать', () => {
    for (const level of ['ERROR', 'error', ' Critical ']) {
      const out = checkBackendEnv({ ...GOOD, LOG_LEVEL: level })
      expect(out.warnings.some(w => w.includes('LOG_LEVEL')), `${level} прошёл молча`).toBe(true)
    }
  })

  it('INFO и DEBUG молчат — это рабочие значения', () => {
    for (const level of ['INFO', 'debug', '', undefined]) {
      const out = checkBackendEnv({ ...GOOD, LOG_LEVEL: level })
      expect(out.warnings.some(w => w.includes('LOG_LEVEL')), `${level} шумит зря`).toBe(false)
    }
  })
})

describe('#449: PRIOR_OAUTH_REQUEST_TYP', () => {
  // ⚠ Заведён потому, что это была ЕДИНСТВЕННАЯ ветка `warnings.push` в `envCheck`, не покрытая
  // тестом — у всех соседних он есть. Сам предикат `isPriorRequestTypInvalid` проверяется в
  // `priorJwt.test.ts`, но ПРОВОДКА («`checkBackendEnv` реально его зовёт и реально пушит текст»)
  // не проверялась нигде: переименование импорта или опечатка в имени переменной сломали бы
  // предупреждение молча. А молчит оно ровно в том случае, ради которого заведено — когда оператор
  // считает усиление включённым, а оно отброшено.
  it('битое значение даёт предупреждение на старте', () => {
    const w = checkBackendEnv({ ...GOOD, PRIOR_OAUTH_REQUEST_TYP: 'has space' }).warnings
    expect(w.some(x => /PRIOR_OAUTH_REQUEST_TYP/.test(x))).toBe(true)
    // Текст обязан сказать, что значение ПРОИГНОРИРОВАНО, — иначе оператор решит, что всё в силе.
    expect(w.some(x => /ПРОИГНОРИРОВАН/i.test(x))).toBe(true)
  })

  it('верное значение и отсутствие значения молчат одинаково', () => {
    for (const v of [undefined, '', 'oauth-authz-req+jwt', 'application/jwt']) {
      const env = { ...GOOD, ...(v === undefined ? {} : { PRIOR_OAUTH_REQUEST_TYP: v }) }
      expect(checkBackendEnv(env).warnings.some(x => /PRIOR_OAUTH_REQUEST_TYP/.test(x))).toBe(false)
    }
  })
})
