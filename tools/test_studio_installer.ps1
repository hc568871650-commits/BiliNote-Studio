param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][string]$TestRoot,
    [string]$ProductionRoot = "",
    [switch]$WithoutFFmpeg
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$test = [IO.Path]::GetFullPath($TestRoot)
if (-not $test.StartsWith((Join-Path $workspace '.BiliNote-dev') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'TestRoot must be an isolated directory in .BiliNote-dev'
}
if (Test-Path $test) { throw 'Use a fresh TestRoot; existing evidence is preserved' }
if (Get-NetTCPConnection -State Listen -LocalPort 38484 -ErrorAction SilentlyContinue) { throw 'Studio port already in use' }
if (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BiliNote Studio') {
    throw 'An installed Studio identity already exists; do not overwrite it during acceptance'
}
New-Item -ItemType Directory -Path $test | Out-Null
$install = Join-Path $test 'Program'
$data = Join-Path $test 'UserData'
$result = [ordered]@{ installer = [IO.Path]::GetFullPath($Installer); test_root=$test; checks=@(); started=(Get-Date).ToString('o') }
$productionBefore = @(Get-CimInstance Win32_Process | Where-Object {$ProductionRoot -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ProductionRoot, [StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,Name,ExecutablePath)
$result.production_before = $productionBefore
$productionHashes = @($productionBefore | ForEach-Object { Get-FileHash -LiteralPath $_.ExecutablePath -Algorithm SHA256 | Select-Object Path,Hash })
$result.production_binary_hashes_before = $productionHashes
$priorOverride = [Environment]::GetEnvironmentVariable('BILINOTE_STUDIO_DATA_ROOT', 'Process')
$priorPath = $env:PATH
$env:BILINOTE_STUDIO_DATA_ROOT = $data
if ($WithoutFFmpeg) { $env:PATH = Join-Path $env:SystemRoot 'System32' }

function Install-Package {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$install") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    if (-not (Test-Path (Join-Path $install 'BiliNoteStudio.exe'))) { throw 'Installed executable missing' }
}
function Start-Studio {
    $script:app = Start-Process -FilePath (Join-Path $install 'BiliNoteStudio.exe') -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(75)
    do {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:38484/api/sys_health' -TimeoutSec 3
            if ($health.code -eq 0) { return $health }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw 'Studio backend did not become healthy'
}
function Stop-Studio {
    Start-Process -FilePath (Join-Path $install 'BiliNoteStudio.exe') -ArgumentList '--quit' -Wait -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $remaining = @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)})
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'Studio or backend remained after graceful quit'
}
try {
    Install-Package
    $result.checks += 'fresh NSIS installation exit 0'
    $result.first_health = Start-Studio
    $result.checks += 'installed Studio business health code 0'
    if ($WithoutFFmpeg) {
        if ($result.first_health.data.ffmpeg -ne 'missing') { throw 'FFmpeg unexpectedly resolved in isolated missing-dependency test' }
        $result.checks += 'backend remains healthy without external FFmpeg'
    }
    $result.window_title = (Get-Process -Id $app.Id).MainWindowTitle
    $library = Invoke-RestMethod 'http://127.0.0.1:38484/api/note_library' -TimeoutSec 5
    $organizer = Invoke-RestMethod 'http://127.0.0.1:38484/api/organizer/sessions' -TimeoutSec 5
    if ($library.code -ne 0 -or $organizer.code -ne 0) { throw 'Library or organizer metadata endpoint failed' }
    $result.checks += 'library and organizer metadata endpoints returned business code 0'
    $transcriber = Invoke-RestMethod 'http://127.0.0.1:38484/api/transcriber_config' -TimeoutSec 5
    $result.available_transcribers = @($transcriber.data.available_types | ForEach-Object {$_.value})
    if (($result.available_transcribers | Where-Object {$_ -notin @('bcut','kuaishou','groq')}).Count -gt 0) { throw 'Local transcriber unexpectedly advertised' }
    $reject = Invoke-RestMethod 'http://127.0.0.1:38484/api/transcriber_config' -Method Post -ContentType 'application/json' -Body '{"transcriber_type":"fast-whisper"}' -TimeoutSec 5
    if ($reject.code -eq 0) { throw 'Unsupported local transcriber config accepted' }
    $result.local_transcriber_rejected = $reject.msg
    $result.checks += 'online transcribers advertised and local configuration rejected'
    if (-not (Test-Path (Join-Path $data 'bili_note.db'))) { throw 'Database missing from isolated user data' }
    if (Test-Path (Join-Path $install 'bili_note.db')) { throw 'Database leaked into program directory' }
    if (-not (Test-Path (Join-Path $data 'WebView2/EBWebView'))) { throw 'WebView2 did not use the isolated user data root' }
    foreach ($directory in @('config','logs','note_results','WebView2')) {
        if (Test-Path (Join-Path $install $directory)) { throw "Runtime directory leaked into program directory: $directory" }
    }
    $result.checks += 'database, browser profile, config and logs isolated from program files'
    New-Item -ItemType Directory -Path (Join-Path $data 'config') -Force | Out-Null
    $marker = Join-Path $data 'config/upgrade-preservation-fixture.json'
    '{"preserve":"Studio isolated acceptance fixture"}' | Set-Content -LiteralPath $marker -Encoding utf8
    Stop-Studio
    $result.checks += 'graceful desktop quit also stopped backend'
    $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
    $databaseHash = (Get-FileHash -LiteralPath (Join-Path $data 'bili_note.db') -Algorithm SHA256).Hash
    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BiliNote Studio'
    $registeredInstall = ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation).Trim('"')
    if ([IO.Path]::GetFullPath($registeredInstall).TrimEnd('\') -ne $install.TrimEnd('\')) { throw 'Upgrade test registry identity does not belong to isolated installation' }
    Set-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value '0.0.0-preview.0'
    Install-Package
    $result.checks += 'upgrade from simulated lower-version installer metadata completed exit 0'
    if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -ne $markerHash) { throw 'Reinstall changed user config' }
    if ((Get-FileHash -LiteralPath (Join-Path $data 'bili_note.db') -Algorithm SHA256).Hash -ne $databaseHash) { throw 'Reinstall changed database' }
    $result.second_health = Start-Studio
    Stop-Studio
    if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -ne $markerHash) { throw 'Relaunch changed fixture config' }
    $result.database_sha256_before_upgrade = $databaseHash
    $result.database_sha256_after_upgrade_launch = (Get-FileHash -LiteralPath (Join-Path $data 'bili_note.db') -Algorithm SHA256).Hash
    if ($result.database_sha256_after_upgrade_launch -ne $databaseHash) { throw 'Upgrade relaunch changed the existing database bytes' }
    $result.checks += 'reinstall and relaunch preserved user config and database before launch'
    $uninstall = Join-Path $install 'uninstall.exe'
    if (-not (Test-Path $uninstall)) { throw 'Uninstaller missing' }
    $process = Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw 'Uninstall failed' }
    if (-not (Test-Path $marker)) { throw 'Uninstall removed user data' }
    $result.checks += 'uninstall completed and retained user data'
    $result.production_after = @(Get-CimInstance Win32_Process | Where-Object {$ProductionRoot -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ProductionRoot, [StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,Name,ExecutablePath)
    if (($productionBefore | ConvertTo-Json -Compress) -ne ($result.production_after | ConvertTo-Json -Compress)) { throw 'Production process identity changed during acceptance' }
    $result.production_binary_hashes_after = @($result.production_after | ForEach-Object { Get-FileHash -LiteralPath $_.ExecutablePath -Algorithm SHA256 | Select-Object Path,Hash })
    if (($productionHashes | ConvertTo-Json -Compress) -ne ($result.production_binary_hashes_after | ConvertTo-Json -Compress)) { throw 'Production binaries changed during acceptance' }
    $result.checks += 'production process identity unchanged'
    $result.success = $true
} catch {
    $result.success = $false
    $result.error = $_.ToString()
    throw
} finally {
    [Environment]::SetEnvironmentVariable('BILINOTE_STUDIO_DATA_ROOT', $priorOverride, 'Process')
    $env:PATH = $priorPath
    $result.finished = (Get-Date).ToString('o')
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $test 'acceptance.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 10
