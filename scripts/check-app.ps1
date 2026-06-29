# Local check pipeline for Windows: lint -> typecheck -> test, with a single
# ИТОГ status. Same checks as CI (.github/workflows/ci.yml), minus the build.
# Goal: run one command and get the result — not to type each step by hand.
# Usage: pwsh scripts/check-app.ps1   (or: powershell -File scripts\check-app.ps1)
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

$fail = 0
function Invoke-Step($name, [scriptblock]$step) {
  Write-Host ""
  Write-Host "=== $name ==="
  & $step
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА: $name"
    $script:fail++
  } else {
    Write-Host "OK: $name"
  }
}

Invoke-Step "lint" { pnpm lint }
Invoke-Step "typecheck" { pnpm typecheck }
Invoke-Step "test" { pnpm test }

Write-Host ""
if ($fail -eq 0) {
  Write-Host "ИТОГ: всё чисто"
} else {
  Write-Host "ИТОГ: найдено проблем — $fail"
}
exit $fail
