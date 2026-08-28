function Assert-TabbyChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$ParentPath,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ChildName
    )

    $ResolvedParent = [System.IO.Path]::GetFullPath($ParentPath)
    $ResolvedTarget = [System.IO.Path]::GetFullPath($Path)
    $ExpectedTarget = [System.IO.Path]::GetFullPath((Join-Path $ResolvedParent $ChildName))
    if ($ChildName -match '[/\\]' -or $ChildName -in @('.', '..') -or
        ![string]::Equals($ResolvedTarget, $ExpectedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify unexpected path: $ResolvedTarget"
    }

    # Resolve-Path alone does not resolve Windows junction destinations.
    $CurrentPath = $ResolvedTarget
    while ($CurrentPath) {
        $Item = Get-Item -LiteralPath $CurrentPath -Force -ErrorAction SilentlyContinue
        if ($Item -and ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to modify a path through a symlink or junction: $CurrentPath"
        }
        $CurrentPath = Split-Path -Parent $CurrentPath
    }
    if (Test-Path -LiteralPath $ResolvedTarget) {
        $LinkedChild = Get-ChildItem -LiteralPath $ResolvedTarget -Recurse -Force |
            Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } |
            Select-Object -First 1
        if ($LinkedChild) {
            throw "Refusing to modify a directory containing a symlink or junction: $($LinkedChild.FullName)"
        }
    }
}
