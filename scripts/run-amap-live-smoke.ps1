<#
.SYNOPSIS
显式运行高德真实 Web Service Key 的三链路只读 smoke。

.DESCRIPTION
本脚本只从私有 .env.local 中选取高德 smoke 所需的六个变量，不执行文件内容，
不回显 Key，也不把真实请求接入默认 verify.ps1。发起网络请求必须同时满足环境
门禁和 -ConfirmLiveRequest 命令门禁。构建使用无 Secret 的最小环境，真实 smoke
只接收六个白名单变量；脚本不会修改调用 PowerShell 的进程环境。

.PARAMETER EnvFile
私有环境文件；默认是仓库根目录的 .env.local。

.PARAMETER ConfirmLiveRequest
确认本次操作会串行发起三次真实高德请求。
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [switch]$ConfirmLiveRequest
)

Set-StrictMode -Version Latest
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $workspaceRoot '.env.local'
}

$managedKeys = @(
    'AMAP_LIVE_SMOKE_ENABLED',
    'AMAP_ENABLED',
    'AMAP_WEB_SERVICE_KEY',
    'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
    'AMAP_IP_WHITELIST_CONFIGURED',
    'AMAP_TIMEOUT_MS'
)
$selectedKeys = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
$managedKeys | ForEach-Object { [void]$selectedKeys.Add($_) }

function ConvertFrom-AmapSmokeEnvLine {
    param(
        [string]$Line,
        [int]$LineNumber
    )

    $trimmed = $Line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
        return $null
    }
    if ($trimmed -notmatch '^(?<Key>[A-Z][A-Z0-9_]*)=(?<Value>.*)$') {
        throw "环境文件第 $LineNumber 行格式无效；只能使用 KEY=value，不能使用命令或变量展开。"
    }

    $key = $Matches.Key
    if (-not $selectedKeys.Contains($key)) {
        return $null
    }
    $value = $Matches.Value.Trim()
    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or
            ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        } elseif ($first -eq '"' -or $first -eq "'" -or
            $last -eq '"' -or $last -eq "'") {
            throw "环境文件第 $LineNumber 行的引号不匹配。"
        }
    }
    if ($value.Contains([char]0)) {
        throw "环境文件第 $LineNumber 行包含不允许的空字符。"
    }
    return [PSCustomObject]@{ Key = $key; Value = $value }
}

function New-MinimalChildEnvironment {
    $environment = [ordered]@{}
    foreach ($key in @(
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'ComSpec',
        'COMSPEC',
        'TEMP',
        'TMP',
        'PATH',
        'Path',
        'PATHEXT',
        'APPDATA',
        'LOCALAPPDATA',
        'PROGRAMDATA',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE'
    )) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($value) -and
            -not $environment.Contains($key)) {
            $environment[$key] = $value
        }
    }
    return $environment
}

function Invoke-IsolatedProcess {
    param(
        [string]$FileName,
        [string]$Arguments,
        [System.Collections.IDictionary]$Environment
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $workspaceRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.EnvironmentVariables.Clear()
    foreach ($key in $Environment.Keys) {
        $startInfo.EnvironmentVariables[[string]$key] = [string]$Environment[$key]
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "无法启动隔离子进程：$FileName"
        }
        $process.WaitForExit()
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

try {
    if (-not $ConfirmLiveRequest) {
        throw '未提供 -ConfirmLiveRequest；未发起任何高德请求。'
    }

    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
        throw '高德 smoke 环境文件必须是普通文件。'
    }

    $entries = [ordered]@{}
    $lineNumber = 0
    # ReadAllLines closes the file before validation begins, so a rejected line
    # cannot leave the private env file locked in Windows PowerShell 5.1.
    foreach ($line in [System.IO.File]::ReadAllLines($resolvedEnvFile)) {
        $lineNumber += 1
        $entry = ConvertFrom-AmapSmokeEnvLine -Line $line -LineNumber $lineNumber
        if ($null -eq $entry) {
            continue
        }
        if ($entries.Contains($entry.Key)) {
            throw "环境文件中重复定义了 $($entry.Key)。"
        }
        $entries[$entry.Key] = $entry.Value
    }

    foreach ($requiredTrue in @('AMAP_LIVE_SMOKE_ENABLED', 'AMAP_ENABLED')) {
        if (-not $entries.Contains($requiredTrue) -or
            $entries[$requiredTrue] -cne 'true') {
            throw "$requiredTrue 必须在私有环境文件中明确设为 true；未发起任何高德请求。"
        }
    }
    if (-not $entries.Contains('AMAP_WEB_SERVICE_KEY') -or
        [string]::IsNullOrWhiteSpace($entries['AMAP_WEB_SERVICE_KEY'])) {
        throw 'AMAP_WEB_SERVICE_KEY 不能为空；未发起任何高德请求。'
    }
    if (-not $entries.Contains('AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY') -or
        [string]::IsNullOrWhiteSpace(
            $entries['AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY']
        )) {
        throw 'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY 不能为空；未发起任何高德请求。'
    }
    if (-not $entries.Contains('AMAP_IP_WHITELIST_CONFIGURED') -or
        $entries['AMAP_IP_WHITELIST_CONFIGURED'] -cne 'true') {
        throw 'AMAP_IP_WHITELIST_CONFIGURED 必须明确设为 true；未发起任何高德请求。'
    }

    $pnpm = Get-Command `
        'pnpm.cmd' `
        -CommandType Application `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $pnpm) {
        $pnpm = Get-Command `
            'pnpm' `
            -CommandType Application `
            -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $pnpm) {
        throw '未找到项目所需的 pnpm。'
    }
    $node = Get-Command `
        'node' `
        -CommandType Application `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $node) {
        $node = Get-Command `
            'node.exe' `
            -CommandType Application `
            -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $node) {
        throw '未找到项目所需的 Node.js。'
    }

    Write-Host '双重门禁已通过；先在无高德 Key 的环境完成构建。'
    $commandProcessor = [Environment]::GetEnvironmentVariable('ComSpec', 'Process')
    if ([string]::IsNullOrWhiteSpace($commandProcessor)) {
        $commandProcessor = Join-Path $env:SystemRoot 'System32\cmd.exe'
    }
    $buildArguments = '/d /s /c ""' + $pnpm.Source +
        '" --filter @chi-shen-me/api build"'
    $buildExitCode = Invoke-IsolatedProcess `
        -FileName $commandProcessor `
        -Arguments $buildArguments `
        -Environment (New-MinimalChildEnvironment)
    if ($buildExitCode -ne 0) {
        throw "高德 smoke 构建未通过，退出码：$buildExitCode。"
    }

    $smokeEntry = Join-Path $workspaceRoot 'apps\api\dist\amap-real-key.smoke.js'
    $runtimeEnvironment = New-MinimalChildEnvironment
    foreach ($key in $entries.Keys) {
        $runtimeEnvironment[$key] = [string]$entries[$key]
    }

    $runtimeFileName = $node.Source
    $runtimeArguments = '"' + $smokeEntry + '" --confirm-live-request'
    if ([System.IO.Path]::GetExtension($node.Source) -in @('.cmd', '.bat')) {
        $runtimeFileName = $commandProcessor
        $runtimeArguments = '/d /s /c ""' + $node.Source + '" "' +
            $smokeEntry + '" --confirm-live-request"'
    }
    Write-Host '无 Key 构建完成；将串行验证地点搜索、餐厅搜索和推荐召回。'
    $runtimeExitCode = Invoke-IsolatedProcess `
        -FileName $runtimeFileName `
        -Arguments $runtimeArguments `
        -Environment $runtimeEnvironment
    if ($runtimeExitCode -ne 0) {
        throw "高德真实 Key smoke 未通过，退出码：$runtimeExitCode。"
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
