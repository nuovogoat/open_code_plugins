# Скрипт синхронизации локальной копии плагина OpenCode
#
# Копирует исходники плагина из репозитория в установленную директорию OpenCode:
#   C:\Users\Honor\.config\opencode\plugins\opencode-model-autorouter
#
# Исключает: node_modules, test-results (не нужны в runtime-копии).
# Запускайте после каждого git pull / изменения исходников, чтобы обновить установленный плагин.

$ErrorActionPreference = "Stop"

$src = "C:\Tools\open_code_session_marker\opencode-model-autorouter"
$dst = "C:\Users\Honor\.config\opencode\plugins\opencode-model-autorouter"
$exclude = @("node_modules", "test-results", ".git", ".gitignore")

if (-not (Test-Path $src)) {
    Write-Error "Исходный каталог не найден: $src"
    exit 1
}

if (-not (Test-Path $dst)) {
    Write-Host "Создаю целевой каталог: $dst"
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

# 1) Синхронизируем файлы
$copied = 0
$skipped = 0
Get-ChildItem $src -Exclude $exclude | ForEach-Object {
    $destPath = Join-Path $dst $_.Name
    try {
        Copy-Item $_.FullName $destPath -Recurse -Force -ErrorAction Stop
        $copied++
        Write-Host ("  +" + $_.Name)
    } catch {
        Write-Warning ("Не удалось скопировать " + $_.Name + ": " + $_.Exception.Message)
        $skipped++
    }
}

# 2) Удаляем из целевого каталога то, чего больше нет в исходнике (кроме excluded)
$removed = 0
Get-ChildItem $dst -Exclude $exclude | Where-Object {
    -not (Test-Path (Join-Path $src $_.Name))
} | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop
    $removed++
    Write-Host ("  -" + $_.Name)
}

Write-Host ("`nГотово. Скопировано: $copied, удалено: $removed, пропущено: $skipped")
Write-Host ("Установка: $dst")
Write-Host "Проверьте: opencode plugin list"
