param(
    [string]$TabbyPluginsDir = "$env:APPDATA\tabby\plugins",
    [string]$TabbyExe = "",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$PackageName = $PackageJson.name
$InstalledPath = Join-Path $TabbyPluginsDir "node_modules\$PackageName"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

function Resolve-TabbyExe {
    param(
        [string]$RequestedPath
    )

    $Candidates = @()
    if ($RequestedPath) {
        $Candidates += $RequestedPath
    }
    Get-Process -Name "Tabby" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.MainModule.FileName) {
                $Candidates += $_.MainModule.FileName
            }
        } catch {
            # Some Windows process queries can fail under restricted permissions.
        }
    }
    if ($env:LOCALAPPDATA) {
        $Candidates += (Join-Path $env:LOCALAPPDATA "Programs\Tabby\Tabby.exe")
    }
    if ($env:ProgramFiles) {
        $Candidates += (Join-Path $env:ProgramFiles "Tabby\Tabby.exe")
    }
    if (${env:ProgramFiles(x86)}) {
        $Candidates += (Join-Path ${env:ProgramFiles(x86)} "Tabby\Tabby.exe")
    }
    $Candidates += @(
        "D:\Application\tabby\Tabby.exe",
        "D:\Applications\tabby\Tabby.exe",
        "D:\Program Files\Tabby\Tabby.exe"
    )

    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
            return (Resolve-Path -LiteralPath $Candidate).Path
        }
    }

    $Command = Get-Command "Tabby.exe" -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }

    return $null
}

Write-Host "Project: $ProjectRoot"
Write-Host "Tabby plugins: $TabbyPluginsDir"

if (!(Test-Path -LiteralPath $TabbyPluginsDir)) {
    New-Item -ItemType Directory -Force -Path $TabbyPluginsDir | Out-Null
}

$PluginsPackageJson = Join-Path $TabbyPluginsDir "package.json"
if (!(Test-Path -LiteralPath $PluginsPackageJson)) {
    Push-Location $TabbyPluginsDir
    try {
        npm init -y | Out-Null
    } finally {
        Pop-Location
    }
}

Push-Location $ProjectRoot
try {
    Write-Host "Building plugin..."
    npm run -s build
} finally {
    Pop-Location
}

$NodeModulesDir = Join-Path $TabbyPluginsDir "node_modules"
if (!(Test-Path -LiteralPath $NodeModulesDir)) {
    New-Item -ItemType Directory -Force -Path $NodeModulesDir | Out-Null
}

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
    name = $PackageJson.name
    version = $PackageJson.version
    description = $PackageJson.description
    keywords = $PackageJson.keywords
    main = $PackageJson.main
    typings = $PackageJson.typings
    author = $PackageJson.author
    license = $PackageJson.license
}
Write-Utf8NoBom -Path (Join-Path $InstalledPath "package.json") -Value ($InstalledPackageJson | ConvertTo-Json -Depth 10)
Copy-Item -LiteralPath (Join-Path $ProjectRoot "README.md") -Destination $InstalledPath
Copy-Item -LiteralPath (Join-Path $ProjectRoot "dist") -Destination $InstalledPath -Recurse

if (Test-Path -LiteralPath $PluginsPackageJson) {
    $PluginsPackage = Get-Content -LiteralPath $PluginsPackageJson -Raw | ConvertFrom-Json
    if (!$PluginsPackage.dependencies) {
        $PluginsPackage | Add-Member -MemberType NoteProperty -Name dependencies -Value ([PSCustomObject]@{})
    }
    $DependencyValue = "file:node_modules/$PackageName"
    if ($PluginsPackage.dependencies.PSObject.Properties.Name -contains $PackageName) {
        $PluginsPackage.dependencies.$PackageName = $DependencyValue
    } else {
        $PluginsPackage.dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value $DependencyValue
    }
    Write-Utf8NoBom -Path $PluginsPackageJson -Value ($PluginsPackage | ConvertTo-Json -Depth 20)
}

if (!(Test-Path -LiteralPath $InstalledPath)) {
    throw "Install check failed: $InstalledPath"
}

Write-Host ""
Write-Host "Installed:"
Write-Host "  $InstalledPath"

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
    $PluginConfigPath = Join-Path (Split-Path -Parent $TabbyPluginsDir) "windy-quick-commands\plugin-config.json"
    $CleanupScript = Join-Path $ProjectRoot "scripts\cleanup-tabby-config.cjs"
    if ((Test-Path -LiteralPath $CleanupScript) -and (Test-Path -LiteralPath $PluginConfigPath)) {
        & node $CleanupScript $TabbyConfigPath $PluginConfigPath
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
    Write-Host "Next step: fully restart Tabby, then look for the lightning button in the top-right toolbar."
    Write-Host "Tip: run with -Restart to close and reopen Tabby automatically."
}
