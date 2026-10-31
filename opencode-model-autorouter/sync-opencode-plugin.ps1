$ErrorActionPreference = "Stop"
$src = "C:\Tools\open_code_session_marker\opencode-model-autorouter"
$dst = "C:\Users\Honor\.config\opencode\plugins\opencode-model-autorouter"
$exclude = @("node_modules", "test-results", ".git", ".gitignore")
if (-not (Test-Path $src)) { Write-Error "Source not found: $src"; exit 1 }
if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
$copied = 0; $removed = 0
Get-ChildItem $src -Exclude $exclude | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dst $_.Name) -Recurse -Force -ErrorAction Stop
    $copied++
}
Get-ChildItem $dst -Exclude $exclude | Where-Object { -not (Test-Path (Join-Path $src $_.Name)) } | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop
    $removed++
}
Write-Host "Done. Copied: $copied, Removed: $removed"
Write-Host "Install path: $dst"
