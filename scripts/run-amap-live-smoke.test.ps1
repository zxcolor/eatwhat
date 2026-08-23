<#
.SYNOPSIS
对高德真实 Key smoke 的 PowerShell 外层门禁做完全离线的行为回归。

.DESCRIPTION
测试在独立临时目录中创建假 pnpm/node，只记录参数与测试哨兵环境变量，绝不调用
真实 Node、高德或其他网络。覆盖变量白名单、恶意/重复行拒绝、构建隔离，以及
成功、构建失败和 smoke 失败后的环境恢复。verify.ps1 只运行本离线测试，不运行
真实高德 smoke。
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$subject = Join-Path $PSScriptRoot 'run-amap-live-smoke.ps1'
$localApiLauncher = Join-Path $PSScriptRoot 'start-api-local.ps1'
$managedKeys = @(
    'AMAP_LIVE_SMOKE_ENABLED',
    'AMAP_ENABLED',
    'AMAP_WEB_SERVICE_KEY',
    'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
    'AMAP_IP_WHITELIST_CONFIGURED',
    'AMAP_TIMEOUT_MS'
)
$testSupportKeys = @(
    'AMAP_SMOKE_TEST_PNPM_LOG',
    'AMAP_SMOKE_TEST_NODE_LOG',
    'AMAP_SMOKE_TEST_PNPM_EXIT_CODE',
    'AMAP_SMOKE_TEST_NODE_EXIT_CODE',
    'DATABASE_URL'
)
$savedEnvironment = @{}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$tempRoot = Join-Path (
    [System.IO.Path]::GetTempPath()
) ("amap-smoke-wrapper-test-{0}" -f [guid]::NewGuid().ToString('N'))
$shimRoot = Join-Path $tempRoot 'bin'
$pnpmLog = Join-Path $tempRoot 'pnpm.json'
$nodeLog = Join-Path $tempRoot 'node.json'
$pnpmExitCodeFile = Join-Path $tempRoot 'pnpm-exit-code.txt'
$nodeExitCodeFile = Join-Path $tempRoot 'node-exit-code.txt'
$script:lastWrapperOutput = @()

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "断言失败：$Message"
    }
}

function Assert-Equal {
    param(
        [AllowNull()][object]$Actual,
        [AllowNull()][object]$Expected,
        [string]$Message
    )
    if (-not [object]::Equals($Actual, $Expected)) {
        throw "断言失败：$Message；实际=$Actual；预期=$Expected"
    }
}

function Assert-SequenceEqual {
    param(
        [object[]]$Actual,
        [object[]]$Expected,
        [string]$Message
    )
    $actualText = @($Actual) -join [char]31
    $expectedText = @($Expected) -join [char]31
    Assert-Equal -Actual $actualText -Expected $expectedText -Message $Message
}

function Write-TestFile {
    param(
        [string]$Path,
        [string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Set-TestProcessEnvironmentVariable {
    param(
        [string]$Key,
        [AllowNull()][object]$Value
    )
    if ($null -eq $Value) {
        Remove-Item -LiteralPath ("Env:\{0}" -f $Key) -ErrorAction SilentlyContinue
        return
    }
    [Environment]::SetEnvironmentVariable($Key, [string]$Value, 'Process')
}

function Read-TestJson {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Assert-EnvironmentRestored {
    foreach ($key in $managedKeys) {
        Assert-Equal `
            -Actual ([Environment]::GetEnvironmentVariable($key, 'Process')) `
            -Expected ("caller-$key") `
            -Message "$key 应恢复调用者原值"
    }
}

function Reset-InvocationLogs {
    foreach ($path in @($pnpmLog, $nodeLog)) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Invoke-WrapperCase {
    param(
        [string]$Name,
        [string]$EnvContent,
        [bool]$Confirm = $true,
        [int]$PnpmExitCode = 0,
        [int]$NodeExitCode = 0
    )
    Reset-InvocationLogs
    $envFile = Join-Path $tempRoot ("$Name.env")
    Write-TestFile -Path $envFile -Content $EnvContent
    [IO.File]::WriteAllText($pnpmExitCodeFile, [string]$PnpmExitCode)
    [IO.File]::WriteAllText($nodeExitCodeFile, [string]$NodeExitCode)

    $caught = $null
    $capturedOutput = [System.Collections.Generic.List[string]]::new()
    try {
        & $subject -EnvFile $envFile -ConfirmLiveRequest:$Confirm *>&1 |
            ForEach-Object { $capturedOutput.Add([string]$_) }
    } catch {
        $caught = $_
    }
    $script:lastWrapperOutput = @($capturedOutput)
    return $caught
}

$fakePnpm = @'
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path $PSScriptRoot -Parent
$payload = [ordered]@{
    arguments = @($args)
    environment = [ordered]@{
        AMAP_LIVE_SMOKE_ENABLED = [Environment]::GetEnvironmentVariable('AMAP_LIVE_SMOKE_ENABLED', 'Process')
        AMAP_ENABLED = [Environment]::GetEnvironmentVariable('AMAP_ENABLED', 'Process')
        AMAP_WEB_SERVICE_KEY = [Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_KEY', 'Process')
        AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY = [Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY', 'Process')
        AMAP_IP_WHITELIST_CONFIGURED = [Environment]::GetEnvironmentVariable('AMAP_IP_WHITELIST_CONFIGURED', 'Process')
        AMAP_TIMEOUT_MS = [Environment]::GetEnvironmentVariable('AMAP_TIMEOUT_MS', 'Process')
        DATABASE_URL = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
    }
}
[IO.File]::WriteAllText(
    (Join-Path $testRoot 'pnpm.json'),
    ($payload | ConvertTo-Json -Compress)
)
exit [int][IO.File]::ReadAllText((Join-Path $testRoot 'pnpm-exit-code.txt'))
'@

$fakeNode = @'
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path $PSScriptRoot -Parent
$payload = [ordered]@{
    arguments = @($args)
    environment = [ordered]@{
        AMAP_LIVE_SMOKE_ENABLED = [Environment]::GetEnvironmentVariable('AMAP_LIVE_SMOKE_ENABLED', 'Process')
        AMAP_ENABLED = [Environment]::GetEnvironmentVariable('AMAP_ENABLED', 'Process')
        AMAP_WEB_SERVICE_KEY = [Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_KEY', 'Process')
        AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY = [Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY', 'Process')
        AMAP_IP_WHITELIST_CONFIGURED = [Environment]::GetEnvironmentVariable('AMAP_IP_WHITELIST_CONFIGURED', 'Process')
        AMAP_TIMEOUT_MS = [Environment]::GetEnvironmentVariable('AMAP_TIMEOUT_MS', 'Process')
        DATABASE_URL = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
    }
}
[IO.File]::WriteAllText(
    (Join-Path $testRoot 'node.json'),
    ($payload | ConvertTo-Json -Compress)
)
exit [int][IO.File]::ReadAllText((Join-Path $testRoot 'node-exit-code.txt'))
'@

$pnpmShim = @'
@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-pnpm.ps1" %*
exit /b %ERRORLEVEL%
'@

$nodeShim = @'
@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-node.ps1" %*
exit /b %ERRORLEVEL%
'@

try {
    [System.IO.Directory]::CreateDirectory($shimRoot) | Out-Null
    Write-TestFile -Path (Join-Path $shimRoot 'fake-pnpm.ps1') -Content $fakePnpm
    Write-TestFile -Path (Join-Path $shimRoot 'fake-node.ps1') -Content $fakeNode
    Write-TestFile -Path (Join-Path $shimRoot 'pnpm.cmd') -Content $pnpmShim
    Write-TestFile -Path (Join-Path $shimRoot 'node.cmd') -Content $nodeShim

    foreach ($key in @($managedKeys + $testSupportKeys + @('PATH'))) {
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    foreach ($key in $managedKeys) {
        [Environment]::SetEnvironmentVariable($key, "caller-$key", 'Process')
    }
    [Environment]::SetEnvironmentVariable('DATABASE_URL', 'caller-database-url', 'Process')
    [IO.File]::WriteAllText($pnpmExitCodeFile, '0')
    [IO.File]::WriteAllText($nodeExitCodeFile, '0')
    $pathWithShims = $shimRoot + [System.IO.Path]::PathSeparator + $env:PATH
    [Environment]::SetEnvironmentVariable('PATH', $pathWithShims, 'Process')

    $validEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
AMAP_TIMEOUT_MS=2400
DATABASE_URL=must-not-be-selected
'@

    $successError = Invoke-WrapperCase `
        -Name 'success' `
        -EnvContent $validEnvironment
    Assert-Equal -Actual $successError -Expected $null -Message '成功路径不应抛错'
    Assert-True -Condition (Test-Path -LiteralPath $pnpmLog) -Message '构建 shim 应被调用'
    Assert-True -Condition (Test-Path -LiteralPath $nodeLog) -Message 'Node shim 应被调用'
    $pnpmRecord = Read-TestJson -Path $pnpmLog
    Assert-SequenceEqual `
        -Actual @($pnpmRecord.arguments) `
        -Expected @('--filter', '@chi-shen-me/api', 'build') `
        -Message '构建参数必须固定'
    foreach ($key in $managedKeys) {
        Assert-Equal `
            -Actual $pnpmRecord.environment.$key `
            -Expected $null `
            -Message "构建进程不得继承 $key"
    }
    Assert-Equal `
        -Actual $pnpmRecord.environment.DATABASE_URL `
        -Expected $null `
        -Message '构建进程不得继承父终端数据库 Secret'
    $nodeRecord = Read-TestJson -Path $nodeLog
    $expectedSmokeEntry = Join-Path $workspaceRoot 'apps\api\dist\amap-real-key.smoke.js'
    Assert-SequenceEqual `
        -Actual @($nodeRecord.arguments) `
        -Expected @($expectedSmokeEntry, '--confirm-live-request') `
        -Message '最终 Node 必须只收到入口文件与精确确认参数'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_LIVE_SMOKE_ENABLED -Expected 'true' -Message 'Node smoke gate'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_ENABLED -Expected 'true' -Message 'AMAP gate'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_WEB_SERVICE_KEY -Expected 'file-test-key' -Message 'Node Key'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY -Expected 'file-test-private-key' -Message 'Node signing private key'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_IP_WHITELIST_CONFIGURED -Expected 'true' -Message 'Node IP whitelist gate'
    Assert-Equal -Actual $nodeRecord.environment.AMAP_TIMEOUT_MS -Expected '2400' -Message 'Node timeout'
    Assert-Equal `
        -Actual $nodeRecord.environment.DATABASE_URL `
        -Expected $null `
        -Message '高德 smoke 进程不得继承父终端数据库 Secret'
    $safeOutput = $script:lastWrapperOutput -join "`n"
    foreach ($privateValue in @('file-test-key', 'file-test-private-key', 'must-not-be-selected')) {
        Assert-True `
            -Condition (-not $safeOutput.Contains($privateValue)) `
            -Message "wrapper 输出不得包含 $privateValue"
    }
    Assert-EnvironmentRestored

    $withoutOptionalTimeout = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
'@
    $withoutTimeoutError = Invoke-WrapperCase `
        -Name 'without-optional-timeout' `
        -EnvContent $withoutOptionalTimeout
    Assert-Equal -Actual $withoutTimeoutError -Expected $null -Message '省略可选 timeout 应使用应用默认值'
    $withoutTimeoutRecord = Read-TestJson -Path $nodeLog
    Assert-Equal `
        -Actual $withoutTimeoutRecord.environment.AMAP_TIMEOUT_MS `
        -Expected $null `
        -Message '文件未定义 timeout 时不得继承调用者值'
    Assert-EnvironmentRestored

    # The shared local env file may carry the smoke opt-in, but the ordinary API
    # launcher must ignore it instead of injecting it into the dev API process.
    Reset-InvocationLogs
    $localApiEnvironment = Join-Path $tempRoot 'local-api.env'
    Write-TestFile -Path $localApiEnvironment -Content @'
NODE_ENV=test
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=false
AMAP_WEB_SERVICE_KEY=
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=
AMAP_IP_WHITELIST_CONFIGURED=false
AMAP_TIMEOUT_MS=2200
'@
    Set-TestProcessEnvironmentVariable `
        -Key 'AMAP_LIVE_SMOKE_ENABLED' `
        -Value $null
    [Environment]::SetEnvironmentVariable('PATH', $shimRoot, 'Process')
    [IO.File]::WriteAllText($pnpmExitCodeFile, '0')
    [IO.File]::WriteAllText($nodeExitCodeFile, '0')
    $localApiError = $null
    try {
        & $localApiLauncher -EnvFile $localApiEnvironment
    } catch {
        $localApiError = $_
    } finally {
        [Environment]::SetEnvironmentVariable('PATH', $pathWithShims, 'Process')
        [Environment]::SetEnvironmentVariable(
            'AMAP_LIVE_SMOKE_ENABLED',
            'caller-AMAP_LIVE_SMOKE_ENABLED',
            'Process'
        )
    }
    Assert-Equal -Actual $localApiError -Expected $null -Message '普通 API launcher 应接受共享 env 文件'
    Assert-True -Condition (Test-Path -LiteralPath $pnpmLog) -Message '普通 API launcher 应调用构建 shim'
    Assert-True -Condition (Test-Path -LiteralPath $nodeLog) -Message '普通 API launcher 应调用运行 shim'
    $localApiRecord = Read-TestJson -Path $pnpmLog
    Assert-SequenceEqual `
        -Actual @($localApiRecord.arguments) `
        -Expected @('--filter', '@chi-shen-me/api', 'build') `
        -Message '普通 API launcher 构建参数必须固定'
    Assert-Equal `
        -Actual $localApiRecord.environment.AMAP_LIVE_SMOKE_ENABLED `
        -Expected $null `
        -Message '普通 API 构建不得收到 live smoke opt-in'
    Assert-Equal `
        -Actual $localApiRecord.environment.DATABASE_URL `
        -Expected $null `
        -Message '普通 API 构建不得继承父终端数据库 Secret'
    $localApiRuntimeRecord = Read-TestJson -Path $nodeLog
    $expectedDevEntry = Join-Path $workspaceRoot 'apps\api\scripts\dev-compiled.mjs'
    Assert-SequenceEqual `
        -Actual @($localApiRuntimeRecord.arguments) `
        -Expected @($expectedDevEntry) `
        -Message '普通 API 运行入口必须固定'
    Assert-Equal `
        -Actual $localApiRuntimeRecord.environment.AMAP_LIVE_SMOKE_ENABLED `
        -Expected $null `
        -Message '普通 API 运行进程不得收到 live smoke opt-in'
    Assert-Equal `
        -Actual $localApiRuntimeRecord.environment.AMAP_WEB_SERVICE_KEY `
        -Expected $null `
        -Message 'AMAP 关闭时普通 API 不得继承父终端 Key'
    Assert-Equal `
        -Actual $localApiRuntimeRecord.environment.DATABASE_URL `
        -Expected $null `
        -Message '数据库关闭时普通 API 不得继承父终端 Secret'
    Assert-EnvironmentRestored

    $missingConfirmation = Invoke-WrapperCase `
        -Name 'missing-confirmation' `
        -EnvContent $validEnvironment `
        -Confirm $false
    Assert-True `
        -Condition ($null -ne $missingConfirmation -and $missingConfirmation.Exception.Message -match 'ConfirmLiveRequest') `
        -Message '缺少命令门禁必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '缺少命令门禁不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '缺少命令门禁不得运行 Node'
    Assert-EnvironmentRestored

    $disabledEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=false
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
'@
    $disabledError = Invoke-WrapperCase `
        -Name 'disabled-env-gate' `
        -EnvContent $disabledEnvironment
    Assert-True `
        -Condition ($null -ne $disabledError -and $disabledError.Exception.Message -match 'AMAP_LIVE_SMOKE_ENABLED') `
        -Message '关闭环境门禁必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '关闭环境门禁不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '关闭环境门禁不得运行 Node'
    Assert-EnvironmentRestored

    $missingSignatureEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_IP_WHITELIST_CONFIGURED=true
'@
    $missingSignatureError = Invoke-WrapperCase `
        -Name 'missing-signature-private-key' `
        -EnvContent $missingSignatureEnvironment
    Assert-True `
        -Condition ($null -ne $missingSignatureError -and $missingSignatureError.Exception.Message -match 'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY') `
        -Message '缺少签名私钥必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '缺少签名私钥不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '缺少签名私钥不得运行 Node'
    Assert-EnvironmentRestored

    $missingWhitelistEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=false
'@
    $missingWhitelistError = Invoke-WrapperCase `
        -Name 'missing-ip-whitelist-confirmation' `
        -EnvContent $missingWhitelistEnvironment
    Assert-True `
        -Condition ($null -ne $missingWhitelistError -and $missingWhitelistError.Exception.Message -match 'AMAP_IP_WHITELIST_CONFIGURED') `
        -Message '未确认 IP 白名单必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '未确认 IP 白名单不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '未确认 IP 白名单不得运行 Node'
    Assert-EnvironmentRestored

    $duplicateEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=first-key
AMAP_WEB_SERVICE_KEY=second-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
'@
    $duplicateError = Invoke-WrapperCase `
        -Name 'duplicate' `
        -EnvContent $duplicateEnvironment
    Assert-True `
        -Condition ($null -ne $duplicateError -and $duplicateError.Exception.Message -match '重复定义') `
        -Message '重复高德变量必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '重复变量不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '重复变量不得运行 Node'
    Assert-EnvironmentRestored

    $maliciousEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=file-test-key
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
Write-Output should-never-run
'@
    $maliciousError = Invoke-WrapperCase `
        -Name 'malicious' `
        -EnvContent $maliciousEnvironment
    Assert-True `
        -Condition ($null -ne $maliciousError -and $maliciousError.Exception.Message -match '格式无效') `
        -Message '命令式环境行必须拒绝'
    Assert-True -Condition (-not (Test-Path -LiteralPath $pnpmLog)) -Message '恶意环境行不得构建'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '恶意环境行不得运行 Node'
    Assert-EnvironmentRestored

    $literalValueEnvironment = @'
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=$(Write-Output should-never-execute)
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=file-test-private-key
AMAP_IP_WHITELIST_CONFIGURED=true
'@
    $literalValueError = Invoke-WrapperCase `
        -Name 'literal-value' `
        -EnvContent $literalValueEnvironment
    Assert-Equal `
        -Actual $literalValueError `
        -Expected $null `
        -Message 'value 内命令样式文本应只作为字面值传递'
    $literalValueRecord = Read-TestJson -Path $nodeLog
    Assert-Equal `
        -Actual $literalValueRecord.environment.AMAP_WEB_SERVICE_KEY `
        -Expected '$(Write-Output should-never-execute)' `
        -Message 'value 不得执行或展开'
    Assert-True `
        -Condition (-not (($script:lastWrapperOutput -join "`n").Contains('should-never-execute'))) `
        -Message '字面 Key 不得回显'
    Assert-EnvironmentRestored

    $buildError = Invoke-WrapperCase `
        -Name 'build-failure' `
        -EnvContent $validEnvironment `
        -PnpmExitCode 17
    Assert-True `
        -Condition ($null -ne $buildError -and $buildError.Exception.Message -match '退出码：17') `
        -Message '构建失败应安全退出'
    Assert-True -Condition (Test-Path -LiteralPath $pnpmLog) -Message '失败构建 shim 应被调用'
    Assert-True -Condition (-not (Test-Path -LiteralPath $nodeLog)) -Message '构建失败不得运行 Node'
    $failedBuildRecord = Read-TestJson -Path $pnpmLog
    foreach ($key in $managedKeys) {
        Assert-Equal `
            -Actual $failedBuildRecord.environment.$key `
            -Expected $null `
            -Message "失败构建也不得继承 $key"
    }
    Assert-EnvironmentRestored

    $nodeError = Invoke-WrapperCase `
        -Name 'node-failure' `
        -EnvContent $validEnvironment `
        -NodeExitCode 23
    Assert-True `
        -Condition ($null -ne $nodeError -and $nodeError.Exception.Message -match '退出码：23') `
        -Message 'Node smoke 失败应安全退出'
    Assert-True -Condition (Test-Path -LiteralPath $nodeLog) -Message '失败 Node shim 应被调用'
    Assert-EnvironmentRestored

    Set-TestProcessEnvironmentVariable -Key 'AMAP_TIMEOUT_MS' -Value $null
    $unsetRestoreError = Invoke-WrapperCase `
        -Name 'unset-restore' `
        -EnvContent $validEnvironment `
        -NodeExitCode 29
    Assert-True `
        -Condition ($null -ne $unsetRestoreError -and $unsetRestoreError.Exception.Message -match '退出码：29') `
        -Message 'unset 恢复用例应走 Node 失败路径'
    Assert-Equal `
        -Actual ([Environment]::GetEnvironmentVariable('AMAP_TIMEOUT_MS', 'Process')) `
        -Expected $null `
        -Message '调用者原本未设置的变量必须恢复为未设置'
    [Environment]::SetEnvironmentVariable(
        'AMAP_TIMEOUT_MS',
        'caller-AMAP_TIMEOUT_MS',
        'Process'
    )
    Assert-EnvironmentRestored

    Write-Host '高德 live smoke PowerShell wrapper 零网络测试通过。'
} finally {
    foreach ($key in $savedEnvironment.Keys) {
        Set-TestProcessEnvironmentVariable `
            -Key $key `
            -Value $savedEnvironment[$key]
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
    $ErrorActionPreference = $previousErrorActionPreference
}
