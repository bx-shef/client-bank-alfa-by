import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTHOR_NAME, DEFAULT_AUTHOR_URL, REPO_URL, commitUrl, healthInfo, resolveAuthor, resolveRepoUrl, shortSha } from '~/utils/build'
import { LANDING_PUBLISHER } from '~/utils/seo'

describe('shortSha', () => {
  it('takes the first 7 chars', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
  })
  it('is empty for missing/blank', () => {
    expect(shortSha('')).toBe('')
    expect(shortSha(undefined)).toBe('')
    expect(shortSha(null)).toBe('')
  })
})

describe('commitUrl', () => {
  it('links to the exact commit when a SHA is given', () => {
    expect(commitUrl('abc123')).toBe(`${REPO_URL}/commit/abc123`)
  })
  it('falls back to the repo root when unknown', () => {
    expect(commitUrl('')).toBe(REPO_URL)
    expect(commitUrl(undefined)).toBe(REPO_URL)
  })
})

describe('healthInfo', () => {
  const now = '2026-07-01T10:00:00.000Z'
  it('reports status ok, the time, and the build commit + link', () => {
    expect(healthInfo('abc123', now)).toEqual({
      status: 'ok',
      time: now,
      commit: 'abc123',
      commitUrl: `${REPO_URL}/commit/abc123`
    })
  })
  it('falls back to "dev" and the repo root when no SHA is injected', () => {
    expect(healthInfo('', now)).toEqual({ status: 'ok', time: now, commit: 'dev', commitUrl: REPO_URL })
    expect(healthInfo(undefined, now)).toEqual({ status: 'ok', time: now, commit: 'dev', commitUrl: REPO_URL })
  })
})

describe('репозиторий сборки (клон у клиента)', () => {
  // ⚠ Клиентская установка разворачивается из КЛОНА в его репозиторий: без своего адреса подпись
  // «сборка <sha>» вела бы в репозиторий апстрима, куда у клиента доступа нет.
  it('свой адрес используется как есть, хвостовой слэш снимается', () => {
    expect(resolveRepoUrl('https://github.com/client/app')).toBe('https://github.com/client/app')
    expect(resolveRepoUrl('https://github.com/client/app/')).toBe('https://github.com/client/app')
    expect(commitUrl('abc123', 'https://github.com/client/app'))
      .toBe('https://github.com/client/app/commit/abc123')
  })

  // ⚠ Значение приходит переменной сборки и попадает в `href` на КАЖДОМ экране: пустое или кривое
  // дало бы битую ссылку в подвале вместо честной нашей. Поэтому не подставляем, а проверяем.
  it('пустое и негодное ⇒ апстрим, а не битая ссылка', () => {
    for (const bad of ['', '   ', 'github.com/x/y', 'http://github.com/x/y', 'https://github.com', 'javascript:alert(1)']) {
      expect(resolveRepoUrl(bad), bad).toBe(REPO_URL)
    }
    expect(resolveRepoUrl(undefined)).toBe(REPO_URL)
  })

  it('адрес с логином перед хостом ⇒ апстрим: он ведёт на чужой хост', () => {
    // `https://github.com@evil.example/…` — валидный адрес с хостом `evil.example`; прежняя
    // регулярка «https, потом хост» его пропускала в подпись «сборка <sha>» на каждом экране.
    expect(resolveRepoUrl('https://github.com@evil.example/client/app')).toBe(REPO_URL)
    expect(resolveRepoUrl('https://user:pass@github.com/client/app')).toBe(REPO_URL)
    expect(resolveRepoUrl('https://github.com/client app')).toBe(REPO_URL)
    expect(commitUrl('abc123')).toBe(`${REPO_URL}/commit/abc123`)
  })

  it('/api/health отдаёт ссылку того же репозитория', () => {
    expect(healthInfo('abc123', '2026-09-12T00:00:00.000Z', 'https://github.com/client/app').commitUrl)
      .toBe('https://github.com/client/app/commit/abc123')
  })
})

describe('resolveAuthor (#758)', () => {
  it('по умолчанию — «ИП Шевчик И. С.» со ссылкой на оффер; имя то же, что у издателя лендинга', () => {
    expect(DEFAULT_AUTHOR_NAME).toBe('ИП Шевчик И. С.')
    expect(DEFAULT_AUTHOR_URL).toBe('https://offer.bx-shef.by/?ref=bank-import')
    // Две копии строки уже расходились («И.С.» против «И. С.») — поэтому одна.
    expect(LANDING_PUBLISHER).toBe(DEFAULT_AUTHOR_NAME)
  })

  it('пустые значения (так их отдаёт незаданная переменная сборки) — умолчание целиком', () => {
    // ⚠ Пустая переменная перекрывает умолчание nuxt.config — замерено сборкой.
    for (const v of ['', '   ', undefined, null]) {
      expect(resolveAuthor(v, v)).toEqual({ name: DEFAULT_AUTHOR_NAME, url: DEFAULT_AUTHOR_URL })
    }
  })

  it('заданные значения — как есть', () => {
    expect(resolveAuthor('ООО Ромашка', 'https://romashka.example.by/'))
      .toEqual({ name: 'ООО Ромашка', url: 'https://romashka.example.by/' })
  })

  it('своё имя без адреса — без ссылки, а не со ссылкой на наш оффер', () => {
    expect(resolveAuthor('ООО Ромашка', '')).toEqual({ name: 'ООО Ромашка', url: '' })
  })

  it('без имени свой адрес не берётся: наше имя не ведёт на чужой сайт', () => {
    expect(resolveAuthor('', 'https://romashka.example.by/'))
      .toEqual({ name: DEFAULT_AUTHOR_NAME, url: DEFAULT_AUTHOR_URL })
  })

  it('наше имя без адреса — с нашей ссылкой; с адресом — с заданной', () => {
    expect(resolveAuthor(DEFAULT_AUTHOR_NAME, '')).toEqual({ name: DEFAULT_AUTHOR_NAME, url: DEFAULT_AUTHOR_URL })
    expect(resolveAuthor(DEFAULT_AUTHOR_NAME, 'https://bx-shef.by/'))
      .toEqual({ name: DEFAULT_AUTHOR_NAME, url: 'https://bx-shef.by/' })
  })

  it('адрес только https и без логина: иное в href не попадает', () => {
    expect(resolveAuthor('ООО Ромашка', 'javascript:alert(1)').url).toBe('')
    expect(resolveAuthor('ООО Ромашка', 'http://romashka.example.by').url).toBe('')
    // Валидный адрес, который ведёт на `evil.example`, а не на `romashka.example.by`.
    expect(resolveAuthor('ООО Ромашка', 'https://romashka.example.by@evil.example/').url).toBe('')
    expect(resolveAuthor('ООО Ромашка', 'https://').url).toBe('')
  })

  it('схема в любом регистре — тот же https', () => {
    expect(resolveAuthor('ООО Ромашка', 'HTTPS://Romashka.Example.by/a').url).toBe('https://romashka.example.by/a')
  })

  it('число или булево из destr не роняет подвал', () => {
    // `NUXT_PUBLIC_AUTHOR_NAME=2026` сборка отдаёт числом, а `.trim()` у числа — TypeError.
    expect(resolveAuthor(2026, true)).toEqual({ name: '2026', url: '' })
  })
})
