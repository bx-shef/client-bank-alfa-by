import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Гард самого CI (#554, хвост #542/#553).
//
// ⚠ Проект уже трижды ловил один и тот же класс отказа: проверка ВЫГЛЯДИТ рабочей и не работает
// (#527 — тесты не проходили typecheck вовсе; #542 — три зоны не проверялись ничем; #553 — слепое
// пятно внутри самой проверки типов). Гарды охвата закрывают вопрос «а всё ли проверяется», но
// никто не сторожит следующий: **запускает ли CI эти проверки и падает ли на них**.
//
// Способов погасить всё молча ровно три, и ни один не трогает охват:
//   1. `continue-on-error: true` у шага — шаг красный, джоба зелёная;
//   2. шаг убран из `ci.yml` — проверка просто не запускается;
//   3. джоба переименована — ruleset ссылается на ИМЯ `ci`, и защита main перестаёт что-либо
//      требовать, не сообщив об этом.
//
// Во всех трёх случаях `package.json` и tsconfig'и остаются прежними, а существующий гард охвата
// (`typecheckCoverage.test.ts`) — зелёным: он смотрит на команду, а не на то, зовут ли её.
//
// ⚠ Разбор ТЕКСТОВЫЙ: парсера YAML в зависимостях нет, тянуть его ради одного файла незачем.
// Плата за это — каждое утверждение здесь проверено мутацией, а не «выглядит правильным».

const ROOT = join(import.meta.dirname, '..')
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows')
const CI = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8')

/** Все файлы воркфлоу — гасить проверку молча можно в любом из них. */
function allWorkflows(): { name: string, text: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(name => ({ name, text: readFileSync(join(WORKFLOW_DIR, name), 'utf8') }))
}

describe('CI действительно запускает проверки и падает на них (#554)', () => {
  it('исходники читаются', () => {
    expect(CI.length).toBeGreaterThan(500)
    expect(allWorkflows().length).toBeGreaterThanOrEqual(2)
  })

  it('НИ ОДИН шаг не гасит свой провал через continue-on-error', () => {
    // ⚠ Самый тихий способ выключить проверку: шаг красный, джоба зелёная, required check пройден.
    // Запрещено ЦЕЛИКОМ, а не «кроме известных мест»: понадобится законное исключение — пусть
    // автор придёт сюда и напишет, почему провал этого шага не должен ронять сборку. Именно такой
    // разговор и есть цель гарда; молча вписанная строка его не вызывает.
    for (const { name, text } of allWorkflows()) {
      const hits = text.split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(x => /^continue-on-error\s*:\s*true/.test(x.line))
      expect(hits, `${name}: провал шага проглатывается на строках ${hits.map(h => h.n).join(', ')}`)
        .toEqual([])
    }
  })

  it('ни один `run` не глушит код возврата шеллом', () => {
    // ⚠ Второй способ добиться того же и мимо `continue-on-error`: `pnpm typecheck || true`.
    // Тот же приём уже запрещён внутри `pnpm typecheck` (`typecheckCoverage.test.ts`) — здесь он
    // запрещён этажом выше, в самой команде CI.
    for (const { name, text } of allWorkflows()) {
      const bad = text.split('\n')
        .map(l => l.trim())
        .filter(l => /^(- )?run:\s/.test(l))
        .filter(l => /\|\|\s*(true|:)\b|;\s*true\b|\|\|\s*exit\s+0/.test(l))
      expect(bad, `${name}: код возврата проглатывается — ${bad.join(' / ')}`).toEqual([])
    }
  })

  it('джоба `ci` запускает ВСЕ четыре проверки', () => {
    // ⚠ Убранный шаг не виден ни одному гарду охвата: `package.json` и tsconfig'и остаются
    // прежними, команда цела — её просто никто не зовёт. Список закрытый: добавили пятую проверку
    // в `check-app.sh` и забыли в CI — здесь это станет красным.
    for (const cmd of ['pnpm lint', 'pnpm test', 'pnpm typecheck', 'pnpm generate']) {
      expect(CI, `CI не запускает \`${cmd}\``).toMatch(new RegExp(`run:\\s*${cmd}\\s*$`, 'm'))
    }
  })

  it('имя джобы `ci` сохранено — на него ссылается защита main', () => {
    // ⚠ Ruleset `protect-main` требует статус-чек ПО ИМЕНИ (docs/REPO_SETUP_CHECKLIST.md).
    // Переименуй джобу — и required check перестанет существовать: GitHub не считает это ошибкой,
    // он просто больше ничего не требует, и любой PR становится мержабельным. Тише не бывает.
    expect(CI).toMatch(/^ {2}ci:\s*$/m)
    expect(CI).toMatch(/^ {4}name:\s*ci\s*$/m)
  })

  it('проверки идут на pull_request, а не только на main', () => {
    // Иначе красное обнаруживалось бы уже ПОСЛЕ мержа — то есть в ветке, которая деплоится.
    expect(CI).toMatch(/^ {2}pull_request:\s*$/m)
  })

  it('у джоб есть потолок времени — зависшая джоба не блокирует очередь навсегда', () => {
    expect(CI.match(/timeout-minutes:/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
