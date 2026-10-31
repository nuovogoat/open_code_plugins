$ErrorActionPreference = "Stop"
# Portable: the source is the script's own folder, the destination is derived
# from the user profile (no machine-specific literals, standards §0.12).
$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE ".config/opencode/plugins/opencode-model-autorouter"
if (-not (Test-Path $src)) { Write-Error "Source not found: $src"; exit 1 }
if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
# robocopy /MIR mirrors the tree: overwrites stale files and deletes extras
# (the old Copy-Item -Recurse approach nested directories like dist\dist and left stale copies).
robocopy $src $dst /MIR /XD node_modules test-results .git /XF .gitignore /NFL /NDL /NJH /NJS | Out-Null
$code = $LASTEXITCODE
if ($code -ge 8) { Write-Error "robocopy failed with code $code"; exit 1 }
Write-Host "Done. Mirrored plugin (robocopy code $code)"
Write-Host "Install path: $dst"
