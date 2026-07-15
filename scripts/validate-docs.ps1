# validate-docs.ps1 — Windows-эквивалент scripts/validate-docs.sh.
# Оффлайн, без вызовов GitHub API (curl замокан). Запуск: pwsh scripts/validate-docs.ps1
# Для шагов 1-3 нужен bash (Git Bash или WSL); при отсутствии — они помечаются SKIP.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

$Doc = "docs/FEEDBACK_TRIAGE_AGENT.md"
$ChannelDoc = "docs/FEEDBACK.md"
$Sh = "scripts/feedback-triage.sh"
$Placeholder = "bx-shef/REPLACE-ME-feedback-private"
$fail = 0
$bash = Get-Command bash -ErrorAction SilentlyContinue

Write-Host "== 1. Синтаксис bash (bash -n) =="
if ($bash) {
  & bash -n $Sh; if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: синтаксис $Sh"; $fail = 1 } else { Write-Host "OK: $Sh" }
} else { Write-Host "SKIP: bash не найден (установите Git Bash или WSL)" }

Write-Host "== 2. shellcheck (если установлен) =="
if (Get-Command shellcheck -ErrorAction SilentlyContinue) {
  & shellcheck -x $Sh "scripts/validate-docs.sh"; if ($LASTEXITCODE -ne 0) { $fail = 1 } else { Write-Host "OK: shellcheck" }
} else { Write-Host "SKIP: shellcheck не найден (choco install shellcheck)" }

Write-Host "== 3. Поведенческий прогон с моком curl (без сети): happy-path + guard'ы =="
# Как и в .sh: мокается САМ curl, реальный _api прогоняется целиком (очистка mktemp,
# разбор http-кода, отсутствие протечки trap, privacy-guard), плюс негативные guard-кейсы.
if ($bash) {
  $harnessFile = New-TemporaryFile
  $cap = New-TemporaryFile
  $bodyFile = New-TemporaryFile
  $env:CAP = $cap.FullName
  $env:BODY = $bodyFile.FullName
  $env:SCRIPT_ABS = (Resolve-Path $Sh).Path
  $env:MOCK_CODE = "200"
  $harness = @'
CAP="${CAP}"; BODY="${BODY}"; MOCK_CODE="${MOCK_CODE:-200}"
curl() {
  local out="" databin="" i; local -a a=("$@")
  for ((i=0;i<${#a[@]};i++)); do
    case "${a[i]}" in
      -o) out="${a[i+1]}";;
      --data-binary) databin="${a[i+1]}";;
    esac
  done
  cat >/dev/null 2>&1 || true
  [ -n "$out" ] && printf '{"html_url":"https://example/mock","private":true}' > "$out"
  [ -n "$databin" ] && [ "${databin:0:1}" = "@" ] && cp "${databin:1}" "$CAP" 2>/dev/null
  printf '%s' "$MOCK_CODE"
}
export GH_WRITE_TOKEN=mocktoken
export PROJECT_REPO="bx-shef/client-bank-alfa-by"
export GITHUB_FEEDBACK_REPO="bx-shef/feedback-private"
source "${SCRIPT_ABS}"
rc=0; chk(){ if eval "$2"; then :; else echo "SUBFAIL: $1"; rc=1; fi; }
false; echo "sourced-safe"
echo "## body" > "$BODY"
chk "create_issue"        'create_issue "$PROJECT_REPO" T "$BODY" "bug, enhancement" >/dev/null'
chk "comment_issue"       'comment_issue "$FEEDBACK_REPO" 43 "перенос"'
chk "close_transferred"   'close_transferred "$FEEDBACK_REPO" 43'
chk "labels"              'grep -q "\"labels\": \[\"bug\", \"enhancement\"\]" "$CAP"'
chk "no-token"            '! ( unset GH_WRITE_TOKEN; create_issue "$PROJECT_REPO" T "$BODY" bug >/dev/null 2>&1 )'
chk "http404"             '! ( MOCK_CODE=404; close_transferred "$FEEDBACK_REPO" 43 >/dev/null 2>&1 )'
chk "public-refused"      '! comment_issue "$PROJECT_REPO" 1 ctx >/dev/null 2>&1'
chk "bad-repo"            '! comment_issue "bad repo!" 1 x >/dev/null 2>&1'
chk "bad-num"             '! close_transferred "$FEEDBACK_REPO" abc >/dev/null 2>&1'
chk "empty-feedback"      '! ( unset FEEDBACK_REPO GITHUB_FEEDBACK_REPO; comment_issue "" 1 x >/dev/null 2>&1 )'
[ "$rc" -eq 0 ] && echo BEHAVIOR_OK
'@
  Set-Content -Path $harnessFile -Value $harness -Encoding utf8
  $out = & bash $harnessFile.FullName 2>&1
  if ($out -match "BEHAVIOR_OK") { Write-Host "OK: поведенческий прогон (happy-path + guard-кейсы)" }
  else { Write-Host "FAIL: поведенческий прогон`n$out"; $fail = 1 }
  Remove-Item $harnessFile, $cap, $bodyFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:CAP, Env:BODY, Env:SCRIPT_ABS, Env:MOCK_CODE -ErrorAction SilentlyContinue
} else { Write-Host "SKIP: bash не найден" }

Write-Host "== 4. Блок лимитов GitHub API присутствует в доке =="
if ((Select-String -Path $Doc -Pattern "REST-core" -Quiet) -and (Select-String -Path $Doc -Pattern "GraphQL" -Quiet) -and (Select-String -Path $Doc -Pattern "GITHUB_TOKEN_INGEST" -Quiet)) {
  Write-Host "OK: правило лимитов описано (§7), ingest-токен объявлен"
} else { Write-Host "FAIL: нет блока лимитов (REST-core/GraphQL/GITHUB_TOKEN_INGEST) в $Doc"; $fail = 1 }

Write-Host "== 5. Privacy-guard: содержательная формулировка (не одно слово) =="
if ((Select-String -Path $Doc -Pattern "Privacy-guard" -Quiet) -and (Select-String -Path $Doc -Pattern "не копируй|УНП" -Quiet) -and (Select-String -Path $ChannelDoc -Pattern "приватн" -Quiet)) {
  Write-Host "OK: privacy-guard присутствует содержательно"
} else { Write-Host "FAIL: privacy-guard выродился в упоминание слова"; $fail = 1 }

Write-Host "== 6. Канал сбора описан (FEEDBACK.md) =="
if ((Select-String -Path $ChannelDoc -Pattern "user-feedback" -Quiet) -and (Select-String -Path $ChannelDoc -Pattern "agent-feedback" -Quiet)) {
  Write-Host "OK: оба канала описаны"
} else { Write-Host "FAIL: в $ChannelDoc не описаны каналы"; $fail = 1 }

Write-Host "== 7. Плейсхолдер приватного репо консистентен =="
$miss = @()
foreach ($f in @($Doc, $Sh)) {
  if (-not (Select-String -Path $f -Pattern ([regex]::Escape($Placeholder)) -Quiet)) { $miss += $f }
}
if ($miss.Count -eq 0) { Write-Host "OK: плейсхолдер '$Placeholder' совпадает в доке и скрипте" }
else { Write-Host "FAIL: плейсхолдер отсутствует/разошёлся в: $($miss -join ' ')"; $fail = 1 }

Write-Host "== 8. Внутренние markdown-ссылки не битые =="
$broken = @()
foreach ($src in @($Doc, $ChannelDoc)) {
  $found = Select-String -Path $src -Pattern '\]\(([A-Za-z0-9_./-]+\.md)\)' -AllMatches
  foreach ($m in $found.Matches) {
    $target = $m.Groups[1].Value
    if (-not ((Test-Path $target) -or (Test-Path (Join-Path "docs" $target)))) { $broken += "$src->$target" }
  }
}
if ($broken.Count -eq 0) { Write-Host "OK: внутренние .md-ссылки существуют" }
else { Write-Host "FAIL: битые ссылки: $($broken -join ' ')"; $fail = 1 }

Write-Host "== 9. Паритет проверок .sh/.ps1 (одинаковое число шагов) =="
$shSteps = (Select-String -Path "scripts/validate-docs.sh" -Pattern 'note "== [0-9]+\.').Count
$psSteps = (Select-String -Path $PSCommandPath -Pattern 'Write-Host "== [0-9]+\.').Count
if ($shSteps -eq $psSteps) { Write-Host "OK: $shSteps шагов в .sh и .ps1" }
else { Write-Host "FAIL: паритет .sh($shSteps)/.ps1($psSteps) разошёлся"; $fail = 1 }

if ($fail -eq 0) { Write-Host "== ИТОГ: OK ==" } else { Write-Host "== ИТОГ: ЕСТЬ ОШИБКИ ==" }
exit $fail
