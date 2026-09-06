# Rules for AI agents working in this repository

> Last reviewed: 2026-08-27

These rules apply to every change, including one-line fixes. Section 0 decides
language for everything; sections 1–4 govern how work reaches `main`; sections
5–6 govern how the agent works and how it reports.

---

## 0. Language — the only place language is decided

This repository is bilingual. Do not infer language from the surrounding text,
from the language of the request, or from a neighbouring file. Use this table.

| What you are writing | Language |
|---|---|
| Code, identifiers, file names | English |
| JSDoc, code comments, test names, fixtures | **Russian** (adapted 2026-08-30 — see below) |
| Commit messages, squash subject and body, tags | **Russian** (adapted 2026-08-30 — see below) |
| Documentation, `README`, Skill files | The language of the file you are editing. A **new** doc file: **Russian** |
| PR title and description | Russian |
| Issues — new and follow-up | Russian |
| Comments on issues and PRs, replies in review threads | Russian |
| Review-panel report and project status report to the maintainer | Russian |
| User-facing strings in the product | Russian — the product ships RU-only, there is no i18n layer to consult |

If something is not in this table, match the language of the file or thread you
are writing into, and say in one line which you chose and why.

One thing never switches language, whatever else is happening: code identifiers.

### Что адаптировано под этот проект и почему (2026-08-30)

Три строки таблицы изменены решением владельца. Замеры — на день адаптации,
перемеряй, прежде чем ссылаться (это §5.3).

- **Комментарии и JSDoc: English → русский.** Исходное правило расходилось с
  фактом: русские комментарии сейчас в **126 из 126** файлов `server/utils` и
  **89 из 92** `app/utils`. То есть по-русски здесь пишут и так, а безусловное
  «English» пришлось бы нарушать в каждом файле.
  ⚠ Смешение языков ВНУТРИ одного модуля остаётся дефектом чтения. Правя
  англоязычный блок, не оставляй его двуязычным посреди функции: либо пиши
  по-русски рядом с русским соседом, либо переводи блок целиком. Массовый
  перевод — отдельным PR, а не попутно с правкой по делу.
- **Коммиты: English Conventional Commits → русский.** Обоснование исходного
  правила («release-please parses them») здесь не выполняется: release-please в
  репозитории нет — слово встречается только внутри вендорного `reporting-kit/`
  как пример жаргона. Релизы идут через GHCR + Watchtower (`docs/DEPLOY.md`),
  `CHANGELOG` не ведётся, вся история коммитов русская.
- **Новый документ: English → русский.** Совпадает с конвенцией `CLAUDE.md`
  («пользовательский текст, README и документация — на русском»): эти документы
  читает владелец и клиент.

Сам этот файл остаётся английским — он пришёл таким от владельца, и переводить
его значило бы переписывать чужой документ. Разделы адаптации — по-русски, как
и всё, что дописано здесь.

---

## 1. Documentation instead of guessing

Bitrix24 API surface is not something to recall. Before writing or reviewing
code that touches it, read the documentation:

| Area | Source |
|---|---|
| `@bitrix24/b24ui` — components, props, slots, theming | `https://bitrix24.github.io/b24ui/llms.txt`, then the specific page it points to |
| `@bitrix24/b24jssdk` — SDK classes, methods, events | `https://bitrix24.github.io/b24jssdk/llms.txt`, then the specific page it points to |
| Bitrix24 REST API — methods, events, scopes, app development | the `b24-dev-mcp` MCP server: `bitrix-search` to find, then `bitrix-method-details` / `bitrix-event-details` / `bitrix-article-details` / `bitrix-app-development-doc-details` |

Rules:

- A prop name, a method name, a scope, an event name, a return shape — read it,
  do not reconstruct it from memory. This is rule 5.3 applied to APIs.
- Cite what you read in the PR description: method or page, so the reviewer can
  check the same source.
- If the documentation and the observed behaviour disagree, **measure**, then
  state which one is wrong and how you established it. Do not silently follow
  either.
- If the documentation does not cover it, say "не нашёл в документации" and
  describe what you did instead. Never invent a plausible-looking method or prop.

---

## 2. `main` is merge-only

Never commit or push to `main` directly. Every change — a feature, a fix, a docs
typo — lands through a pull request. Work on a branch, open the PR, let it be
reviewed and merged. This holds even when the change is obviously safe and even
when you have push rights; the PR is the record of *why* something changed, and
a direct commit erases it.

---

## 3. Review of a PR

Run this whenever a PR is first assembled **and** again after any substantial
rework. Not for a typo pushed on top of an already-reviewed PR — for a round of
real changes.

### 3.1 Always

1. **Pull `main` into the branch first.** Review a PR against what it will
   actually merge into, not against a stale base.
2. **Explain the PR in plain language** — what it does and why, before any
   tooling runs. If that summary is hard to write, the PR is doing too much.
3. **Run `/code-review`** over the diff, from several angles. (The skill is named
   `/code-review` here; the rules said `/review`.)

### 3.2 The five reviewers — when to convene them

`/code-review` runs on every PR. The panel of five does not.

| Convene the panel | `/code-review` is enough |
|---|---|
| Behaviour or public API changes | Tests and test harness only |
| External promises: security, governance, licensing | Documentation and comments |
| Release pipeline, publishing, CI gates | Config, markup, styles |
| A fix based on something the agent asserted but never measured | A wording fix in an already-reviewed PR |

When in doubt, convene.

*Почему разделение (адаптировано 2026-08-30).* Исходные примеры (#507, #503)
пришли из соседнего проекта — здесь эти номера принадлежат другой работе, и
ссылаться на них значило бы отправить читателя не туда (§5.4). Своей статистики
у нас пока мало; вот что измерено:

- **#649** — панель и `/code-review` нашли одно и то же: утечку credential'ов в
  лог, потерю класса ошибки, неразобранный конверт и мой же регресс в воронке.
  Панель добавила независимое подтверждение блокера, но не нашла ничего сверх.
- **#634** — блокер (отметку попытки ставил только крон, а не оба пути
  продления) нашла панель; `/code-review` на этом PR не гонялся, так что
  сравнение неполное и выдавать его за довод нельзя.

То есть критерий ниже держится на рассуждении, а не на нашей статистике. Правая
колонка — не «мелкий диск», а «PR ничего не обещает наружу».

The fourth row on the left is about the agent itself. If the fix grew out of a
claim that was reasoned rather than measured, convene the panel however small the
diff is. That is exactly where the mistakes have been.

### 3.3 Running the panel

Five reviewers, model Sonnet, one role each, run **concurrently** — they are
independent.

| Reviewer | Looks at |
|---|---|
| **Documentation specialist** | Docs and Skill files — accuracy, completeness, whether the examples actually run |
| **Engineer** | Whether the decisions taken are sound; JSDoc coverage, TypeScript typing, and anything else they judge relevant |
| **QA** | Test coverage, and the quality of the tests themselves |
| **Security** | Anything with a security dimension |
| **CTO** | The change as a whole — scope, cost, direction, what it commits the project to |

Tell every reviewer, in their prompt:

- The project is large. Scope the reading, pace the work, do not try to load the
  whole tree at once, do not die on a timeout.
- The working tree is shared. An edit you did not make is a neighbour working, not
  an attack — do not revert it and do not build a theory around it.
- Only the **QA** reviewer may mutate code, and only to check that a test goes red.
  Everyone else reads.
- Undo a mutation by restoring a copy saved to `/tmp` beforehand. **Never**
  `git checkout --` (see 5.5).
- Reviewers report findings. They do not fix them.

### 3.4 Reporting and fixing

- **Report in Russian**, short: who found it, what it is, why it matters, how to
  fix it. One block per reviewer. No transcript dumps.
- **Then fix.** Everything gets fixed *in this PR*. If a finding genuinely belongs
  in a separate issue or PR, do not split it off silently — raise it and discuss it
  first.
- If you decide **not** to act on a finding, say so and say why, with the
  measurement that supports it (see 5.7). Silence is not a decision.

---

## 4. Merging

### 4.1 Before the merge button

- **Pull the latest `main`** into the branch and confirm it still merges cleanly.
- **CI is green.**
- **Every review thread is resolved** — no open question left hanging.
- **Follow-up issues are filed in Russian**, either as new issues or as an
  expansion of an existing one. Give them real context; a one-line "починить
  потом" is not a follow-up issue.
- **Write the squash message deliberately**, по-русски (адаптировано 2026-08-30).
  Ни release-please, ни `CHANGELOG` здесь нет — значит сообщение пишется не для
  машины, а для человека, который через полгода спросит «почему так сделано».
  Поэтому subject называет РЕШЕНИЕ, а не файлы, а тело — довод и цену: что
  измерено, что отвергнуто и почему. Ссылка на `releasing.md` из исходных правил
  снята: такого файла в проекте нет.
- **Refresh the `Last reviewed` stamps** in touched docs and Skill files to the
  merge date.

If all of that holds, merge.

### 4.2 After the merge

- **Delete the branch.**
- **If the PR closed an issue, comment on it** — in Russian, upbeat and lightly
  humorous, with a couple of examples or documentation links, and where it fits, a
  sample prompt showing the new thing in use. Pass along a thank-you from the
  maintainer.
- **Close the issue** if it is in fact resolved.
- **Then take stock of the project**, in plain words: what was just done, what the
  next step is and what comes after it; and separately, what is currently getting
  in the way.

---

## 5. Working discipline

These are not style preferences. Each one is here because skipping it cost a
rework.

### 5.1 No claim about behaviour without a measurement

A statement about how the code behaves is made **after running it**, never from
"should" or "obviously". Reasoning finds candidates; only execution decides. This
applies to a finding, to a diagnosis, to a root cause, and to the explanation
written in the PR description.

Guard cases especially: a guard checked at one value is not a guard checked.

### 5.2 A test must go red when the code is mutated

Otherwise it is not a test. After writing a regression test, revert the fix and
confirm the test fails — then restore the fix (5.5 says how). A test that passes
for the wrong reason is worse than no test, because it certifies the bug.

### 5.3 A number recalled is the same class of error as code recalled

Action SHAs, component names, versions, prop names, file paths, thresholds — look
them up. Never transcribe from a truncated log line, and never from memory
"because it is obviously that one".

### 5.4 Verify every link before publishing it

A URL in an issue, a PR, a doc, or a comment gets opened first. Do not point
people at a repository tab or a page that does not exist.

### 5.5 Never `git checkout --` to undo

It takes uncommitted work with it — it has done so repeatedly. Before mutating a
file, copy it to `/tmp`; restore from that copy. If a broader revert is
unavoidable, commit or stash first and say so.

### 5.6 Correct an error where it will be seen

A wrong statement in a merged PR gets a new PR with a diff, not a comment. Nobody
finds the comment, and a wrong annotation in the code sends the next person to fix
the wrong file.

### 5.7 Say what you did not do

Not "готово" but "сделал это, это не сделал, потому что". Skipped work,
rejected review findings, checks that did not run — all of it is stated out loud,
with the reason.

### 5.8 External and irreversible decisions are not yours

Vulnerability disclosure channels, `npm deprecate`, public API shape, anything
published under the org's name — ask the maintainer, even at the cost of a pause.

---

## 6. Against sprawl

### 6.1 The numbers

The table is a set of baselines with alarm levels. **Re-measure before citing —
never quote these figures from this file as current** (that is 5.3).

⚠ Числа ниже перемерены на этом репозитории 2026-08-30 — исходные пришли из
соседнего проекта и к нам не относились.

| Signal | Baseline when measured (2026-08-30) | Alarm |
|---|---|---|
| Отношение строк `tests/**` к `app/**` + `server/**` (только `.ts`) | **1.22** | **уже за порогом** — см. ниже |
| То же с учётом `.vue` | 0.95 | above 1.0 |
| Корпус визуальных эталонов | 9.2 МБ, 34 снимка | рост без новых страниц |
| `CLAUDE.md` | 2889 строк, 416 КБ | документ, который перестают читать целиком |
| Документов в `docs/` | 40 | новый документ вместо раздела в существующем |
| Edits to one config file within a week | не мерялось | more than five |

⚠ **Первая строка уже за тревогой, и это не повод сокращать тесты.** Прежде чем
резать, перемерь и посмотри на состав: у нас есть классы тестов, которых в
обычном проекте нет — структурные гарды (закрытые списки путей удаления,
охват typecheck, гард `make`-целей) и поведенческие прогоны шелл-скриптов.
Они длинные и заведены по факту потерянных дней, а не ради процента. Тревога
здесь означает «останься и посмотри, что именно выросло», а не «удали».

### 6.2 The rules behind them

- **Coverage is neither a goal nor a threshold.** A test exists to catch a
  specific regression, not to move a percentage.
- **JSDoc is a hint, not an article.** If it takes 40 lines to explain, the API is
  the problem.
- **No code written for a hypothetical future.** Build what is needed now.
- **A guard is added for an incident that actually happened**, and its comment must
  say what it once caught. A guard without that sentence is deleted.
- **A config file edited a third time in one week is a signal to stop** and work
  out what is actually wrong.

---

*Sections 2 and 4 are the maintainer's own rules and are quoted almost verbatim;
everything else is derived from mistakes made in real sessions.*

---

## Как этот файл адаптировался

Правила пришли от владельца 2026-08-27 и были положены в репозиторий дословно —
вместе с разделом, где агент выписал три расхождения с фактическим состоянием
проекта, не разрешая их: язык коммитов, язык комментариев и ссылки из соседнего
проекта.

2026-08-30 владелец их разрешил: коммиты и комментарии — по-русски, `releasing.md`
— пропускаем. Правки внесены в сами разделы (§0, §3.1, §3.2, §4.1, §6.1) и
помечены там же датой и доводом, а раздел с нерешёнными расхождениями снят —
он перестал описывать реальность.

⚠ Что при этом НЕ изменилось: §5 целиком (рабочая дисциплина), §2 (`main` только
через PR), §3.3–§3.4 (состав панели и порядок отчёта), §6.2. Это правила
владельца, и трогать их адаптация не вправе.
