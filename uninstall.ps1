#requires -Version 5.1
<#
    Windhawk Translate - uninstaller

    Restores the patched Windhawk UI files from the backups created by
    install.ps1, removes the companion extension and, with -Purge, the
    translation dictionary.
#>
param(
    [string]$WindhawkRoot = 'G:\Windhawk',
    [string]$DataDir = '',
    [switch]$Purge,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$uiProcesses = @(Get-Process -Name 'VSCodium' -ErrorAction SilentlyContinue)
if ($uiProcesses.Count -gt 0 -and -not $Force) {
    Write-Host "Windhawk 正在运行（$($uiProcesses.Count) 个 VSCodium 进程）。" -ForegroundColor Yellow
    Write-Host "请先退出 Windhawk（托盘图标 -> 退出），再运行本脚本；或加 -Force 忽略此检查。" -ForegroundColor Yellow
    throw "卸载已中止：请先关闭 Windhawk。"
}

if (-not $DataDir) { $DataDir = Join-Path $env:ProgramData 'Windhawk\Translate' }

$webviewDir = Join-Path $WindhawkRoot 'UI\resources\app\extensions\windhawk\webview'
$indexHtml = Join-Path $webviewDir 'index.html'
$extensionJs = Join-Path $WindhawkRoot 'UI\resources\app\extensions\windhawk\dist\extension.js'
$backupDir = Join-Path $DataDir 'backup'

Write-Host "Windhawk Translate - uninstall" -ForegroundColor Cyan

$restored = $false
if (Test-Path (Join-Path $backupDir 'index.html.orig')) {
    Copy-Item (Join-Path $backupDir 'index.html.orig') $indexHtml -Force
    $restored = $true
}
if (Test-Path (Join-Path $backupDir 'extension.js.orig')) {
    Copy-Item (Join-Path $backupDir 'extension.js.orig') $extensionJs -Force
    $restored = $true
}
$pageScript = Join-Path $webviewDir 'wh-translate.js'
if (Test-Path $pageScript) { Remove-Item $pageScript -Force }
if ($restored) { Write-Host "  Restored Windhawk UI files" } else { Write-Host "  No backups found (nothing to restore)" }

$uiData = Join-Path $env:ProgramData 'Windhawk\UIData'
if (-not (Test-Path (Join-Path $uiData 'user-data'))) { $uiData = Join-Path $env:USERPROFILE '.windhawk' }
$extensionsDir = Join-Path $uiData 'extensions'
$extensionId = 'local.windhawk-translate'

Get-ChildItem $extensionsDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ($extensionId + '-*') } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force; Write-Host ("  Removed " + $_.Name) }

$extensionsJsonPath = Join-Path $extensionsDir 'extensions.json'
if (Test-Path $extensionsJsonPath) {
    try {
        $parsed = @(Get-Content $extensionsJsonPath -Raw | ConvertFrom-Json)
        $kept = @($parsed | Where-Object { $_ -and $_.identifier -and $_.identifier.id -ne $extensionId })
        $json = ConvertTo-Json -InputObject @($kept) -Depth 8
        [IO.File]::WriteAllText($extensionsJsonPath, $json, (New-Object Text.UTF8Encoding($false)))
    } catch { }
}

if ($Purge) {
    if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
    Write-Host "  Removed dictionary data"
} else {
    Write-Host "  Dictionary kept at $DataDir"
}

Write-Host "Done. Restart Windhawk to finish." -ForegroundColor Green
