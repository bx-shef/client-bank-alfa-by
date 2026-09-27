import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { destr } from 'destr'
import { DEFAULT_METRIKA_ID, resolveMetrikaId } from '~/utils/metrika'

// Настоящий `nuxt.config.ts`, загруженный под разными переменными окружения.
//
// ⚠ Оба дефекта #758 жили там, где исходник не видно глазами: пустая переменная сборки затирала
// непустое умолчание `runtimeConfig.public` (на проде с #701 пропали форма заявок и цели Метрики),
// а сниппет Метрики решает, попадёт ли НАШ счётчик с записью сессий в статику клона. Поэтому здесь
// не читается текст конфига, а вычисляется сам конфиг.

interface LoadedConfig {
  app: { head: { script: { innerHTML: string }[], noscript: { innerHTML: string }[] } }
  runtimeConfig: { public: Record<string, unknown> }
}

/** Имя переменной, которым Nuxt задаёт ключ `runtimeConfig.public` (camelCase → SCREAMING_SNAKE). */
const envNameFor = (key: string) => `NUXT_PUBLIC_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

// Путь — переменной, а не литералом: иначе проверка типов тестов потянула бы в свой проход сам
// конфиг, а глобала `defineNuxtConfig` там нет (его даёт только Nuxt). Здесь он подменён.
const CONFIG_MODULE = '../nuxt.config'

async function loadConfig(env: Record<string, string | undefined> = {}): Promise<LoadedConfig> {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (c: unknown) => c)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const mod = await import(/* @vite-ignore */ CONFIG_MODULE) as { default: unknown }
  return mod.default as LoadedConfig
}

/** Все переменные `runtimeConfig.public` сняты, затем заданы переданные. */
async function loadClean(env: Record<string, string | undefined> = {}): Promise<LoadedConfig> {
  const keys = Object.keys((await loadConfig()).runtimeConfig.public)
  const unset = Object.fromEntries(keys.map(k => [envNameFor(k), undefined]))
  return loadConfig({ ...unset, ...env })
}

const snippetIds = (c: LoadedConfig) => c.app.head.script.map(s => /ym\((\d+),'init'/.exec(s.innerHTML)?.[1])

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('умолчания runtimeConfig.public', () => {
  // Пустая переменная сборки (её отдаёт Dockerfile, когда переменная репозитория не задана)
  // ПЕРЕКРЫВАЕТ умолчание конфига. Пустое умолчание равно пустой переменной по построению:
  // затирать нечего. Запасные значения живут в функциях, которые конфиг читают.
  it('без переменных окружения каждый ключ пуст', async () => {
    const pub = (await loadClean()).runtimeConfig.public
    expect(Object.keys(pub).length).toBeGreaterThanOrEqual(8)
    for (const [key, value] of Object.entries(pub)) {
      expect(value, `${key}: непустое умолчание пустая переменная сборки затрёт`).toBe('')
    }
  })
})

describe('сниппет Метрики в статике', () => {
  it('наш прод (переменные пусты) — наш счётчик', async () => {
    const c = await loadClean({ NUXT_PUBLIC_METRIKA_ID: '', NUXT_PUBLIC_LOCAL_MODE: '' })
    expect(snippetIds(c)).toEqual([DEFAULT_METRIKA_ID])
    expect(c.app.head.noscript[0]!.innerHTML).toContain(`watch/${DEFAULT_METRIKA_ID}`)
  })

  it('клон (LOCAL_MODE=1, счётчик не задан) — сниппета нет вовсе', async () => {
    for (const local of ['1', 'true', '"1"', ' yes ']) {
      const c = await loadClean({ NUXT_PUBLIC_METRIKA_ID: '', NUXT_PUBLIC_LOCAL_MODE: local })
      expect(c.app.head.script, local).toEqual([])
      expect(c.app.head.noscript, local).toEqual([])
    }
  })

  it('свой счётчик клона вставляется и в локальном режиме', async () => {
    const c = await loadClean({ NUXT_PUBLIC_METRIKA_ID: '12345', NUXT_PUBLIC_LOCAL_MODE: '1' })
    expect(snippetIds(c)).toEqual(['12345'])
  })

  it('ноль — сниппета нет', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = await loadClean({ NUXT_PUBLIC_METRIKA_ID: '0' })
    expect(c.app.head.script).toEqual([])
  })

  // Цели читают id из конфига, куда Nitro кладёт переменную через `destr`. Сниппет обязан видеть
  // то же значение — иначе инициализирован один счётчик, а цели уходят на другой.
  it('id в сниппете равен тому, на который пойдут цели', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of ['109399587', '1e5', '1.0', ' 777 ', '12a3']) {
      const c = await loadClean({ NUXT_PUBLIC_METRIKA_ID: raw, NUXT_PUBLIC_LOCAL_MODE: '' })
      const goals = resolveMetrikaId(destr(raw), false)
      expect(snippetIds(c), raw).toEqual(goals ? [goals] : [])
    }
  })
})

// Пустое умолчание работает, только пока каждый читатель идёт через функцию с запасным значением.
// Прочитай компонент сырое `config.public.metrikaId`, как `BriefForm` до #758, — и на проде он
// получит пустую строку и молча не сделает ничего. Список читателей закрыт.
describe('сырые значения этих ключей читают только функции с запасным значением', () => {
  const KEYS = /\b(?:metrikaId|b24FormId|b24FormSecret|b24FormScriptUrl|authorName|authorUrl)\b/
  const ALLOWED = [
    'app/components/BriefForm.vue', // → resolveB24Form
    'app/components/BuildFooter.vue', // → resolveAuthor
    'app/composables/useMetrikaGoal.ts' // → resolveMetrikaId
  ]

  function sources(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...sources(p))
      else if (/\.(?:ts|vue)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('конфиг с этими ключами читают ровно известные файлы', () => {
    const readers = [...sources('app'), ...sources('server')]
      .filter(f => /useRuntimeConfig\(/.test(readFileSync(f, 'utf8')) && KEYS.test(readFileSync(f, 'utf8')))
      .sort()
    expect(readers).toEqual([...ALLOWED].sort())
  })

  it.each(ALLOWED)('%s читает через функцию с запасным значением', (file) => {
    expect(readFileSync(file, 'utf8')).toMatch(/\bresolve(?:B24Form|Author|MetrikaId)\(/)
  })
})
