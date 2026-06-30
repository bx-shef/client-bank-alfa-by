# Чек-лист настройки репозитория (владелец)

> Last reviewed: 2026-06-30

Что владелец репозитория (admin) делает в **Settings** один раз, чтобы
заработало правило «в `main` не пушим — только через PR с зелёным CI».
Файлы CI (`.github/workflows/ci.yml`) и Dependabot (`.github/dependabot.yml`)
уже в репозитории; здесь — настройки, которые **нельзя** задать файлом.

Полный справочник с обоснованиями — в базе знаний `ai-agent`,
`docs/08_git-ci-di/03_repo_protection_ci.md`.

---

## 1. Защита `main` (ruleset `protect-main`)

**Settings → Rules → Rulesets → New branch ruleset.**

| Поле | Значение |
|---|---|
| **Ruleset Name** | `protect-main` |
| **Enforcement status** | `Active` |
| **Bypass list** | пусто |
| **Target branches** | Add target → **Include default branch** (`main`) |

В секции **Rules** включить:

- [ ] **Restrict deletions** — нельзя удалить `main`.
- [ ] **Block force pushes** — нельзя переписать историю.
- [ ] **Require a pull request before merging**
  - **Required approvals:** `0` (или `1`, если в команде больше одного разработчика)
  - [ ] **Dismiss stale pull request approvals when new commits are pushed**
  - [ ] **Require conversation resolution before merging**
- [ ] **Require status checks to pass**
  - [ ] **Require branches to be up to date before merging**
  - **Add checks:** ввести `ci` и выбрать из автодополнения.

> Если `ci` не появляется в списке — workflow ещё ни разу не отрабатывал.
> Откройте первый PR (этот!) — `ci` запустится, затем вернитесь и добавьте check.
> Имя должно **точно** совпадать с именем job'а `ci` в `ci.yml`.
>
> Job `docker-build` (сборка прод-образа на PR) **не** делаем required-check'ом: его падение не
> должно блокировать merge доменного/UI-кода, а провал сборки образа на `main` безвреден
> (Watchtower продолжит крутить предыдущий образ). При желании ужесточить — добавьте `docker-build`
> в этот же список.

**Проверка** — обе команды должны отклониться, прямой push в `main` тоже:

```bash
git push origin main --force
git push origin :main
```

## 2. Автоудаление веток после мержа

**Settings → General → Pull Requests** → ☑ **Automatically delete head branches**.

## 3. Dependabot

**Settings → Code security and analysis** → включить:

- [ ] **Dependabot alerts**
- [ ] **Dependabot security updates**
- [ ] **Dependabot version updates** (использует `.github/dependabot.yml` из репозитория)

Чтобы Dependabot мог открывать PR: **Settings → Actions → General → Workflow
permissions** → ☑ **Allow GitHub Actions to create and approve pull requests**.

> Как работать с Dependabot день в день (разбор `dependabot.yml`, обработка PR,
> группировка, игноры, авто-мерж, SHA-pinning) — в [`DEPENDABOT.md`](./DEPENDABOT.md).

## 4. Проверка

После настройки жизненный цикл изменения:

1. `git checkout -b feature/x` → коммит → push.
2. PR в `main` → автоматически стартует `ci`.
3. Красный CI → чините и пушите ещё раз.
4. `main` ушёл вперёд → кнопка **Update branch** в PR.
5. (Опц.) апрув ревьюера → кнопка **Merge** разблокируется.

Прямой push в `main`, force-push и удаление ветки на этом этапе уже невозможны.
