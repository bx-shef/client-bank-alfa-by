import { describe, expect, it } from 'vitest'
import { REPO_URL, commitUrl, healthInfo, resolveRepoUrl, shortSha } from '~/utils/build'

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
    expect(commitUrl('abc123')).toBe(`${REPO_URL}/commit/abc123`)
  })

  it('/api/health отдаёт ссылку того же репозитория', () => {
    expect(healthInfo('abc123', '2026-09-12T00:00:00.000Z', 'https://github.com/client/app').commitUrl)
      .toBe('https://github.com/client/app/commit/abc123')
  })
})
