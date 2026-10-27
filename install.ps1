#requires -Version 5.1
<#
    Windhawk Translate - installer

    Installs the companion extension that
      * adds real-time translation to Windhawk's mod cards and mod details,
      * keeps the injection in place across Windhawk updates,
      * serves a persistent translation dictionary.

    Usage:
        powershell -ExecutionPolicy Bypass -File install.ps1
        powershell -ExecutionPolicy Bypass -File install.ps1 -WindhawkRoot "D:\Windhawk"
#>
param(
    [string]$WindhawkRoot = 'G:\Windhawk',
    [string]$DataDir = '',
    [switch]$Restart,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# The VSCodium UI rewrites extensions.json itself; touching it while the UI runs
# can interleave two writes and corrupt the file. Require a clean state.
$uiProcesses = @(Get-Process -Name 'VSCodium' -ErrorAction SilentlyContinue)
if ($uiProcesses.Count -gt 0 -and -not $Force) {
    Write-Host "Windhawk 正在运行（$($uiProcesses.Count) 个 VSCodium 进程）。" -ForegroundColor Yellow
    Write-Host "请先退出 Windhawk（托盘图标 -> 退出），再运行本脚本；或加 -Force 忽略此检查。" -ForegroundColor Yellow
    throw "安装已中止：请先关闭 Windhawk。"
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionSource = Join-Path $here 'extension'
$manifest = Get-Content (Join-Path $extensionSource 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$extensionId = $manifest.publisher + '.' + $manifest.name
$folderName = $extensionId + '-' + $version

if (-not $DataDir) { $DataDir = Join-Path $env:ProgramData 'Windhawk\Translate' }

function Write-Step($text) { Write-Host ("  " + $text) }

Write-Host "Windhawk Translate $version" -ForegroundColor Cyan

# --- 1. locate the installation ------------------------------------------------
$webviewDir = Join-Path $WindhawkRoot 'UI\resources\app\extensions\windhawk\webview'
$indexHtml = Join-Path $webviewDir 'index.html'
$extensionJs = Join-Path $WindhawkRoot 'UI\resources\app\extensions\windhawk\dist\extension.js'

if (-not (Test-Path $indexHtml) -or -not (Test-Path $extensionJs)) {
    throw "Windhawk UI not found under '$WindhawkRoot'. Pass -WindhawkRoot <path> if it is installed elsewhere."
}
Write-Step "Windhawk UI: $WindhawkRoot"

# --- 2. data directory ---------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'backup') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'logs') | Out-Null
Write-Step "Data: $DataDir"

# --- 3. extension folder -------------------------------------------------------
$uiData = Join-Path $env:ProgramData 'Windhawk\UIData'
if (-not (Test-Path (Join-Path $uiData 'user-data'))) {
    $uiData = Join-Path $env:USERPROFILE '.windhawk'
}
$extensionsDir = Join-Path $uiData 'extensions'
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null

Get-ChildItem $extensionsDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ($extensionId + '-*') -and $_.Name -ne $folderName } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

$targetExtensionDir = Join-Path $extensionsDir $folderName
if (Test-Path $targetExtensionDir) { Remove-Item $targetExtensionDir -Recurse -Force }
Copy-Item $extensionSource $targetExtensionDir -Recurse -Force
Write-Step "Extension: $targetExtensionDir"

# --- 4. register the extension -------------------------------------------------
$extensionsJsonPath = Join-Path $extensionsDir 'extensions.json'
$entries = @()
if (Test-Path $extensionsJsonPath) {
    try {
        $parsed = Get-Content $extensionsJsonPath -Raw | ConvertFrom-Json
        if ($parsed) { $entries = @($parsed) }
    } catch {
        $entries = @()
    }
}
$entries = @($entries | Where-Object { $_ -and $_.identifier -and $_.identifier.id -ne $extensionId })

$uriPath = '/' + $targetExtensionDir.Substring(0, 1).ToLower() + ($targetExtensionDir.Substring(1) -replace '\\', '/')
$entry = [ordered]@{
    identifier       = [ordered]@{ id = $extensionId }
    version          = $version
    location         = [ordered]@{ '$mid' = 1; path = $uriPath; scheme = 'file' }
    relativeLocation = $folderName
}
$entries += $entry
$json = ConvertTo-Json -InputObject @($entries) -Depth 8
# VS Code parses this file with JSON.parse, which rejects a UTF-8 BOM, so write
# it explicitly without one (Set-Content -Encoding UTF8 adds a BOM on PS 5.1).
$jsonTemp = $extensionsJsonPath + '.tmp'
[IO.File]::WriteAllText($jsonTemp, $json, (New-Object Text.UTF8Encoding($false)))
Move-Item $jsonTemp $extensionsJsonPath -Force
Write-Step "Registered: $extensionId"

# --- 5. patch the webview ------------------------------------------------------
$backupDir = Join-Path $DataDir 'backup'

function Backup-Pristine($path, $name) {
    $target = Join-Path $backupDir ($name + '.orig')
    $text = [IO.File]::ReadAllText($path)
    $ours = ($text -match '127\.0\.0\.1') -or ($text -match 'wh-translate\.js')
    if (-not $ours) {
        [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($false)))
    }
}

$scriptName = 'wh-translate.js'
$assetScript = Join-Path $extensionSource ('assets\' + $scriptName)
Copy-Item $assetScript (Join-Path $webviewDir $scriptName) -Force
Write-Step "Copied $scriptName"

# A content hash in the URL busts the webview service-worker cache whenever the
# script changes.
$sha1 = [Security.Cryptography.SHA1]::Create()
$assetHash = (($sha1.ComputeHash([IO.File]::ReadAllBytes($assetScript))) | ForEach-Object { $_.ToString('x2') }) -join ''
$tag = '<script src="wh-translate.js?v=' + $assetHash.Substring(0, 12) + '"></script>'

$html = [IO.File]::ReadAllText($indexHtml)
$existingTag = [regex]::Match($html, '<script[^>]*src="wh-translate\.js[^"]*"[^>]*></script>')
if ($existingTag.Success) {
    if ($existingTag.Value -ne $tag) {
        $html = $html.Replace($existingTag.Value, $tag)
        [IO.File]::WriteAllText($indexHtml, $html, (New-Object Text.UTF8Encoding($false)))
        Write-Step 'Updated index.html script tag'
    } else {
        Write-Step 'index.html already patched'
    }
} else {
    Backup-Pristine $indexHtml 'index.html'
    if ($html -match '</body>') { $html = $html -replace '</body>', ($tag + '</body>') }
    else { $html = $html + $tag }
    [IO.File]::WriteAllText($indexHtml, $html, (New-Object Text.UTF8Encoding($false)))
    Write-Step 'Patched index.html'
}

$ext = [IO.File]::ReadAllText($extensionJs)
if ($ext -notmatch '127\.0\.0\.1') {
    Backup-Pristine $extensionJs 'extension.js'
    $ext = $ext.Replace('connect-src ', 'connect-src https: http://127.0.0.1:* http://localhost:* ')
    [IO.File]::WriteAllText($extensionJs, $ext, (New-Object Text.UTF8Encoding($false)))
    Write-Step 'Patched webview CSP'
} else {
    Write-Step 'CSP already patched'
}

# --- 6. keep a copy of the installer for later ---------------------------------
$appCopy = Join-Path $DataDir 'app'
New-Item -ItemType Directory -Force -Path $appCopy | Out-Null
Copy-Item (Join-Path $here 'install.ps1') $appCopy -Force
if (Test-Path (Join-Path $here 'uninstall.ps1')) { Copy-Item (Join-Path $here 'uninstall.ps1') $appCopy -Force }
if (Test-Path (Join-Path $here 'README.md')) { Copy-Item (Join-Path $here 'README.md') $appCopy -Force }

[ordered]@{
    version      = $version
    installedAt  = (Get-Date).ToString('o')
    windhawkRoot = $WindhawkRoot
    dataDir      = $DataDir
    extensionDir = $targetExtensionDir
} | ConvertTo-Json | ForEach-Object { [IO.File]::WriteAllText((Join-Path $DataDir 'installed.json'), $_, (New-Object Text.UTF8Encoding($false))) }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Restart Windhawk (tray icon > Exit, then start it again) to load the feature."
Write-Host "  The translation toolbar appears at the bottom-right of the Windhawk window."

if ($Restart) {
    Write-Host "  Restarting Windhawk..."
    & (Join-Path $WindhawkRoot 'windhawk.exe') -restart
}
