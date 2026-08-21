import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ⚠ Юнит-тесты не типизировались НИЧЕМ (#527), и это не безобидно: тест проверяет поведение, а тип
// описывает контракт с production-кодом, и разъезжаются они молча. Живой пример, ради которого
// issue и заведена, — мок DI-порта, который ничего не возвращал (`Promise<void>` вместо
// `Promise<boolean>`): пока код результат не смотрел, разницы не было, а как только стал —
// молчаливый `undefined` начал означать «портал удалён», то есть ровно обратное тому, что
// утверждали три теста. Мок, чей неверный тип не меняет наблюдаемого результата, прошёл бы
// незамеченным и оставил зелёный тест, ничего не проверяющий.
//
// ⚠ Проверка структурная, а не «прогнали и всё хорошо»: сам прогон типов живёт в `pnpm typecheck`,
// и потерять его можно ровно одним способом — тихо сузив охват в конфиге. Именно это здесь и
// стережётся.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('node-зона покрыта typecheck (#527/#542)', () => {
  const cfg = JSON.parse(read('tsconfig.node.json')) as {
    extends: string
    include: string[]
    exclude: string[]
    compilerOptions?: Record<string, unknown>
  }

  it('охват включает всё, что исполняется в node вне Nitro-приложения', () => {
    // ⚠ `scripts/**` добавлены не для полноты (#542): часть из них ходит в БОЕВЫЕ порталы с
    // `--apply`, а запускаются они через `--experimental-strip-types` — это ВЫРЕЗАНИЕ типов, без
    // всякой проверки. Замер при включении дал пять расхождений контракта, включая `number` там,
    // где функция ждёт `string`.
    expect(cfg.include).toContain('./tests/**/*')
    expect(cfg.include).toContain('./scripts/**/*.ts')
    expect(cfg.include).toContain('./vitest.config.ts')
  })

  it('исключены ровно те два каталога, у которых ЕСТЬ свой проход', () => {
    // ⚠ `tests/nuxt/**` покрыт app-проходом (он в `include` корневого tsconfig), `tests/visual/**` —
    // это Playwright со своим окружением и своим `lib`. Всё остальное исключать нельзя: исключение
    // здесь означает «эти тесты снова никто не типизирует», а именно так дефект и появился.
    // ⚠ `tests/visual/**` исключён отсюда, но покрыт СВОИМ проходом (`tsconfig.visual.json`) —
    // ему нужен `lib: DOM` и типы Playwright. Раньше формулировка «Playwright со своим окружением»
    // читалась как «покрыт где-то ещё», а покрыт он не был нигде (#542).
    expect(new Set(cfg.exclude)).toEqual(new Set(['./node_modules', './dist', './tests/nuxt/**', './tests/visual/**']))
  })

  it('послабление ровно одно и оно названо', () => {
    // ⚠ `noUncheckedIndexedAccess` выключен СОЗНАТЕЛЬНО, и это не «чтобы собралось». В production
    // `arr[0]` без проверки — тихий баг, поэтому там строгость нужна. В тесте она не ловит ничего,
    // чего не поймал бы прогон: выход за границу даёт `undefined`, а он роняет сам ассерт.
    //
    // ⚠ Замерено: флаг даёт 56 ошибок, и 50 из них — ОДИН файл (`queuePhase2`), причём даже не
    // индексация массива, а точечное обращение (`calls.crm`) к объекту-сборщику типа
    // `Record<string, unknown[]>`, все ключи которого проставлены тут же при инициализации. То
    // есть это в основном чистый false positive индексной сигнатуры, а не размен риска на
    // удобство. Цена альтернативы — полсотни `!` по ассертам и приученная к нему рука, которая
    // потом пишет то же самое в production. Остальные строгие флаги — без изменений.
    expect(cfg.compilerOptions).toEqual({ noUncheckedIndexedAccess: false })
  })

  it('пути nitro-типов существуют — иначе охват тихо усохнет при апгрейде Nuxt', () => {
    // ⚠ `include` на НЕСУЩЕСТВУЮЩИЙ файл в TypeScript не ошибка — запись просто перестаёт что-либо
    // матчить. Переименуй Nuxt эти два файла, и проход продолжит зеленеть, молча потеряв проверку
    // амбиентных деклараций Nitro. Само `tests/**` от этого не зависит (глоб буквальный и
    // Nuxt-независимый), поэтому цель PR не рушится — но тихую деградацию делаем громкой.
    for (const rel of cfg.include.filter(i => i.includes('.nuxt/types/'))) {
      expect(existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url))), `${rel} не существует`)
        .toBe(true)
    }
  })

  it('наследуется строгий серверный конфиг, а не что-то послабее', () => {
    // ⚠ Вся строгость третьего прохода (`strict` и прочее) приходит ЧЕРЕЗ `extends` — сам файл
    // задаёт только охват и одно послабление. Значит подмена `extends` на конфиг послабее
    // обнулила бы проход, не тронув ни одной проверки ниже. Поймано ревью, а не придумано.
    expect(cfg.extends, 'третий проход перестал наследовать строгий серверный конфиг')
      .toBe('./.nuxt/tsconfig.server.json')
  })

  it('проход подключён к `pnpm typecheck` так, что его провал РОНЯЕТ команду', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const script = pkg.scripts.typecheck ?? ''

    // ⚠ Проверять подстрокой `tsconfig.tests.json` — НЕДОСТАТОЧНО, и это доказано на живом прогоне:
    // `... && (vue-tsc -p tsconfig.tests.json --noEmit || true)` оставляет подстроку на месте,
    // guard зеленеет, а `pnpm typecheck` возвращает 0 ДАЖЕ при настоящей ошибке типа в тестах —
    // CI смотрит на код возврата, а не на текст. То есть проверка текста ловила бы ровно всё,
    // кроме единственного способа сломать проход по-настоящему.
    //
    // Поэтому разбираем цепочку: сегмент с нашим конфигом обязан быть САМОСТОЯТЕЛЬНОЙ командой,
    // соединённой через `&&`, без скобок, `|| true`, `;` и комментариев.
    const segments = script.split('&&').map(x => x.trim())
    for (const cfgFile of ['tsconfig.node.json', 'tsconfig.visual.json']) {
      const ours = segments.filter(x => x.includes(cfgFile))
      expect(ours.length, `${cfgFile}: проход не в \`pnpm typecheck\` — CI его не запустит`).toBe(1)
      expect(
        ours[0],
        `${cfgFile}: провал прохода проглатывается — команда вернёт 0 при настоящей ошибке типа`
      ).toBe(`vue-tsc -p ${cfgFile} --noEmit`)
    }

    // И ни один ДРУГОЙ проход не должен быть заглушён тем же приёмом — иначе «зелёный typecheck»
    // перестаёт значить «типы в порядке» целиком, а не только для тестов.
    for (const seg of segments) {
      expect(seg, `сегмент «${seg}» глушит свой код возврата`).not.toMatch(/\|\||;|#/)
    }
  })

  // ⚠ Честная граница охвата: `tests/visual/**` (Playwright) не проверяется типами НИЧЕМ — ни этим
  // проходом, ни app-проходом, ни ESLint (он здесь не type-aware). Ревью проверило это вставкой
  // реальной ошибки типа: `pnpm typecheck` вернул 0. Это осознанно вне скоупа #527 (там про юнит-
  // тесты), но записано, потому что «исключён, ибо Playwright» звучит как «покрыт где-то ещё», а
  // это не так — см. docs/project-map.md.
})

describe('визуальные тесты покрыты typecheck (#542)', () => {
  // ⚠ Зона, которую не проверял НИКТО: vitest её не матчит (`.spec.ts`), Playwright транспилирует
  // esbuild'ом без проверки типов, ESLint здесь не type-aware. Ошибка типа всплывала бы только
  // рантайм-исключением в CI-джобе `visual`. И всплыла: `reducedMotion` в `use` — не опция
  // раннера вовсе, она игнорировалась молча, то есть анимации в снимках НЕ глушились (замерено:
  // `matchMedia('(prefers-reduced-motion: reduce)')` = false), а комментарии рядом уверяли в
  // обратном.
  const cfg = JSON.parse(read('tsconfig.visual.json')) as {
    extends: string
    include: string[]
    compilerOptions?: Record<string, unknown>
  }

  it('охват включает и тесты, и конфиг Playwright', () => {
    expect(cfg.include).toContain('./tests/visual/**/*.ts')
    expect(cfg.include).toContain('./playwright.config.ts')
  })

  it('наследует APP-конфиг, а не серверный — тестам нужен DOM', () => {
    // ⚠ Под серверным конфигом падает `document` («Cannot find name»), и соблазн «починить» это
    // послаблением велик. Наследование app-конфига даёт `lib: DOM` штатно.
    expect(cfg.extends).toBe('./.nuxt/tsconfig.json')
  })

  it('reducedMotion задан через contextOptions, а не как опция use', () => {
    // ⚠ Структурно, потому что отказ МОЛЧАЛИВЫЙ: Playwright неизвестную опцию `use` не отвергает,
    // а игнорирует. Вернуть её обратно — значит снова снимать экраны с работающими анимациями и
    // ловить цифры count-up на полпути, при этом ничего не сломав на вид.
    const config = read('playwright.config.ts')
    expect(config).toContain('contextOptions: { reducedMotion:')
    expect(config).not.toMatch(/^\s*reducedMotion:/m)
    // В самом тесте повтора быть не должно: `contextOptions` при повторе замещается, а не
    // сливается, — «продублировав для надёжности», мы затёрли бы конфиг.
    expect(read('tests/visual/pages.spec.ts')).not.toMatch(/^\s*reducedMotion:/m)
  })
})
