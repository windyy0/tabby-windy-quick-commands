[CmdletBinding()]
param(
    [string]$TabbyConfigDir = "$env:APPDATA\tabby",
    [string]$TabbyExe = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'tabby-dev-clean.ps1')
Invoke-TabbyDevClean -TabbyConfigDir $TabbyConfigDir -TabbyExe $TabbyExe
