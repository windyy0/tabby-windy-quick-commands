param([switch]$Install)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wqc-install-tests-" + [guid]::NewGuid())
$ProfilePath = Join-Path $TestRoot 'profile with spaces'
$StablePath = Join-Path $ProfilePath 'windy-quick-commands'
$DevDataPath = Join-Path $ProfilePath 'windy-quick-commands-dev'
$DataScript = Join-Path $ProjectRoot 'scripts/clean-tabby-dev-data.ps1'
$InstallScript = Join-Path $ProjectRoot 'scripts/install-tabby-plugin.ps1'
. (Join-Path $ProjectRoot 'scripts/tabby-path-safety.ps1')

function Assert-Test ($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# Minimal private fixtures for deletion/preservation checks, never installed as sample data.
function New-DevTestData {
    New-Item -ItemType Directory -Path $DevDataPath -Force | Out-Null
    foreach ($FileName in @('plugin-config.json', 'plugin-config.backup.json', 'logs.json', 'command-stats.json', 'update-cache.json')) {
        [System.IO.File]::WriteAllText((Join-Path $DevDataPath $FileName), '{"commands":[],"sentinel":"dev-data"}')
    }
}

# Only these temporary-profile tests mock process discovery. The production command cannot bypass it.
function Get-Process { return @() }

try {
    New-Item -ItemType Directory -Path $StablePath -Force | Out-Null
    $StableConfigPath = Join-Path $StablePath 'plugin-config.json'
    [System.IO.File]::WriteAllText($StableConfigPath, '{"commands":[{"id":"stable-sentinel"}]}')
    $YamlPath = Join-Path $ProfilePath 'config.yaml'
    [System.IO.File]::WriteAllText($YamlPath, "windyCommandCenter:`n  commands: []`nhotkeys: {}`n")
    $OriginalConfigHash = (Get-FileHash -LiteralPath $StableConfigPath).Hash
    $OriginalYamlHash = (Get-FileHash -LiteralPath $YamlPath).Hash

    New-DevTestData
    & $DataScript -TabbyConfigDir $ProfilePath
    Assert-Test (!(Test-Path -LiteralPath $DevDataPath)) 'Clear must remove the entire dev data directory'
    & $DataScript -TabbyConfigDir $ProfilePath
    New-DevTestData

    # Scope mocks to these tests. No test may discover, close or restart real Tabby.
    & {
        . (Join-Path $ProjectRoot 'scripts/tabby-dev-clean.ps1')
        $LocaleProfile = Join-Path $TestRoot 'locale profile'
        New-Item -ItemType Directory -Path $LocaleProfile | Out-Null
        $LocaleFile = Join-Path $LocaleProfile 'config.yaml'
        function Get-UICulture { [Globalization.CultureInfo]::GetCultureInfo('en-US') }
        foreach ($Case in @(
            @{ Yaml = 'language: zh-CN'; Expected = 'zh' },
            @{ Yaml = 'language: ZH_tw'; Expected = 'zh' },
            @{ Yaml = 'language: en-US'; Expected = 'en' },
            @{ Yaml = 'language: de-DE'; Expected = 'en' },
            @{ Yaml = 'language: [broken'; Expected = 'en' },
            @{ Yaml = 'language: 123'; Expected = 'en' },
            @{ Yaml = 'hotkeys: {}'; Expected = 'en' }
        )) {
            [IO.File]::WriteAllText($LocaleFile, $Case.Yaml)
            Assert-Test ((Get-TabbyCleanLanguage $LocaleProfile) -eq $Case.Expected) "Locale: $($Case.Yaml)"
        }
        function Get-UICulture { [Globalization.CultureInfo]::GetCultureInfo('zh-CN') }
        Assert-Test ((Get-TabbyCleanLanguage $LocaleProfile) -eq 'zh') 'Unset language must fall back to Windows UI language'
        Assert-Test ((Get-TabbyCleanLanguage (Join-Path $TestRoot 'missing')) -eq 'zh') 'Missing config must fall back'
        [IO.File]::WriteAllText($LocaleFile, 'language: [broken')
        Assert-Test ((Get-TabbyCleanLanguage $LocaleProfile) -eq 'zh') 'Malformed config must fall back'
        Remove-Item -LiteralPath $LocaleFile
        New-Item -ItemType Directory -Path $LocaleFile | Out-Null
        Assert-Test ((Get-TabbyCleanLanguage $LocaleProfile) -eq 'zh') 'Unreadable config must fall back'
        foreach ($Language in @('zh', 'en')) {
            $Rejected = $false
            try { Read-TabbyCleanConfirmation $Language } catch { $Rejected = $_.Exception.Message -eq (Get-TabbyCleanMessage $Language 'NoInput') }
            Assert-Test $Rejected 'Noninteractive input must never count as Enter'
        }
        $InputState = @{ Line = '' }
        function Read-TabbyCleanInput { return $InputState.Line }
        Assert-Test (Read-TabbyCleanConfirmation 'en') 'Only an empty Enter confirms'
        foreach ($Line in @('y', 'yes', ' ', '确认')) {
            $InputState.Line = $Line
            Assert-Test (!(Read-TabbyCleanConfirmation 'zh')) 'Other input must cancel'
        }
        $InputState.Line = $null
        $Rejected = $false
        try { Read-TabbyCleanConfirmation 'en' } catch { $Rejected = $_.Exception.Message -match 'Interactive confirmation' }
        Assert-Test $Rejected 'EOF must not be mistaken for Enter'
    }

    & {
        . (Join-Path $ProjectRoot 'scripts/tabby-dev-clean.ps1')
        $FakeExe = Join-Path $TestRoot 'Tabby with spaces.exe'
        [IO.File]::WriteAllText($FakeExe, 'not executable; never launched')
        $FakeProcess = [pscustomobject]@{ Id = 123; ProcessName = 'Tabby'; StartTime = [datetime]'2026-01-01' }
        $AddedProcess = [pscustomobject]@{ Id = 124; ProcessName = 'Tabby'; StartTime = [datetime]'2026-01-02' }
        $State = @{ Mode = ''; Running = $true; Events = [Collections.Generic.List[string]]::new(); Logs = [Collections.Generic.List[string]]::new(); Queries = 0; Confirmed = $false }
        function Get-TabbyCleanLanguage { return 'en' }
        function Get-TabbyCleanProcesses {
            $State.Queries++
            if ($State.Confirmed -and $State.Mode -eq 'unreadable-at-confirmation') {
                return [pscustomobject]@{ Id = 124; StartTime = $null; HasExited = $false }
            }
            if ($State.Running -or ($State.Mode -eq 'race' -and $State.Queries -gt 1)) { return $FakeProcess }
        }
        function Resolve-TabbyExe {
            $State.Events.Add('resolve')
            if ($State.Mode -ne 'missing-exe') { return $FakeExe }
        }
        function Read-TabbyCleanConfirmation {
            $State.Events.Add('confirm')
            if ($State.Mode -eq 'no-input') { throw (Get-TabbyCleanMessage 'en' 'NoInput') }
            $State.Confirmed = $true
            if ($State.Mode -eq 'changed-during-prompt') {
                $FakeProcess.Id = $AddedProcess.Id
                $FakeProcess.StartTime = $AddedProcess.StartTime
            }
            return $State.Mode -ne 'cancel'
        }
        function Wait-TabbyCleanExit {
            $State.Events.Add('close')
            if ($State.Mode -eq 'timeout') { throw (Get-TabbyCleanMessage 'en' 'Timeout') }
            $State.Running = $false
        }
        function Remove-Item {
            param($LiteralPath, [switch]$Recurse, [switch]$Force)
            Assert-Test (!$State.Running) 'Deletion must happen only after shutdown'
            Assert-Test ($LiteralPath -eq $DevDataPath) 'Only Dev data can be deleted'
            $State.Events.Add('clear')
            if ($State.Mode -eq 'delete-error') { throw 'simulated deletion error' }
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
        }
        function Start-TabbyAfterClean {
            $State.Events.Add('restart')
            Assert-Test (!(Test-Path -LiteralPath $DevDataPath)) 'Restart must happen after clearing'
            if ($State.Mode -eq 'restart-error') { throw 'simulated restart error' }
        }
        function Start-TabbyCleanWorker {
            param($Request)
            $State.Events.Add('handoff')
            $State.Request = $Request
            $State.Logs.Add($Request.LogPath)
            if ($State.Mode -eq 'worker-error') { throw 'simulated worker launch error' }
            # Run the operation synchronously under mocks, retaining real result/log handling.
            $Result = @{ Success = $false; Message = '' }
            try { Invoke-TabbyCleanOperation $Request; $Result.Success = $true } catch { $Result.Message = $_.Exception.Message }
            [IO.File]::WriteAllText($Request.LogPath + '.result.json', ($Result | ConvertTo-Json))
            return 456
        }
        try {
            Invoke-TabbyDevClean $ProfilePath
            Assert-Test (($State.Events -join ',') -eq 'resolve,confirm,handoff,close,clear,restart') 'Running flow must confirm, close, clear, then restart'
            Assert-Test (!(Test-Path -LiteralPath $DevDataPath)) 'Confirmed flow must clear data'
            Assert-Test (([IO.File]::ReadAllText($State.Logs[0])) -match 'Tabby restarted') 'Worker must log completion'
            New-DevTestData
            $State.Mode = 'changed-during-prompt'; $State.Running = $true; $State.Events.Clear(); $State.Confirmed = $false
            Invoke-TabbyDevClean $ProfilePath
            Assert-Test ($State.Request.ExpectedProcesses.Count -eq 1 -and $State.Request.ExpectedProcesses[0] -eq (Get-TabbyCleanProcessKey $AddedProcess)) 'Authorization must snapshot current processes at Enter, not before displaying the prompt'
            Assert-Test (($State.Events -join ',') -eq 'resolve,confirm,handoff,close,clear,restart') 'Processes changed during the prompt must still follow confirmed shutdown order'
            Assert-Test (([IO.File]::ReadAllText($State.Logs[-1])) -match 'identities at confirmation.*124:') 'The confirmation snapshot must be recorded for diagnosis'
            foreach ($Case in @(
                @{ Mode = 'cancel'; Error = ''; Deleted = $false },
                @{ Mode = 'no-input'; Error = 'Interactive confirmation'; Deleted = $false },
                @{ Mode = 'missing-exe'; Error = 'executable not found'; Deleted = $false },
                @{ Mode = 'unreadable-at-confirmation'; Error = 'Complete information for Tabby process 124'; Deleted = $false },
                @{ Mode = 'timeout'; Error = 'within 10 seconds'; Deleted = $false },
                @{ Mode = 'delete-error'; Error = 'Clearing failed'; Deleted = $false },
                @{ Mode = 'restart-error'; Error = 'Data was cleared, but restart failed'; Deleted = $true },
                @{ Mode = 'worker-error'; Error = 'successful clearing cannot be confirmed'; Deleted = $false }
            )) {
                New-DevTestData
                $State.Mode = $Case.Mode; $State.Running = $true; $State.Events.Clear(); $State.Queries = 0; $State.Confirmed = $false
                $Failure = ''
                try { Invoke-TabbyDevClean $ProfilePath } catch { $Failure = $_.Exception.Message }
                if ($Case.Error) { Assert-Test ($Failure -match $Case.Error) "$($Case.Mode): $Failure" } else { Assert-Test (!$Failure) 'Cancellation should return without an error' }
                Assert-Test ((!(Test-Path -LiteralPath $DevDataPath)) -eq $Case.Deleted) "$($Case.Mode): unexpected data changes"
                if (!$Case.Deleted) { Assert-Test (!$State.Events.Contains('restart')) "$($Case.Mode): must not restart" }
                if ($Case.Mode -in @('cancel', 'no-input', 'missing-exe', 'unreadable-at-confirmation')) { Assert-Test (!$State.Events.Contains('handoff')) 'No worker before confirmation/preflight' }
            }
            New-DevTestData
            $State.Mode = ''; $State.Running = $false; $State.Events.Clear()
            Invoke-TabbyDevClean $ProfilePath
            Assert-Test (($State.Events -join ',') -eq 'clear') 'Stopped flow must only clear'
            Invoke-TabbyDevClean $ProfilePath
            Assert-Test (($State.Events -join ',') -eq 'clear') 'Repeated clear must not restart or prompt'
            New-DevTestData
            $State.Mode = 'race'; $State.Queries = 0; $State.Events.Clear()
            $Failure = ''
            try { Invoke-TabbyDevClean $ProfilePath } catch { $Failure = $_.Exception.Message }
            Assert-Test ($Failure -match 'Tabby process was detected') 'Recheck processes immediately before deleting'
            Assert-Test ((Test-Path -LiteralPath $DevDataPath) -and !$State.Events.Count) 'New process must prevent deletion'

            # A vanished worker with no completion record must never be reported as success.
            $LostLog = Join-Path $TestRoot 'lost-worker.log'
            [IO.File]::WriteAllText($LostLog, '')
            $Failure = ''
            try { Wait-TabbyCleanWorker 456 @{ Language = 'zh'; LogPath = $LostLog } } catch { $Failure = $_.Exception.Message }
            Assert-Test ($Failure -match '不能确认清理成功') 'Missing worker result must be a localized failure'
            [IO.File]::WriteAllText($LostLog + '.result.json', '{"Success":"false","Message":""}')
            $Failure = ''
            try { Wait-TabbyCleanWorker 456 @{ Language = 'zh'; LogPath = $LostLog } } catch { $Failure = $_.Exception.Message }
            Assert-Test ($Failure -match '不能确认清理成功') 'Malformed completion record must not count as success'
        } finally {
            foreach ($Log in $State.Logs) {
                foreach ($File in @($Log, $Log + '.result.json')) {
                    if (Test-Path -LiteralPath $File) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $File -Force }
                }
            }
        }
    }

    & {
        . (Join-Path $ProjectRoot 'scripts/tabby-dev-clean.ps1')
        $State = @{ Running = $true; Closes = 0; Clock = [datetime]'2026-01-01'; Hang = $false }
        $FakeTabbyProcess = [pscustomobject]@{ Id = 123; ProcessName = 'Tabby'; StartTime = [datetime]'2026-01-01'; MainWindowHandle = [intptr]42; HasExited = $false }
        $FakeTabbyProcess | Add-Member ScriptMethod CloseMainWindow { $State.Closes++; if (!$State.Hang) { $State.Running = $false }; return $true }
        function Get-TabbyCleanProcesses { if ($State.Running) { return $FakeTabbyProcess } }
        function Get-Date { $State.Clock = $State.Clock.AddSeconds(1); return $State.Clock }
        function Start-Sleep { }
        function Stop-Process { throw 'Tests forbid forced shutdown' }
        Wait-TabbyCleanExit @((Get-TabbyCleanProcessKey $FakeTabbyProcess)) 'en'
        Assert-Test ($State.Closes -eq 1 -and !$State.Running) 'Request normal window close and wait for process exit'
        $State.Running = $true; $State.Hang = $true; $State.Closes = 0
        $Failure = ''
        try { Wait-TabbyCleanExit @((Get-TabbyCleanProcessKey $FakeTabbyProcess)) 'zh' } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match '10 秒内未完全退出') 'Shutdown timeout must be localized'
        Assert-Test ($State.Closes -eq 1 -and $State.Running) 'Do not repeatedly close a blocked window or force termination'
        $Failure = ''
        try { Wait-TabbyCleanExit @('different-process') 'en' } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match 'new Tabby process') 'Never close a process that appeared after confirmation'
        Assert-Test ($Failure -match '123:' -and $Failure -match 'different-process') 'Identity mismatch errors must include both observed and authorized identities'

        # Real processes can lose properties while their windows/child processes exit.
        # Missing properties must be retried, never treated as an exited process.
        $ExpectedKey = Get-TabbyCleanProcessKey $FakeTabbyProcess
        foreach ($MissingProperty in @('StartTime', 'MainWindowHandle')) {
            $OriginalValue = $FakeTabbyProcess.$MissingProperty
            try {
                $FakeTabbyProcess.$MissingProperty = $null
                $State.Queries = 0; $State.Closes = 0
                function Get-TabbyCleanProcesses {
                    $State.Queries++
                    if ($State.Queries -le 2) { return $FakeTabbyProcess }
                }
                Wait-TabbyCleanExit @($ExpectedKey) 'en'
                Assert-Test ($State.Queries -eq 5 -and $State.Closes -eq 0) "Missing $MissingProperty must wait for stable process disappearance"
                function Get-TabbyCleanProcesses { return $FakeTabbyProcess }
                $Failure = ''
                try { Wait-TabbyCleanExit @($ExpectedKey) 'zh' } catch { $Failure = $_.Exception.Message }
                Assert-Test ($Failure -match '10 秒内未完全退出') "Persistent missing $MissingProperty must time out, not clear data or crash on null"
                Assert-Test ($State.Closes -eq 0) 'Never send close requests with incomplete process information'
            } finally { $FakeTabbyProcess.$MissingProperty = $OriginalValue }
        }
        $State.Queries = 0; $State.Closes = 0; $State.Running = $true; $State.Hang = $false
        function Get-TabbyCleanProcesses {
            $State.Queries++
            if ($State.Queries -eq 1) { return [pscustomobject]@{ Id = $FakeTabbyProcess.Id; StartTime = $null } }
            if ($State.Running) { return $FakeTabbyProcess }
        }
        Wait-TabbyCleanExit @($ExpectedKey) 'en'
        Assert-Test ($State.Queries -eq 5 -and $State.Closes -eq 1) 'Transient missing identity must recover, close the verified process normally and wait for stable exit'
        $ExpiredProcess = [pscustomobject]@{ Id = 987 }
        $ExpiredProcess | Add-Member ScriptProperty StartTime { throw 'Process already exited' }
        Assert-Test ($null -eq (Get-TabbyCleanProcessKey $ExpiredProcess)) 'A failed timestamp getter must yield an unknown identity without a null-method exception'

        # Once identity becomes readable, a newly started process is still rejected.
        $State.Queries = 0
        function Get-TabbyCleanProcesses {
            $State.Queries++
            if ($State.Queries -eq 1) { return [pscustomobject]@{ Id = 999; StartTime = $null } }
            return [pscustomobject]@{ Id = 999; StartTime = [datetime]'2026-01-02' }
        }
        $Failure = ''
        try { Wait-TabbyCleanExit @($ExpectedKey) 'en' } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match 'new Tabby process') 'Retry must not waive process identity validation'

        # A process that remains after a close request still blocks deletion,
        # but is given the shutdown deadline instead of causing an early abort.
        $State.Queries = 0; $State.Closes = 0; $State.Hang = $false
        function Get-TabbyCleanProcesses {
            $State.Queries++
            if ($State.Queries -eq 1) { return $FakeTabbyProcess }
            return [pscustomobject]@{ Id = 999; StartTime = [datetime]'2026-01-02' }
        }
        $Failure = ''
        try { Wait-TabbyCleanExit @($ExpectedKey) 'zh' } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match '新启动的 Tabby 进程' -and $Failure -match '999:') 'A new process after confirmation must remain a localized safe failure'
        Assert-Test ($State.Queries -gt 2) 'An unconfirmed process must be allowed to exit naturally before reporting failure'
        Assert-Test ($State.Closes -eq 1 -and (Test-Path -LiteralPath $DevDataPath)) 'Do not close a new process or remove data after detecting it'

        # A short-lived process can appear while the confirmed instance is
        # shutting down. It must delay clearing, not abort the whole operation.
        foreach ($TransientId in @(999, $FakeTabbyProcess.Id)) {
            $TransientProcess = [pscustomobject]@{ Id = $TransientId; StartTime = [datetime]'2026-01-02'; MainWindowHandle = [intptr]43 }
            $TransientProcess | Add-Member ScriptMethod CloseMainWindow { throw 'Never close an unconfirmed process, including a reused PID' }
            $State.Queries = 0; $State.Closes = 0; $State.Hang = $false
            function Get-TabbyCleanProcesses {
                $State.Queries++
                if ($State.Queries -eq 1) { return $FakeTabbyProcess }
                # Include an empty sample between appearances: a single empty
                # enumeration is not sufficient proof of a settled shutdown.
                if ($State.Queries -in @(2, 4)) { return $TransientProcess }
            }
            $TransientLog = Join-Path $TestRoot "transient-$TransientId.log"
            function Get-TabbyCleanProcessDetails { return 'ParentPID=123, Type=utility, Exe=test-only' }
            Wait-TabbyCleanExit @($ExpectedKey) 'en' @{ Language = 'en'; LogPath = $TransientLog }
            Assert-Test ($State.Queries -ge 7 -and $State.Closes -eq 1) 'Wait for transient processes and three empty samples without closing an unconfirmed process'
            Assert-Test (Test-Path -LiteralPath $DevDataPath) 'The wait itself must not modify data'
            $TransientLines = @(Get-Content -LiteralPath $TransientLog)
            Assert-Test ($TransientLines.Count -eq 1 -and $TransientLines[0] -match 'ParentPID=123, Type=utility') 'Log each new identity once with process diagnostics'
        }

        & {
            function Get-TabbyCleanLanguage { return 'zh' }
            function Get-TabbyCleanProcesses { return [pscustomobject]@{ Id = 987; StartTime = $null; HasExited = $false } }
            function Resolve-TabbyExe { return (Join-Path $TestRoot 'Tabby with spaces.exe') }
            function Read-TabbyCleanConfirmation { throw 'Must not prompt without verified process identity' }
            $Failure = ''
            try { Invoke-TabbyDevClean $ProfilePath } catch { $Failure = $_.Exception.Message }
            Assert-Test ($Failure -match '无法读取 Tabby 进程 987 的完整信息') 'Missing identity before confirmation must produce a localized safe failure'
            Assert-Test (Test-Path -LiteralPath $DevDataPath) 'Missing preflight process information must preserve data'
        }

        $FakeExe = Join-Path $TestRoot 'Tabby with spaces.exe'
        $State.RestartVisible = $true
        function Start-Process {
            param($FilePath, $ArgumentList, $WindowStyle)
            Assert-Test ($FilePath -eq 'explorer.exe' -and $ArgumentList -eq "`"$FakeExe`"" -and $WindowStyle -eq 'Hidden') 'Use existing hidden Explorer launch with quoted executable'
        }
        function Get-TabbyCleanProcesses {
            if ($State.RestartVisible) { [pscustomobject]@{ StartTime = $State.Clock.AddSeconds(1); Path = $FakeExe } }
        }
        Start-TabbyAfterClean $FakeExe 'en'
        $State.RestartVisible = $false
        $Failure = ''
        try { Start-TabbyAfterClean $FakeExe 'en' } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match 'No restarted Tabby process') 'A launch request is not proof of restart'
    }

    # Real detached-process smoke test: only writes markers in this temporary test root.
    # It does not invoke the cleanup operation or interact with any Tabby process.
    & {
        . (Join-Path $ProjectRoot 'scripts/tabby-dev-clean.ps1')
        $Launcher = Join-Path $TestRoot 'detached launcher.ps1'
        $Marker = Join-Path $TestRoot 'detached completed '' $ [marker].txt'
        $Library = Join-Path $ProjectRoot 'scripts/tabby-dev-clean.ps1'
        $LauncherCode = @'
param($Library, $Marker)
$ErrorActionPreference = 'Stop'
. $Library
$ExpectedProcesses = @(Get-TabbyCleanProcessSnapshot @(Get-Process -Id $PID) 'en')
$Payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ ParentId = $PID; Marker = $Marker; Library = $Library; ExpectedProcesses = $ExpectedProcesses } | ConvertTo-Json -Compress)))
$Code = @'
$ErrorActionPreference = 'Stop'
$Data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
. $Data.Library
$ActualKey = Get-TabbyCleanProcessKey (Get-Process -Id $Data.ParentId)
if ($ActualKey -notin $Data.ExpectedProcesses) { throw 'Process identity changed during detached handoff' }
[IO.File]::WriteAllText($Data.Marker + '.ready', 'ready')
$Deadline = (Get-Date).AddSeconds(15)
while (Get-Process -Id $Data.ParentId -ErrorAction SilentlyContinue) {
    if ((Get-Date) -ge $Deadline) { exit 1 }
    Start-Sleep -Milliseconds 100
}
[IO.File]::WriteAllText($Data.Marker, 'worker survived parent exit')
'__END__
$ChildId = Start-TabbyCleanDetachedProcess $Code.Replace('__PAYLOAD__', $Payload)
$Deadline = (Get-Date).AddSeconds(10)
while (!(Test-Path -LiteralPath ($Marker + '.ready'))) {
    if ((Get-Date) -ge $Deadline) { throw 'Detached worker did not start' }
    Start-Sleep -Milliseconds 100
}
'@
        [IO.File]::WriteAllText($Launcher, $LauncherCode.Replace("'__END__", "'@"))
        & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $Launcher $Library $Marker
        Assert-Test ($LASTEXITCODE -eq 0) 'Detached launcher must succeed'
        $Deadline = (Get-Date).AddSeconds(10)
        while (!(Test-Path -LiteralPath $Marker) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 100 }
        Assert-Test ((Test-Path -LiteralPath $Marker) -and ([IO.File]::ReadAllText($Marker) -eq 'worker survived parent exit')) 'Worker must survive its invoking process exiting'

        # Exercise the actual worker bootstrap/serialization/result protocol, failing
        # preflight on purpose before it can query or close any real Tabby process.
        $Request = [pscustomobject]@{
            TabbyConfigDir = $ProfilePath; TabbyExe = (Join-Path $TestRoot 'missing.exe')
            Language = 'zh'; LogPath = (Join-Path $TestRoot 'worker '' $ [result].log'); ExpectedProcesses = @()
        }
        [IO.File]::WriteAllText($Request.LogPath, '')
        $WorkerId = Start-TabbyCleanWorker $Request
        $Deadline = (Get-Date).AddSeconds(10)
        while (!(Test-Path -LiteralPath ($Request.LogPath + '.result.json')) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 100 }
        Assert-Test (Test-Path -LiteralPath ($Request.LogPath + '.result.json')) 'Real worker must publish a completion record'
        $Failure = ''
        try { Wait-TabbyCleanWorker $WorkerId $Request } catch { $Failure = $_.Exception.Message }
        Assert-Test ($Failure -match '无法找到 Tabby 可执行文件') 'Worker must return its localized failure'
        Assert-Test ((Test-Path -LiteralPath $DevDataPath) -and ([IO.File]::ReadAllText($Request.LogPath)) -match '未清理数据') 'Worker must preserve data on preflight failure and log the result'
        Assert-Test (([IO.File]::ReadAllText($Request.LogPath)) -match 'Invoke-TabbyCleanOperation.*line \d+') 'Worker diagnostics must retain the original failure location'
    }

    & $DataScript -TabbyConfigDir $ProfilePath
    New-Item -ItemType Junction -Path $DevDataPath -Target $StablePath | Out-Null
    try {
        $Rejected = $false
        try { & $DataScript -TabbyConfigDir $ProfilePath } catch { $Rejected = $_.Exception.Message -match 'symlink or junction' }
        Assert-Test $Rejected 'Clear must reject a junction pointing at stable data'
    } finally {
        # Remove only this junction, never recurse through it.
        Remove-Item -LiteralPath $DevDataPath -Force
    }
    New-DevTestData

    $NpmCli = $env:npm_execpath
    if (!$NpmCli) { $NpmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd).Source) 'node_modules/npm/bin/npm-cli.js' }
    & node (Join-Path $PSScriptRoot 'test-tabby-uninstall.cjs') (Join-Path $TestRoot 'uninstall regressions') $NpmCli
    Assert-Test ($LASTEXITCODE -eq 0) 'Client uninstall regression checks failed'

    if ($Install) {
        Push-Location $ProjectRoot
        try {
            npm run -s build
            if ($LASTEXITCODE -ne 0) { throw 'Stable build failed' }
        } finally {
            Pop-Location
        }
        $PluginsPath = Join-Path $ProfilePath 'plugins'
        $StablePackagePath = Join-Path $PluginsPath 'node_modules/tabby-windy-quick-commands'
        New-Item -ItemType Directory -Path $StablePackagePath -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $StablePackagePath 'sentinel.txt'), 'stable installation')
        [System.IO.File]::WriteAllText((Join-Path $PluginsPath 'package.json'), '{"name":"tabby-plugins","dependencies":{"tabby-windy-quick-commands":"1.7.0","tabby-other":"1.0.0"}}')
        $OriginalDevHash = (Get-FileHash -LiteralPath (Join-Path $DevDataPath 'plugin-config.json')).Hash
        & $InstallScript -DevBuild -TabbyPluginsDir $PluginsPath
        & $InstallScript -DevBuild -TabbyPluginsDir $PluginsPath
        $InstalledPath = Join-Path $PluginsPath 'node_modules/tabby-windy-quick-commands-dev'
        $Manifest = Get-Content -LiteralPath (Join-Path $InstalledPath 'package.json') -Raw | ConvertFrom-Json
        Assert-Test ($Manifest.name -eq 'tabby-windy-quick-commands-dev' -and $Manifest.private) 'Dev installation must have its own private package identity'
        Assert-Test ($Manifest.version -match '-dev.local$') 'Dev version must be visibly marked'
        Assert-Test (Test-Path -LiteralPath (Join-Path $InstalledPath $Manifest.main)) 'Installed entry point must exist'
        $Dependencies = (Get-Content -LiteralPath (Join-Path $PluginsPath 'package.json') -Raw | ConvertFrom-Json).dependencies
        Assert-Test ($Dependencies.'tabby-windy-quick-commands' -eq '1.7.0' -and $Dependencies.'tabby-other' -eq '1.0.0') 'Dev installation must preserve existing dependencies'
        Assert-Test ($Dependencies.'tabby-windy-quick-commands-dev' -eq $Manifest.version) 'Dev package must be registered by its actual installed version'
        Assert-Test ((Get-Content -LiteralPath (Join-Path $StablePackagePath 'sentinel.txt') -Raw) -eq 'stable installation') 'Dev installation must preserve the stable package'
        Assert-Test ((Get-FileHash -LiteralPath (Join-Path $DevDataPath 'plugin-config.json')).Hash -eq $OriginalDevHash) 'Reinstalling dev plugin must preserve dev data'
        & $DataScript -TabbyConfigDir $ProfilePath
        Assert-Test (Test-Path -LiteralPath (Join-Path $InstalledPath $Manifest.main)) 'Clearing data must leave the plugin installed'
        & node (Join-Path $PSScriptRoot 'test-tabby-bundle.cjs') (Join-Path $InstalledPath $Manifest.main) $ProfilePath (Join-Path $ProjectRoot 'dist/index.js')
        if ($LASTEXITCODE -ne 0) { throw 'Built dev bundle checks failed' }
        & $DataScript -TabbyConfigDir $ProfilePath
        & node (Join-Path $PSScriptRoot 'test-tabby-bundle.cjs') (Join-Path $InstalledPath $Manifest.main) $ProfilePath (Join-Path $ProjectRoot 'dist/index.js') --after-clean-en
        if ($LASTEXITCODE -ne 0) { throw 'Dev initialization after clearing failed' }
        # The built package also needs a real uninstall check, not just a copied-file check.
        $StableManifestPath = Join-Path $StablePackagePath 'package.json'
        [IO.File]::WriteAllText($StableManifestPath, '{"name":"tabby-windy-quick-commands","version":"1.7.0"}')
        $OtherPackagePath = Join-Path $PluginsPath 'node_modules/tabby-other'
        New-Item -ItemType Directory -Path $OtherPackagePath -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $OtherPackagePath 'package.json'), '{"name":"tabby-other","version":"1.0.0"}')
        New-DevTestData
        & node (Join-Path $PSScriptRoot 'test-tabby-uninstall.cjs') $PluginsPath $NpmCli --installed
        Assert-Test ($LASTEXITCODE -eq 0) 'Built Dev package uninstall failed'
    }

    Assert-Test ((Get-FileHash -LiteralPath $StableConfigPath).Hash -eq $OriginalConfigHash) 'Stable config bytes must remain unchanged'
    Assert-Test ((Get-FileHash -LiteralPath $YamlPath).Hash -eq $OriginalYamlHash) 'Tabby YAML bytes must remain unchanged'
    Write-Host '[PASS] Test install/data isolation and safety checks'
} finally {
    # Validate the exact randomly-created temporary target before recursive cleanup.
    Assert-TabbyChildPath -ParentPath ([System.IO.Path]::GetTempPath()) -Path $TestRoot -ChildName (Split-Path -Leaf $TestRoot)
    if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force }
}
