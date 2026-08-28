param(
    [string]$TabbyPluginsDir = "$env:APPDATA\tabby\plugins",
    [string]$TabbyExe = "",
    [switch]$DevBuild,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "tabby-path-safety.ps1")
. (Join-Path $PSScriptRoot "tabby-process.ps1")

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$PackageName = $PackageJson.name
if ($DevBuild) {
    $PackageName = "$PackageName-dev"
}
$BuildScript = if ($DevBuild) { "build:dev" } else { "build" }
$BuildDirectory = if ($DevBuild) { "dist-dev" } else { "dist" }
$DataDirectoryName = if ($DevBuild) { "windy-quick-commands-dev" } else { "windy-quick-commands" }
$LegacyConfigKey = if ($DevBuild) { "windyCommandCenterDev" } else { "windyCommandCenter" }
$TabbyPluginsDir = [System.IO.Path]::GetFullPath($TabbyPluginsDir)
$InstalledPath = Join-Path $TabbyPluginsDir "node_modules\$PackageName"
Assert-TabbyChildPath -ParentPath (Join-Path $TabbyPluginsDir "node_modules") -Path $InstalledPath -ChildName $PackageName

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

Write-Host "Project: $ProjectRoot"
Write-Host "Tabby plugins: $TabbyPluginsDir"
Write-Host "Channel: $(if ($DevBuild) { 'DEV (isolated data)' } else { 'stable' })"

Push-Location $ProjectRoot
try {
    Write-Host "Building plugin..."
    npm run -s $BuildScript
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin build failed. Existing installation was not changed."
    }
} finally {
    Pop-Location
}

if (!(Test-Path -LiteralPath $TabbyPluginsDir)) {
    New-Item -ItemType Directory -Force -Path $TabbyPluginsDir | Out-Null
}

$PluginsPackageJson = Join-Path $TabbyPluginsDir "package.json"
if (!(Test-Path -LiteralPath $PluginsPackageJson)) {
    Push-Location $TabbyPluginsDir
    try {
        npm init -y | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to initialize Tabby plugins package.json"
        }
    } finally {
        Pop-Location
    }
}

$NodeModulesDir = Join-Path $TabbyPluginsDir "node_modules"
if (!(Test-Path -LiteralPath $NodeModulesDir)) {
    New-Item -ItemType Directory -Force -Path $NodeModulesDir | Out-Null
}

Assert-TabbyChildPath -ParentPath $NodeModulesDir -Path $InstalledPath -ChildName $PackageName
if (Test-Path -LiteralPath $InstalledPath) {
    $ResolvedNodeModules = (Resolve-Path -LiteralPath $NodeModulesDir).Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $ResolvedInstalled = (Resolve-Path -LiteralPath $InstalledPath).Path
    $ExpectedPrefix = $ResolvedNodeModules + [System.IO.Path]::DirectorySeparatorChar
    if (!$ResolvedInstalled.StartsWith($ExpectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside Tabby node_modules: $ResolvedInstalled"
    }
    Remove-Item -LiteralPath $InstalledPath -Recurse -Force
}

Write-Host "Copying minimal plugin files..."
New-Item -ItemType Directory -Force -Path $InstalledPath | Out-Null

$InstalledPackageJson = [ordered]@{
    name = $PackageName
    version = $(if ($DevBuild) { "$($PackageJson.version.Split('+')[0])-dev.local" } else { $PackageJson.version })
    description = $(if ($DevBuild) { "[DEV] $($PackageJson.description)" } else { $PackageJson.description })
    keywords = $PackageJson.keywords
    main = $PackageJson.main
    typings = $PackageJson.typings
    author = $PackageJson.author
    license = $PackageJson.license
}
if ($DevBuild) {
    $InstalledPackageJson.private = $true
}
Write-Utf8NoBom -Path (Join-Path $InstalledPath "package.json") -Value ($InstalledPackageJson | ConvertTo-Json -Depth 10)
Copy-Item -LiteralPath (Join-Path $ProjectRoot "README.md") -Destination $InstalledPath
Copy-Item -LiteralPath (Join-Path $ProjectRoot $BuildDirectory) -Destination (Join-Path $InstalledPath "dist") -Recurse

& node (Join-Path $PSScriptRoot 'register-tabby-plugin.cjs') $TabbyPluginsDir $PackageName
if ($LASTEXITCODE -ne 0) { throw 'Failed to register local plugin metadata. See the error above before using the plugin manager.' }

if (!(Test-Path -LiteralPath (Join-Path $InstalledPath "dist\index.js"))) {
    throw "Install check failed: $InstalledPath"
}

Write-Host ""
Write-Host "Installed:"
Write-Host "  $InstalledPath"
if ($DevBuild) {
    Write-Host "Dev data: $(Join-Path (Split-Path -Parent $TabbyPluginsDir) 'windy-quick-commands-dev')"
    Write-Host "New dev profiles use the same defaults as stable; existing dev data is preserved."
}

if ($Restart) {
    Write-Host ""
    Write-Host "Restarting Tabby..."
    $ResolvedTabbyExe = Resolve-TabbyExe -RequestedPath $TabbyExe
    if (!$ResolvedTabbyExe) {
        Write-Warning "Tabby.exe was not found. Pass -TabbyExe if Tabby is installed in a custom location."
        Write-Warning "Start Tabby manually."
        return
    }
    Write-Host "Tabby executable: $ResolvedTabbyExe"
    $ExistingTabby = @(Get-Process -Name "Tabby" -ErrorAction SilentlyContinue)
    if ($ExistingTabby.Count) {
        $ExistingIds = @($ExistingTabby.Id)
        $ExistingTabby | Stop-Process -Force
        $RemainingTabby = @()
        for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
            Start-Sleep -Milliseconds 300
            $RemainingTabby = @(Get-Process -Name "Tabby" -ErrorAction SilentlyContinue | Where-Object { $ExistingIds -contains $_.Id })
            if (!$RemainingTabby.Count) {
                break
            }
            if ($Attempt -eq 10 -or $Attempt -eq 25) {
                $RemainingTabby | Stop-Process -Force -ErrorAction SilentlyContinue
            }
        }
        if ($RemainingTabby.Count) {
            throw "Tabby did not exit completely. Remaining process IDs: $($RemainingTabby.Id -join ', ')"
        }
    }
    $TabbyConfigPath = Join-Path (Split-Path -Parent $TabbyPluginsDir) "config.yaml"
    $PluginConfigPath = Join-Path (Join-Path (Split-Path -Parent $TabbyPluginsDir) $DataDirectoryName) "plugin-config.json"
    $CleanupScript = Join-Path $ProjectRoot "scripts\cleanup-tabby-config.cjs"
    if ((Test-Path -LiteralPath $CleanupScript) -and (Test-Path -LiteralPath $PluginConfigPath)) {
        & node $CleanupScript $TabbyConfigPath $PluginConfigPath $LegacyConfigKey $DataDirectoryName
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to remove legacy plugin config from Tabby config.yaml"
        }
    }
    Start-Sleep -Milliseconds 500
    $RestartedAfter = Get-Date
    Start-Process -FilePath "explorer.exe" -ArgumentList "`"$ResolvedTabbyExe`"" -WindowStyle Hidden
    $TabbyProcess = @()
    for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
        Start-Sleep -Milliseconds 300
        $TabbyProcess = @(Get-Process -Name "Tabby" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $RestartedAfter })
        if ($TabbyProcess.Count) {
            break
        }
    }
    if ($TabbyProcess) {
        Write-Host "Tabby started: $($TabbyProcess.Id -join ', ')"
    } else {
        Write-Warning "Tabby was launched but no Tabby process is visible yet."
    }
} else {
    Write-Host ""
    if ($DevBuild) {
        Write-Host "Next step: fully restart Tabby, then open Quick Commands (Dev) via the quick commands icon with a D badge."
    } else {
        Write-Host "Next step: fully restart Tabby, then look for the quick commands button in the top-right toolbar."
    }
    Write-Host "Tip: run with -Restart to close and reopen Tabby automatically."
}
