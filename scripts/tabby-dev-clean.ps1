# Shared implementation for the interactive command and its detached worker.
. (Join-Path $PSScriptRoot 'tabby-path-safety.ps1')
. (Join-Path $PSScriptRoot 'tabby-process.ps1')

function Get-TabbyCleanLanguage {
    param([string]$TabbyConfigDir)
    $Locale = $null
    try {
        $Locale = & node (Join-Path $PSScriptRoot 'read-tabby-language.cjs') (Join-Path $TabbyConfigDir 'config.yaml') 2>$null
        if ($LASTEXITCODE -ne 0) { $Locale = $null }
    } catch { $Locale = $null }
    if (!$Locale) { $Locale = (Get-UICulture).Name }
    if ($Locale -match '^zh(?:-|_|$)') { return 'zh' }
    return 'en'
}

function Get-TabbyCleanMessage {
    param([string]$Language, [string]$Key, [object[]]$Values = @())
    $Messages = @{
        Confirm = @('即将关闭 Tabby → 清理 Dev 数据 → 重启 Tabby。终端任务会受影响。按回车确认，Ctrl+C 取消；其他输入取消。', 'About to close Tabby → clear Dev data → restart Tabby. Terminal tasks will be affected. Press Enter to confirm, Ctrl+C or any other input to cancel.')
        NoInput = @('无法交互确认，已停止；请在交互式终端中重新运行。未关闭 Tabby，未清理数据。', 'Interactive confirmation is unavailable. Run again in an interactive terminal. Tabby was not closed and data was not cleared.')
        Cancelled = @('已取消。未关闭 Tabby，未清理数据。', 'Cancelled. Tabby was not closed and data was not cleared.')
        MissingExe = @('无法找到 Tabby 可执行文件。可通过 -TabbyExe 指定路径。未关闭 Tabby，未清理数据。', 'Tabby executable not found. Specify its path with -TabbyExe. Tabby was not closed and data was not cleared.')
        Log = @('后续流程由独立后台进程执行。若此终端关闭，请查看日志：{0}', 'A detached worker will continue the operation. If this terminal closes, check the log: {0}')
        Closing = @('正在请求正常关闭 Tabby，最多等待 10 秒…', 'Requesting normal Tabby shutdown; waiting up to 10 seconds…')
        Timeout = @('Tabby 在 10 秒内未完全退出，已停止。未清理数据；请手动完全关闭 Tabby 后重试。', 'Tabby did not fully exit within 10 seconds. Stopped without clearing data. Fully exit Tabby manually and try again.')
        Running = @('检测到 Tabby 进程，已停止清理，避免缓存回写。', 'A Tabby process was detected. Clearing stopped to prevent cached data from being written back.')
        NewProcess = @('检测到新启动的 Tabby 进程，等待 10 秒后仍未退出，已停止。未清理数据，请完全退出 Tabby 后重试。', 'A new Tabby process was detected and did not exit within 10 seconds. Stopped without clearing data. Fully exit Tabby and try again.')
        NewProcessWaiting = @('关闭期间出现新的 Tabby 进程 {0}，继续等待其自行退出，不向它发送关闭请求。诊断信息：{1}', 'A new Tabby process appeared during shutdown: {0}. Waiting for it to exit without sending it a close request. Diagnostics: {1}')
        ProcessMismatch = @('当前进程标识（PID:启动时间戳）：{0}；回车确认时的进程标识：{1}。', 'Current process identity (PID:start-time ticks): {0}; identities at confirmation: {1}.')
        Snapshot = @('回车确认时的 Tabby 进程标识（PID:启动时间戳）：{0}', 'Tabby process identities at confirmation (PID:start-time ticks): {0}')
        ProcessInfo = @('无法读取 Tabby 进程 {0} 的完整信息，无法安全继续。请手动完全退出 Tabby 后重试。', 'Complete information for Tabby process {0} is unavailable; cannot safely continue. Fully exit Tabby manually and try again.')
        Diagnostics = @('错误位置（用于排查）：{0}', 'Error location (for troubleshooting): {0}')
        Clearing = @('正在清理 Dev 数据：{0}', 'Clearing Dev data: {0}')
        Cleared = @('Dev 数据已清理：{0}', 'Dev data cleared: {0}')
        Preserved = @('Dev 插件仍保留，正式版数据和 Tabby 配置未修改。下次启动使用与正式版相同的默认配置。', 'The Dev plugin remains installed. Stable data and Tabby configuration were not modified. The next launch uses the same defaults as stable.')
        Restarting = @('正在重启 Tabby…', 'Restarting Tabby…')
        Restarted = @('Tabby 已重启。', 'Tabby restarted.')
        RestartFailed = @('已清理，重启失败。请手动启动 Tabby。详情：{0}', 'Data was cleared, but restart failed. Start Tabby manually. Details: {0}')
        NotStarted = @('未检测到重新启动的 Tabby 进程。', 'No restarted Tabby process was detected.')
        CheckFailed = @('清理前检查失败，未关闭 Tabby，未清理数据。详情：{0}', 'Preflight checks failed. Tabby was not closed and data was not cleared. Details: {0}')
        CloseFailed = @('关闭阶段失败，未清理数据。详情：{0}', 'Shutdown failed. Data was not cleared. Details: {0}')
        ClearFailed = @('清理失败，未启动 Tabby；部分文件可能已删除。详情：{0}', 'Clearing failed. Tabby was not started; some files may already have been deleted. Details: {0}')
        WorkerFailed = @('后台执行失败或尚未完成，不能确认清理成功。请查看日志：{0}。详情：{1}', 'The worker failed or has not completed; successful clearing cannot be confirmed. Check the log: {0}. Details: {1}')
    }
    $Index = if ($Language -eq 'zh') { 0 } else { 1 }
    return $Messages[$Key][$Index] -f $Values
}

function Write-TabbyCleanMessage {
    param($Context, [string]$Key, [object[]]$Values = @())
    $Message = Get-TabbyCleanMessage $Context.Language $Key $Values
    if ($Context.LogPath) {
        [System.IO.File]::AppendAllText($Context.LogPath, $Message + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    } else {
        Write-Host $Message
    }
}

function Get-TabbyCleanProcesses {
    # Enumerate without suppressing discovery errors: an error must never mean "closed".
    @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq 'Tabby' })
}

function Get-TabbyCleanProcessKey {
    param($Process)
    # Process properties can become unavailable between enumeration and inspection.
    # An unknown identity is NOT evidence that the process has exited.
    try {
        $StartedAt = $Process.StartTime
        if ($StartedAt -is [datetime]) {
            return "$($Process.Id):$($StartedAt.ToUniversalTime().Ticks)"
        }
    } catch { }
    return $null
}

function Get-TabbyCleanProcessSnapshot {
    param([object[]]$Processes, [string]$Language)
    foreach ($SnapshotProcess in $Processes) {
        $ProcessKey = Get-TabbyCleanProcessKey $SnapshotProcess
        if ($ProcessKey) { $ProcessKey }
        elseif ($SnapshotProcess.HasExited -ne $true) {
            throw (Get-TabbyCleanMessage $Language 'ProcessInfo' @($SnapshotProcess.Id))
        }
    }
}

function Read-TabbyCleanInput {
    param([string]$Language)
    if ([Console]::IsInputRedirected -or [Environment]::GetCommandLineArgs() -match '^-(NonInteractive|NonI)$') {
        throw (Get-TabbyCleanMessage $Language 'NoInput')
    }
    try { return [Console]::ReadLine() } catch { throw (Get-TabbyCleanMessage $Language 'NoInput') }
}

function Read-TabbyCleanConfirmation {
    param([string]$Language)
    $Line = Read-TabbyCleanInput $Language
    if ($null -eq $Line) { throw (Get-TabbyCleanMessage $Language 'NoInput') }
    return $Line -ceq ''
}

function Get-TabbyCleanProcessDetails {
    param($Process)
    # Best-effort diagnostics only. Do not log the full command line: terminal
    # arguments may contain user data. Discovery/exit decisions never use this.
    try {
        $Info = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Process.Id)" -ErrorAction Stop
        if ($Info) {
            $ProcessType = '(no --type flag)'
            if ($Info.CommandLine -match '(?:^|\s)--type=([a-zA-Z0-9_.-]+)') { $ProcessType = $Matches[1] }
            return "ParentPID=$($Info.ParentProcessId), Type=$ProcessType, Exe=$($Info.ExecutablePath)"
        }
    } catch { }
    return 'Process details unavailable (the process may have already exited).'
}

function Wait-TabbyCleanExit {
    param([string[]]$ExpectedProcesses, [string]$Language, $Context = $null)
    $Deadline = (Get-Date).AddSeconds(10)
    $RequestedWindows = [System.Collections.Generic.HashSet[long]]::new()
    $ReportedProcesses = [System.Collections.Generic.HashSet[string]]::new()
    $EmptySamples = 0
    while ($true) {
        $Processes = @(Get-TabbyCleanProcesses)
        if (!$Processes.Count) {
            # A transient gap between exiting and newly spawned processes is
            # not a settled shutdown. Require three empty polls (400 ms).
            $EmptySamples++
            if ($EmptySamples -ge 3) { return }
            Start-Sleep -Milliseconds 200
            continue
        }
        $EmptySamples = 0
        $VerifiedProcesses = @()
        $UnexpectedProcesses = @()
        foreach ($Process in $Processes) {
            $ProcessKey = Get-TabbyCleanProcessKey $Process
            if (!$ProcessKey) { continue }
            if ($ProcessKey -notin $ExpectedProcesses) {
                # The confirmed instance may spawn short-lived processes while
                # exiting. They still block deletion, but need not abort the
                # wait. Never close or force-kill an unconfirmed process.
                $UnexpectedProcesses += $ProcessKey
                if ($Context -and $ReportedProcesses.Add($ProcessKey)) {
                    Write-TabbyCleanMessage $Context 'NewProcessWaiting' @($ProcessKey, (Get-TabbyCleanProcessDetails $Process))
                }
                continue
            }
            $VerifiedProcesses += $Process
        }
        if ((Get-Date) -ge $Deadline) {
            if ($UnexpectedProcesses.Count) {
                $Details = Get-TabbyCleanMessage $Language 'ProcessMismatch' @(($UnexpectedProcesses -join ', '), ($ExpectedProcesses -join ', '))
                throw ((Get-TabbyCleanMessage $Language 'NewProcess') + ' ' + $Details)
            }
            throw (Get-TabbyCleanMessage $Language 'Timeout')
        }
        foreach ($Process in $VerifiedProcesses) {
            try {
                $WindowHandle = $Process.MainWindowHandle
                if ($null -eq $WindowHandle) { continue }
                $Handle = $WindowHandle.ToInt64()
                if ($Handle -and $RequestedWindows.Add($Handle)) { [void]$Process.CloseMainWindow() }
            } catch {
                # A process can exit between enumeration and the window-close request.
                if (!$Process.HasExited) { throw }
            }
        }
        Start-Sleep -Milliseconds 200
    }
}

function Remove-TabbyCleanData {
    param([string]$TabbyConfigDir, $Context)
    $DevDataPath = Join-Path $TabbyConfigDir 'windy-quick-commands-dev'
    Assert-TabbyChildPath -ParentPath $TabbyConfigDir -Path $DevDataPath -ChildName 'windy-quick-commands-dev'
    if (@(Get-TabbyCleanProcesses).Count) { throw (Get-TabbyCleanMessage $Context.Language 'Running') }
    Write-TabbyCleanMessage $Context 'Clearing' @($DevDataPath)
    if (Test-Path -LiteralPath $DevDataPath) { Remove-Item -LiteralPath $DevDataPath -Recurse -Force }
    Write-TabbyCleanMessage $Context 'Cleared' @($DevDataPath)
    Write-TabbyCleanMessage $Context 'Preserved'
}

function Start-TabbyAfterClean {
    param([string]$TabbyExe, [string]$Language)
    $RestartedAfter = Get-Date
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$TabbyExe`"" -WindowStyle Hidden
    for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
        Start-Sleep -Milliseconds 200
        if (@(Get-TabbyCleanProcesses | Where-Object { $_.StartTime -ge $RestartedAfter -and $_.Path -eq $TabbyExe }).Count) { return }
    }
    throw (Get-TabbyCleanMessage $Language 'NotStarted')
}

function Invoke-TabbyCleanOperation {
    param($Request)
    $Stage = 'CheckFailed'
    try {
        $DevDataPath = Join-Path $Request.TabbyConfigDir 'windy-quick-commands-dev'
        Assert-TabbyChildPath -ParentPath $Request.TabbyConfigDir -Path $DevDataPath -ChildName 'windy-quick-commands-dev'
        if (!(Test-Path -LiteralPath $Request.TabbyExe -PathType Leaf)) { throw (Get-TabbyCleanMessage $Request.Language 'MissingExe') }
        $Stage = 'CloseFailed'
        Write-TabbyCleanMessage $Request 'Closing'
        Wait-TabbyCleanExit -ExpectedProcesses $Request.ExpectedProcesses -Language $Request.Language -Context $Request
        $Stage = 'ClearFailed'
        Remove-TabbyCleanData -TabbyConfigDir $Request.TabbyConfigDir -Context $Request
        $Stage = 'RestartFailed'
        Write-TabbyCleanMessage $Request 'Restarting'
        Start-TabbyAfterClean -TabbyExe $Request.TabbyExe -Language $Request.Language
        Write-TabbyCleanMessage $Request 'Restarted'
    } catch {
        $Failure = [InvalidOperationException]::new((Get-TabbyCleanMessage $Request.Language $Stage @($_.Exception.Message)), $_.Exception)
        $Failure.Data['TabbyCleanStack'] = $_.ScriptStackTrace
        throw $Failure
    }
}

function Start-TabbyCleanDetachedProcess {
    param([string]$Code)
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
    $PowerShellExe = Join-Path $PSHOME 'pwsh.exe'
    $NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $Broker = Join-Path $PSScriptRoot 'tabby-clean-worker.cjs'
    # WMI brokers creation outside the terminal's process tree/job. No visible window.
    # https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process
    $Startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x01000000 }
    $Created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "`"$NodeExe`" `"$Broker`" `"$PowerShellExe`" $Encoded"
        CurrentDirectory = $PSScriptRoot
        ProcessStartupInformation = $Startup
    } -ErrorAction Stop
    if ($Created.ReturnValue -ne 0) { throw "Win32_Process.Create: $($Created.ReturnValue)" }
    return $Created.ProcessId
}

function Start-TabbyCleanWorker {
    param($Request)
    $Payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Depth 5 -Compress)))
    $Library = (Join-Path $PSScriptRoot 'tabby-dev-clean.ps1').Replace("'", "''")
    # Encode structured data rather than interpolate user paths into PowerShell code.
    $Code = @'
$ErrorActionPreference = 'Stop'
$Request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$Result = @{ Success = $false; Message = '' }
try {
    . '__LIBRARY__'
    Invoke-TabbyCleanOperation $Request
    $Result.Success = $true
} catch {
    $Result.Message = $_.Exception.Message
    [IO.File]::AppendAllText($Request.LogPath, $Result.Message + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $Stack = $_.Exception.Data['TabbyCleanStack']
    if (!$Stack) { $Stack = $_.ScriptStackTrace }
    Write-TabbyCleanMessage $Request 'Diagnostics' @($Stack)
} finally {
    [IO.File]::WriteAllText($Request.LogPath + '.result.tmp', ($Result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath ($Request.LogPath + '.result.tmp') -Destination ($Request.LogPath + '.result.json')
}
if (!$Result.Success) { exit 1 }
'@
    Start-TabbyCleanDetachedProcess -Code $Code.Replace('__LIBRARY__', $Library).Replace('__PAYLOAD__', $Payload)
}

function Wait-TabbyCleanWorker {
    param([uint32]$WorkerId, $Request)
    $Deadline = (Get-Date).AddSeconds(60)
    $LinesShown = 0
    try {
        while ($true) {
            $Completed = Test-Path -LiteralPath ($Request.LogPath + '.result.json')
            # Allow the worker to append while the console reads; only display complete lines.
            $Stream = [IO.FileStream]::new($Request.LogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8)
            try { $LogText = $Reader.ReadToEnd() } finally { $Reader.Dispose() }
            $Lines = @($LogText -split '\r?\n' | Select-Object -SkipLast 1)
            for (; $LinesShown -lt $Lines.Length; $LinesShown++) { Write-Host $Lines[$LinesShown] }
            if ($Completed) {
                $Result = Get-Content -LiteralPath ($Request.LogPath + '.result.json') -Raw | ConvertFrom-Json
                if ($Result.Success -isnot [bool] -or $Result.Message -isnot [string]) { throw 'Invalid worker completion record' }
                break
            }
            if ((Get-Date) -ge $Deadline -or !(Get-Process -Id $WorkerId -ErrorAction SilentlyContinue)) {
                # The worker may have atomically published its result since the first check.
                if (Test-Path -LiteralPath ($Request.LogPath + '.result.json')) { continue }
                throw "PID $WorkerId"
            }
            Start-Sleep -Milliseconds 200
        }
    } catch { throw (Get-TabbyCleanMessage $Request.Language 'WorkerFailed' @($Request.LogPath, $_.Exception.Message)) }
    if (!$Result.Success) { throw $Result.Message }
}

function Invoke-TabbyDevClean {
    param([string]$TabbyConfigDir, [string]$TabbyExe = '')
    $Language = Get-TabbyCleanLanguage $TabbyConfigDir
    $Context = @{ Language = $Language; LogPath = '' }
    try {
        $TabbyConfigDir = [IO.Path]::GetFullPath($TabbyConfigDir)
        Assert-TabbyChildPath -ParentPath $TabbyConfigDir -Path (Join-Path $TabbyConfigDir 'windy-quick-commands-dev') -ChildName 'windy-quick-commands-dev'
        $Processes = @(Get-TabbyCleanProcesses)
        if ($Processes.Count) {
            $ResolvedTabbyExe = Resolve-TabbyExe -RequestedPath $TabbyExe
            if (!$ResolvedTabbyExe -or !(Test-Path -LiteralPath $ResolvedTabbyExe -PathType Leaf)) { throw (Get-TabbyCleanMessage $Language 'MissingExe') }
            # Validate readability before offering confirmation, but do not use
            # this pre-prompt list as the shutdown authorization snapshot.
            $null = @(Get-TabbyCleanProcessSnapshot $Processes $Language)
        }
    } catch { throw (Get-TabbyCleanMessage $Language 'CheckFailed' @($_.Exception.Message)) }
    if (!$Processes.Count) {
        try { Remove-TabbyCleanData $TabbyConfigDir $Context } catch { throw (Get-TabbyCleanMessage $Language 'ClearFailed' @($_.Exception.Message)) }
        return
    }
    Write-TabbyCleanMessage $Context 'Confirm'
    if (!(Read-TabbyCleanConfirmation $Language)) { Write-TabbyCleanMessage $Context 'Cancelled'; return }
    try {
        # Tabby's process set may change while the user reads the prompt. The
        # authorization boundary is Enter, not the moment the prompt appeared.
        $ExpectedProcesses = @(Get-TabbyCleanProcessSnapshot @(Get-TabbyCleanProcesses) $Language)
    } catch { throw (Get-TabbyCleanMessage $Language 'CheckFailed' @($_.Exception.Message)) }
    $LogPath = Join-Path ([IO.Path]::GetTempPath()) ('tabby-dev-clean-' + [guid]::NewGuid() + '.log')
    $Request = [pscustomobject]@{ Language = $Language; LogPath = $LogPath; TabbyConfigDir = $TabbyConfigDir; TabbyExe = $ResolvedTabbyExe; ExpectedProcesses = $ExpectedProcesses }
    try {
        [IO.File]::WriteAllText($LogPath, '', [Text.UTF8Encoding]::new($false))
        Write-TabbyCleanMessage $Request 'Snapshot' @(($ExpectedProcesses -join ', '))
        Write-TabbyCleanMessage $Context 'Log' @($LogPath)
        $WorkerId = Start-TabbyCleanWorker $Request
    } catch { throw (Get-TabbyCleanMessage $Language 'WorkerFailed' @($LogPath, $_.Exception.Message)) }
    Wait-TabbyCleanWorker $WorkerId $Request
}
