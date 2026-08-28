function Resolve-TabbyExe {
    param([string]$RequestedPath)

    $Candidates = @()
    if ($RequestedPath) { $Candidates += $RequestedPath }
    Get-Process -Name 'Tabby' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.MainModule.FileName) { $Candidates += $_.MainModule.FileName }
        } catch {
            # Some Windows process queries can fail under restricted permissions.
        }
    }
    if ($env:LOCALAPPDATA) { $Candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Tabby\Tabby.exe') }
    if ($env:ProgramFiles) { $Candidates += (Join-Path $env:ProgramFiles 'Tabby\Tabby.exe') }
    if (${env:ProgramFiles(x86)}) { $Candidates += (Join-Path ${env:ProgramFiles(x86)} 'Tabby\Tabby.exe') }
    $Candidates += @('D:\Application\tabby\Tabby.exe', 'D:\Applications\tabby\Tabby.exe', 'D:\Program Files\Tabby\Tabby.exe')
    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
            return (Resolve-Path -LiteralPath $Candidate).Path
        }
    }
    $Command = Get-Command 'Tabby.exe' -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    return $null
}
