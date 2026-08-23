#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter()]
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),

    [Parameter(Mandatory = $true)]
    [Alias('OutputDirectory')]
    [string]$BundleDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& (Join-Path -Path $PSScriptRoot -ChildPath 'build-ecs-deployment-bundle.ps1') `
    -RepositoryRoot $RepositoryRoot `
    -OutputDirectory $BundleDirectory `
    -VerifyOnly

