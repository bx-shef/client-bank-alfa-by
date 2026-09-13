import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Гард: КАЖДЫЙ ключ `runtimeConfig.public` должен доезжать до сборки.
//
// ⚠ Заведён по живому промаху (#19 / PR #698): `NUXT_PUBLIC_REPO_URL` появилась в `nuxt.config.ts`
// и в `.env.example`, но не в `Dockerfile` — и не делала НИЧЕГО. Симптом тихий вдвойне: сборка
// зелёная, переменная «задана», а у клона подпись «сборка <sha>» по-прежнему вела в чужой
// репозиторий. Ни один тест этого не видел, потому что все они смотрят на код, а не на то, доехало
// ли значение до `nuxt generate`. Тем же способом молча не работали `metrikaId` и `b24Form*` —
// то есть промах был не единичным, а классом.
//
// Правило одностороннее: объявлено больше, чем читается (`NUXT_PUBLIC_BUILD_DATE` нужен
// `seo-files.mjs`, а не `runtimeConfig`) — это нормально. Нельзя обратное: ключ есть, а передать
// его нечем.
//
// ⚠ Разбор текстовый — YAML-парсера в зависимостях нет; та же форма, что у `ciWorkflowGuard`.
// Каждое утверждение опровергнуто мутацией соответствующего файла — 5 из 5 (снятый `ARG`, снятый
// `ENV` во второй стадии, снятая строка compose, снятая строка build-args CI, сломанный разбор
// ключей).

const nuxtConfig = readFileSync('nuxt.config.ts', 'utf8')
const dockerfile = readFileSync('Dockerfile', 'utf8')
const compose = readFileSync('docker-compose.yml', 'utf8')
const ci = readFileSync('.github/workflows/ci.yml', 'utf8')

/** Ключи блока `runtimeConfig.public` из `nuxt.config.ts`. */
function publicKeys(): string[] {
  const start = nuxtConfig.indexOf('    public: {')
  expect(start, 'блок runtimeConfig.public не найден — гард смотрит не туда').toBeGreaterThan(-1)
  const end = nuxtConfig.indexOf('\n    }\n', start)
  expect(end, 'конец блока runtimeConfig.public не найден').toBeGreaterThan(start)
  const body = nuxtConfig.slice(start, end)
  const keys = [...body.matchAll(/^ {6}(\w+)\s*[:,]/gm)].map(m => m[1]!)
  return [...new Set(keys)]
}

/**
 * Имя переменной окружения, которым Nuxt задаёт ключ `runtimeConfig.public`.
 * `b24AppCode` → `NUXT_PUBLIC_B24_APP_CODE` (camelCase → SCREAMING_SNAKE).
 */
function envNameFor(key: string): string {
  return `NUXT_PUBLIC_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`
}

/** Тело builder-стадии Dockerfile: от `FROM … AS <stage>` до следующего `FROM`. */
function stageBody(stage: string): string {
  const re = new RegExp(`^FROM .*AS ${stage}$`, 'm')
  const m = re.exec(dockerfile)
  expect(m, `стадия ${stage} не найдена в Dockerfile`).not.toBeNull()
  const from = m!.index
  const next = dockerfile.indexOf('\nFROM ', from + 1)
  return dockerfile.slice(from, next === -1 ? undefined : next)
}

/** Блок `build-args:` джобы деплоя (та, что пушит образы в GHCR). */
function deployBuildArgs(): string {
  const start = ci.indexOf('build-args: |')
  expect(start, 'блок build-args в ci.yml не найден').toBeGreaterThan(-1)
  const end = ci.indexOf('cache-from:', start)
  return ci.slice(start, end === -1 ? undefined : end)
}

describe('переменные NUXT_PUBLIC_* доезжают до сборки', () => {
  const keys = publicKeys()

  // Сам список — проверка того, что разбор вообще работает: пустой или куцый набор прошёл бы все
  // остальные проверки зелёным, ничего не проверив.
  it('ключи runtimeConfig.public прочитаны', () => {
    expect(keys.length).toBeGreaterThanOrEqual(8)
    expect(keys).toContain('b24AppCode')
    expect(keys).toContain('repoUrl')
  })

  it.each(['builder', 'builder-server'])('стадия %s объявляет ARG и ENV для каждого ключа', (stage) => {
    const body = stageBody(stage)
    for (const key of keys) {
      const env = envNameFor(key)
      expect(body, `${stage}: нет ARG ${env}`).toContain(`ARG ${env}\n`)
      expect(body, `${stage}: нет ENV ${env}`).toContain(`ENV ${env}=$${env}\n`)
    }
  })

  // ⚠ Оба сервиса, а не один: статика и Nitro пререндерят ОДНИ И ТЕ ЖЕ страницы, и переменная,
  // переданная только одному, дала бы два образа с разным содержимым одной страницы.
  it('docker-compose передаёт каждую переменную обоим сервисам', () => {
    const appArgs = compose.slice(compose.indexOf('  app:'), compose.indexOf('  backend:'))
    const backendArgs = compose.slice(compose.indexOf('  backend:'), compose.indexOf('environment:', compose.indexOf('  backend:')))
    for (const key of keys) {
      const env = envNameFor(key)
      expect(appArgs, `app: нет ${env}`).toContain(`${env}: \${${env}:-}`)
      expect(backendArgs, `backend: нет ${env}`).toContain(`${env}: \${${env}:-}`)
    }
  })

  it('CI передаёт каждую переменную в build-args', () => {
    const args = deployBuildArgs()
    for (const key of keys) {
      expect(args, `ci.yml: нет ${envNameFor(key)}`).toContain(`${envNameFor(key)}=`)
    }
  })
})

describe('имя переменной выводится по правилу Nuxt', () => {
  it('camelCase раскладывается в SCREAMING_SNAKE', () => {
    expect(envNameFor('siteUrl')).toBe('NUXT_PUBLIC_SITE_URL')
    expect(envNameFor('b24AppCode')).toBe('NUXT_PUBLIC_B24_APP_CODE')
    expect(envNameFor('b24FormScriptUrl')).toBe('NUXT_PUBLIC_B24_FORM_SCRIPT_URL')
    expect(envNameFor('metrikaId')).toBe('NUXT_PUBLIC_METRIKA_ID')
  })
})
