import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Кто может звать какой маршрут (#531, разбор — `docs/PERMISSIONS.md` §1).
 *
 * ⚠ Гард заведён потому, что разбор прав опирается на ТАБЛИЦУ, а таблица в документе — это
 * утверждение о коде, которое расходится с ним молча. Здесь важна КАЖДАЯ сторона списка:
 * пропажа админ-гейта открывает мутацию портала любому сотруднику, а его появление там, где его
 * не было, тихо ломает рабочий путь бухгалтера (загрузку выписки делает не администратор).
 *
 * ⚠ Список ЗАКРЫТЫЙ: новый маршрут обязан быть классифицирован явно. «Забыли решить, кто может» —
 * это и есть способ, которым приложение обзаводится дырой.
 */
const API = join(process.cwd(), 'server/api')

/** Маршруты, требующие администратора портала. */
const ADMIN_ONLY = [
  // ⚠ Оба маршрута стирания — админские (#576 п.4), и довод сильнее, чем у банковских: действие
  // НЕОБРАТИМО и затрагивает CRM всего портала, а не того, кто нажал. Подсчёт тоже админский,
  // потому что он раскрывает, сколько дел приложение записало на портале.
  'activities/erasable.get.ts',
  'activities/erase.post.ts',
  'bank/accounts.get.ts',
  'bank/connect.post.ts',
  'bank/disconnect.post.ts',
  'bank/matrix.get.ts',
  // ⚠ Пауза автоопроса — админская (#576) по тому же доводу, что подключение и отключение: банк
  // привязан ко ВСЕМУ порталу, и остановка импорта затрагивает всех его сотрудников, а не того,
  // кто нажал. Бухгалтеру, у которого «перестала приходить выписка», нечего противопоставить
  // коллеге, который её тихо поставил на паузу.
  'bank/pause.post.ts',
  'bank/set-account.post.ts',
  'distribution/ledger.get.ts',
  'distribution/provision.post.ts',
  'distribution/recompute.post.ts',
  'poll-now.post.ts',
  'setup-status.get.ts'
]

/**
 * Маршруты, доступные ЛЮБОМУ пользователю портала с фрейм-токеном.
 *
 * ⚠ `import.post.ts` в этом списке — не упущение, а зафиксированное состояние: загрузить выписку
 * и тем самым создать дела в CRM может любой сотрудник, и пишет приложение при этом на СВОЁМ
 * сохранённом токене, то есть права CRM самого сотрудника не применяются (`PERMISSIONS.md` §1).
 * Строка стоит здесь, чтобы это решение было видно, а не унаследовано.
 */
const ANY_PORTAL_USER = [
  'app-rating.get.ts',
  'app-rating.post.ts',
  'chat-search.get.ts',
  'chat-settings.get.ts',
  'feedback.get.ts',
  'feedback.post.ts',
  'import.post.ts',
  'import/batch.get.ts',
  'import/metrics.get.ts',
  'import/status.get.ts'
]

/** Маршруты вне фрейм-модели: вебхуки портала, здоровье, сессия оператора. */
const NOT_FRAME = [
  'b24/', // вебхуки портала: авторизация — `application_token`, не фрейм-токен
  'bank/callback.get.ts', // возврат из банка: авторизация — подписанный state
  'health.get.ts',
  'ready.get.ts',
  'auth/', // вход ОПЕРАТОРА в служебную зону (см. AUTH.md) — другая ось прав
  'ops/', // операторские экраны: наша сессионная кука
  'queues.get.ts', // то же, но исторический путь без префикса
  // ⚠ Эти два — admin-only, но проверку делает не роут, а чистый хендлер общего доступа
  // (`handleWriteSetting`/`handleMetricsReset` через `verifyFrameAdmin`). Гард смотрит на текст
  // файла роута, поэтому здесь он ослеп бы; их admin-гейт закреплён своими тестами.
  'chat-settings.post.ts',
  'import/metrics-reset.post.ts'
]

function routes(): string[] {
  return readdirSync(API, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts'))
    .map(f => f.split('\\').join('/'))
}

describe('кто может звать маршруты приложения (#531)', () => {
  it('каждый маршрут классифицирован явно', () => {
    const known = new Set([...ADMIN_ONLY, ...ANY_PORTAL_USER])
    const unclassified = routes()
      .filter(r => !known.has(r))
      .filter(r => !NOT_FRAME.some(p => r.startsWith(p) || r === p))
    expect(unclassified, 'новый маршрут без решения «кто может»').toEqual([])
  })

  it('у каждого админского маршрута есть тест, проверяющий отказ не-админу', () => {
    // ⚠ САМ гейт этот файл не проверяет, и это осознанное сужение. Первая редакция сверяла текст
    // роута — и провалилась в обе стороны сразу (замерено мутацией): мутация «оставить в роуте
    // `isAdmin: true`, а отказ из чистого хендлера убрать» проходила ЗЕЛЁНОЙ, потому что настоящий
    // 403 живёт в хендлере; а обход импортов, добавленный ради этого, покраснел на ВЕРНОМ коде —
    // маршруты «для всех» тянут общие утилиты, где слово `isAdmin` есть для чужих нужд.
    // Текстовый гард здесь не может быть одновременно полным и точным.
    //
    // Поэтому проверяется то, что проверяемо: у каждого админского маршрута есть ПОВЕДЕНЧЕСКИЙ
    // тест, где не-админ получает 403. Он и есть авторитет; этот файл лишь не даёт маршруту
    // остаться совсем без него.
    const handlers: Record<string, string> = {
      'activities/erasable.get.ts': 'eraseRequest',
      'activities/erase.post.ts': 'eraseRequest',
      'bank/accounts.get.ts': 'bankAccounts',
      'bank/connect.post.ts': 'bankConnectStart',
      'bank/disconnect.post.ts': 'bankAccounts',
      'bank/matrix.get.ts': 'bankMatrix',
      'bank/pause.post.ts': 'bankAccounts',
      'bank/set-account.post.ts': 'bankAccounts',
      'distribution/ledger.get.ts': 'ledgerRequest',
      'distribution/provision.post.ts': 'provisionRequest',
      'distribution/recompute.post.ts': 'recomputeRequest',
      'poll-now.post.ts': 'pollNow',
      'setup-status.get.ts': 'setupStatus'
    }
    // Список хендлеров закрыт вместе со списком маршрутов: новый админский маршрут без записи
    // здесь не пройдёт первый тест этого файла, а с записью — обязан принести и тест на отказ.
    expect(Object.keys(handlers).sort()).toEqual([...ADMIN_ONLY].sort())

    const suites = readdirSync(join(process.cwd(), 'tests'))
      .filter(f => f.endsWith('.test.ts') && f !== 'adminGatedRoutes.test.ts')
      .map(f => readFileSync(join(process.cwd(), 'tests', f), 'utf8'))

    const offenders = Object.entries(handlers)
      .filter(([, handler]) => !suites.some(src => src.includes(handler) && src.includes('403')))
      .map(([route]) => route)
    expect(offenders, 'админский маршрут без теста на отказ не-админу').toEqual([])
  })

  it('таблица в разборе прав перечисляет те же маршруты', () => {
    // ⚠ Документ — это утверждение о коде; без сверки он разойдётся с ним молча, а именно на него
    // будут ссылаться, решая, что менять.
    const doc = readFileSync(join(process.cwd(), 'docs/PERMISSIONS.md'), 'utf8')
    for (const marker of ['/api/chat-settings', '/api/import', '/api/bank/', '/api/setup-status']) {
      expect(doc, `в разборе прав не упомянут ${marker}`).toContain(marker)
    }
  })
})
