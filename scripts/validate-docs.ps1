# validate-docs.ps1 — Windows-эквивалент scripts/validate-docs.sh.
# Оффлайн, без вызовов GitHub API. Запуск: pwsh scripts/validate-docs.ps1
# Для шагов 1-3 нужен bash (Git Bash или WSL); при отсутствии — они помечаются SKIP.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

$Doc = "docs/FEEDBACK_TRIAGE_AGENT.md"
$ChannelDoc = "docs/FEEDBACK.md"
$Sh = "scripts/feedback-triage.sh"
$fail = 0
$bash = Get-Command bash -ErrorAction SilentlyContinue

Write-Host "== 1. Синтаксис bash (bash -n) =="
if ($bash) {
  & bash -n $Sh; if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: синтаксис $Sh"; $fail = 1 } else { Write-Host "OK: $Sh" }
} else { Write-Host "SKIP: bash не найден (установите Git Bash или WSL)" }

Write-Host "== 2. shellcheck (если установлен) =="
if (Get-Command shellcheck -ErrorAction SilentlyContinue) {
  & shellcheck -x $Sh; if ($LASTEXITCODE -ne 0) { $fail = 1 } else { Write-Host "OK: shellcheck" }
} else { Write-Host "SKIP: shellcheck не найден (choco install shellcheck)" }

Write-Host "== 3. Dry-run функций с моком curl =="
if ($bash) {
  $dry = New-TemporaryFile
  $inner = (Get-Content $Sh -Raw)
  # стаб сетевого слоя _api (перекрываем после определения); реальная сборка payload прогоняется
  $stub = "_api() { printf '%s' '{`"html_url`":`"https://example/mock`"}'; }`n"
  $script = ($inner -replace '(?s)^.*?set -euo pipefail', 'set -euo pipefail') + "`n" + $stub + @"
GH_WRITE_TOKEN=mock
echo '## body' > /tmp/_ft_body.md
create_issue 'o/r' 'T' /tmp/_ft_body.md 'bug, enhancement' >/dev/null
comment_issue 'o/r' 1 'c'
close_transferred 'o/r' 1
echo DRYRUN_OK
"@
  Set-Content -Path $dry -Value $script -Encoding UTF8
  $out = & bash $dry 2>&1
  if ($out -match "DRYRUN_OK") { Write-Host "OK: dry-run функций" } else { Write-Host "FAIL: dry-run`n$out"; $fail = 1 }
  Remove-Item $dry -Force
} else { Write-Host "SKIP: bash не найден" }

Write-Host "== 4. Блок лимитов GitHub API присутствует в доке =="
if ((Select-String -Path $Doc -Pattern "REST-core" -Quiet) -and (Select-String -Path $Doc -Pattern "GraphQL" -Quiet)) {
  Write-Host "OK: правило лимитов описано (§7)"
} else { Write-Host "FAIL: нет блока лимитов (REST-core/GraphQL) в $Doc"; $fail = 1 }

Write-Host "== 5. Приватность: privacy-guard про публичный репо =="
if ((Select-String -Path $Doc -Pattern "публичн" -Quiet) -and (Select-String -Path $ChannelDoc -Pattern "приватн" -Quiet)) {
  Write-Host "OK: privacy-guard присутствует"
} else { Write-Host "FAIL: нет оговорки о приватности"; $fail = 1 }

Write-Host "== 6. Канал сбора описан (FEEDBACK.md) =="
if ((Select-String -Path $ChannelDoc -Pattern "user-feedback" -Quiet) -and (Select-String -Path $ChannelDoc -Pattern "agent-feedback" -Quiet)) {
  Write-Host "OK: оба канала описаны"
} else { Write-Host "FAIL: в $ChannelDoc не описаны каналы"; $fail = 1 }

if ($fail -eq 0) { Write-Host "== ИТОГ: OK ==" } else { Write-Host "== ИТОГ: ЕСТЬ ОШИБКИ ==" }
exit $fail
