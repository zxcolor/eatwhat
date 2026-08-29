<#
.SYNOPSIS
从本机私有环境文件启动“吃什么”API，不回显密钥值。

.DESCRIPTION
默认读取仓库根目录的 .env.local。该文件已被 .gitignore 排除。脚本只接受
公开 API 进程明确支持的环境变量，并忽略只属于独立高德 live smoke wrapper 的
AMAP_LIVE_SMOKE_ENABLED；不执行文件内容、不做变量展开，也不会把高德、千问、
数据库或认证密钥写入命令行。构建子进程使用无运行时 Secret 的最小环境，API
只接收白名单配置；管理员、迁移、维护和导出 worker 配置仍被拒绝。脚本不会
修改调用 PowerShell 的进程环境。

.PARAMETER EnvFile
本机环境文件路径。默认是仓库根目录的 .env.local。

.PARAMETER ValidateOnly
只校验文件结构与必要字段，不启动 API，也不修改当前进程环境。
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $workspaceRoot '.env.local'
}

$allowedKeys = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
@(
    'NODE_ENV',
    'PORT',
    'TRUSTED_PROXY_CIDRS',
    'ADMIN_API_BASE_URL',
    'DATABASE_ENABLED',
    'DATABASE_URL',
    'DATABASE_SSL_MODE',
    'DATABASE_SSL_CA_BASE64',
    'DATABASE_EXPECTED_TARGET',
    'DATABASE_RUNTIME_ROLE_NAME',
    'DATABASE_POOL_MAX',
    'DATABASE_CONNECT_TIMEOUT_MS',
    'DATABASE_IDLE_TIMEOUT_MS',
    'DATA_RIGHTS_MODE',
    'DATA_RIGHTS_AUTHORIZATION_ID',
    'DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT',
    'ALLOW_DEMO_DATA',
    'RECOMMENDATION_PROVIDER_PRIORITY',
    'LOCATION_SEARCH_PROVIDER_PRIORITY',
    'PLACE_SEARCH_PROVIDER_PRIORITY',
    'RULE_VERSION',
    'PROMPT_VERSION',
    'MINIMUM_SUPPORTED_VERSION',
    'ACCOUNTS_ENABLED',
    'FAVORITES_ENABLED',
    'DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS',
    'DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS',
    'AMAP_ENABLED',
    'AMAP_WEB_SERVICE_KEY',
    'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
    'AMAP_IP_WHITELIST_CONFIGURED',
    'AMAP_TIMEOUT_MS',
    'QWEN_ENABLED',
    'QWEN_BASE_URL',
    'QWEN_API_KEY',
    'QWEN_MODEL',
    'QWEN_TIMEOUT_MS',
    'AUTH_SCHEMA_TRANSITION_MODE',
    'PHONE_AUTH_ENABLED',
    'EMAIL_AUTH_ENABLED',
    'WECHAT_AUTH_ENABLED',
    'QQ_AUTH_ENABLED',
    'QQ_UNION_ID_ENABLED',
    'AUTH_HASH_ACTIVE_VERSION',
    'AUTH_HASH_KEYS_JSON',
    'AUTH_OTP_PEPPER_ACTIVE_VERSION',
    'AUTH_OTP_PEPPER_KEYS_JSON',
    'AUTH_IDENTITY_DEDUP_KEY_VERSION',
    'AUTH_ACCESS_TOKEN_TTL_SECONDS',
    'AUTH_REFRESH_TOKEN_TTL_DAYS',
    'AUTH_OTP_TTL_SECONDS',
    'AUTH_OTP_RESEND_SECONDS',
    'AUTH_OAUTH_STATE_TTL_SECONDS',
    'ALIBABA_CLOUD_ECS_METADATA',
    'ALIBABA_CLOUD_IMDSV1_DISABLED',
    'ALIBABA_CLOUD_ECS_IMDSV2_ENABLE',
    'ALIBABA_CLOUD_ECS_METADATA_DISABLED',
    'ALIYUN_CREDENTIAL_TIMEOUT_MS',
    'ALIYUN_CREDENTIAL_ALLOWED_PROVIDER',
    'ALIYUN_PNVS_SIGN_NAME',
    'ALIYUN_PNVS_TEMPLATE_CODE',
    'ALIYUN_PNVS_TIMEOUT_MS',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'SMTP_FROM_ADDRESS',
    'SMTP_REPLY_TO',
    'SMTP_FROM_NAME',
    'SMTP_TIMEOUT_MS',
    'WECHAT_APP_ID',
    'WECHAT_APP_SECRET',
    'WECHAT_OPEN_PLATFORM_REALM_ID',
    'WECHAT_AUTH_TIMEOUT_MS',
    'QQ_APP_ID',
    'QQ_APP_KEY',
    'QQ_OPEN_PLATFORM_REALM_ID',
    'QQ_AUTH_TIMEOUT_MS'
) | ForEach-Object { [void]$allowedKeys.Add($_) }

$secretKeys = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
@(
    'DATABASE_URL',
    'DATABASE_SSL_CA_BASE64',
    'AMAP_WEB_SERVICE_KEY',
    'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
    'QWEN_API_KEY',
    'AUTH_HASH_KEYS_JSON',
    'AUTH_OTP_PEPPER_KEYS_JSON',
    'WECHAT_APP_SECRET',
    'QQ_APP_KEY',
    'SMTP_PASSWORD'
) |
    ForEach-Object { [void]$secretKeys.Add($_) }

$approvedInheritedSecretKeys = @(
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'ALIBABA_CLOUD_SECURITY_TOKEN'
)

function Test-ConfiguredValue {
    param(
        [System.Collections.IDictionary]$Entries,
        [string]$Key
    )

    if ($Entries.Contains($Key) -and
        -not [string]::IsNullOrWhiteSpace([string]$Entries[$Key])) {
        return $true
    }
    if (-not $secretKeys.Contains($Key)) {
        return $false
    }
    return -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable($Key, 'Process')
    )
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

function Test-SecretEnabledForRuntime {
    param(
        [System.Collections.IDictionary]$Entries,
        [string]$Key
    )

    switch ($Key) {
        { $_ -in @('AMAP_WEB_SERVICE_KEY', 'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY') } {
            return $Entries.Contains('AMAP_ENABLED') -and
                $Entries['AMAP_ENABLED'] -ceq 'true'
        }
        'QWEN_API_KEY' {
            return $Entries.Contains('QWEN_ENABLED') -and
                $Entries['QWEN_ENABLED'] -ceq 'true'
        }
        { $_ -in @('DATABASE_URL', 'DATABASE_SSL_CA_BASE64') } {
            return $Entries.Contains('DATABASE_ENABLED') -and
                $Entries['DATABASE_ENABLED'] -ceq 'true'
        }
        'AUTH_HASH_KEYS_JSON' {
            return $Entries.Contains('ACCOUNTS_ENABLED') -and
                $Entries['ACCOUNTS_ENABLED'] -ceq 'true'
        }
        'AUTH_OTP_PEPPER_KEYS_JSON' {
            $emailEnabled = $Entries.Contains('EMAIL_AUTH_ENABLED') -and
                $Entries['EMAIL_AUTH_ENABLED'] -ceq 'true'
            return $Entries.Contains('ACCOUNTS_ENABLED') -and
                $Entries['ACCOUNTS_ENABLED'] -ceq 'true' -and
                $emailEnabled
        }
        'WECHAT_APP_SECRET' {
            return $Entries.Contains('WECHAT_AUTH_ENABLED') -and
                $Entries['WECHAT_AUTH_ENABLED'] -ceq 'true'
        }
        'QQ_APP_KEY' {
            return $Entries.Contains('QQ_AUTH_ENABLED') -and
                $Entries['QQ_AUTH_ENABLED'] -ceq 'true'
        }
        'SMTP_PASSWORD' {
            return $Entries.Contains('EMAIL_AUTH_ENABLED') -and
                $Entries['EMAIL_AUTH_ENABLED'] -ceq 'true'
        }
        default { return $true }
    }
}

function New-RuntimeChildEnvironment {
    param([System.Collections.IDictionary]$Entries)

    $environment = New-MinimalChildEnvironment
    foreach ($key in $allowedKeys) {
        $fileHasValue = $Entries.Contains($key) -and
            -not [string]::IsNullOrWhiteSpace([string]$Entries[$key])
        $secretEnabled = Test-SecretEnabledForRuntime -Entries $Entries -Key $key
        if (($fileHasValue -and $secretEnabled) -or
            ($Entries.Contains($key) -and -not $secretKeys.Contains($key))) {
            $environment[$key] = [string]$Entries[$key]
            continue
        }
        if ($secretKeys.Contains($key) -and $secretEnabled) {
            $inherited = [Environment]::GetEnvironmentVariable($key, 'Process')
            if (-not [string]::IsNullOrWhiteSpace($inherited)) {
                $environment[$key] = $inherited
            }
        }
    }
    $phoneAuthEnabled = $Entries.Contains('PHONE_AUTH_ENABLED') -and
        $Entries['PHONE_AUTH_ENABLED'] -ceq 'true'
    foreach ($key in $approvedInheritedSecretKeys) {
        if (-not $phoneAuthEnabled) {
            continue
        }
        $inherited = [Environment]::GetEnvironmentVariable($key, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($inherited)) {
            $environment[$key] = $inherited
        }
    }
    return $environment
}

function Invoke-IsolatedProcess {
    param(
        [string]$FileName,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [System.Collections.IDictionary]$Environment
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
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

function ConvertFrom-PrivateEnvLine {
    param(
        [string]$Line,
        [int]$LineNumber
    )

    $trimmed = $Line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
        return $null
    }
    if ($trimmed -notmatch '^(?<Key>[A-Z][A-Z0-9_]*)=(?<Value>.*)$') {
        throw "环境文件第 $LineNumber 行格式无效；只能使用 KEY=value，不能使用 export、命令或变量展开。"
    }

    $key = $Matches.Key
    if ($key -ceq 'AMAP_LIVE_SMOKE_ENABLED') {
        # This opt-in belongs exclusively to run-amap-live-smoke.ps1. A shared
        # .env.local may contain it, but the ordinary API process must not.
        return $null
    }
    $value = $Matches.Value.Trim()
    if (-not $allowedKeys.Contains($key)) {
        throw "环境文件第 $LineNumber 行包含未支持的变量 $key；请先更新 .env.example 与服务端配置再使用。"
    }

    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        } elseif ($first -eq '"' -or $first -eq "'" -or $last -eq '"' -or $last -eq "'") {
            throw "环境文件第 $LineNumber 行的引号不匹配。"
        }
    }
    if ($value.Contains([char]0)) {
        throw "环境文件第 $LineNumber 行包含不允许的空字符。"
    }

    return [PSCustomObject]@{ Key = $key; Value = $value }
}

try {
    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
        throw "环境文件不是普通文件：$resolvedEnvFile"
    }

    $entries = [ordered]@{}
    $lineNumber = 0
    foreach ($line in [System.IO.File]::ReadLines($resolvedEnvFile)) {
        $lineNumber += 1
        $entry = ConvertFrom-PrivateEnvLine -Line $line -LineNumber $lineNumber
        if ($null -eq $entry) {
            continue
        }
        if ($entries.Contains($entry.Key)) {
            throw "环境文件中重复定义了 $($entry.Key)。"
        }
        $entries[$entry.Key] = $entry.Value
    }

    if ($entries.Count -eq 0) {
        throw '环境文件没有任何有效配置。请从 .env.example 复制并按本机环境填写。'
    }
    if ($entries.Contains('AMAP_ENABLED') -and $entries['AMAP_ENABLED'] -eq 'true' -and
        -not (Test-ConfiguredValue -Entries $entries -Key 'AMAP_WEB_SERVICE_KEY')) {
        throw 'AMAP_ENABLED=true 时必须在私有文件或受控进程环境中填写 AMAP_WEB_SERVICE_KEY。'
    }
    if ($entries.Contains('QWEN_ENABLED') -and $entries['QWEN_ENABLED'] -eq 'true' -and
        (-not $entries.Contains('QWEN_API_KEY') -or
            [string]::IsNullOrWhiteSpace($entries['QWEN_API_KEY']))) {
        throw 'QWEN_ENABLED=true 时必须在同一私有文件中填写 QWEN_API_KEY。'
    }
    $schemaTransitionMode = if ($entries.Contains('AUTH_SCHEMA_TRANSITION_MODE')) {
        [string]$entries['AUTH_SCHEMA_TRANSITION_MODE']
    } else {
        'none'
    }
    if ($schemaTransitionMode -cne 'none' -and
        $schemaTransitionMode -cne 'legacy_phone_drain' -and
        $schemaTransitionMode -cne 'wechat_union_aliases_pending') {
        throw 'AUTH_SCHEMA_TRANSITION_MODE 只允许 none、legacy_phone_drain 或 wechat_union_aliases_pending。'
    }
    if ($schemaTransitionMode -ceq 'wechat_union_aliases_pending' -and
        $entries.Contains('WECHAT_AUTH_ENABLED') -and
        $entries['WECHAT_AUTH_ENABLED'] -cne 'false') {
        throw 'wechat_union_aliases_pending 要求 WECHAT_AUTH_ENABLED=false。'
    }
    if ($schemaTransitionMode -ceq 'legacy_phone_drain') {
        foreach ($disabledSwitch in @(
            'ACCOUNTS_ENABLED',
            'PHONE_AUTH_ENABLED',
            'EMAIL_AUTH_ENABLED',
            'WECHAT_AUTH_ENABLED',
            'QQ_AUTH_ENABLED',
            'QQ_UNION_ID_ENABLED'
        )) {
            if ($entries.Contains($disabledSwitch) -and $entries[$disabledSwitch] -cne 'false') {
                throw "legacy_phone_drain 要求 $disabledSwitch=false。"
            }
        }
    }
    if ($entries.Contains('ACCOUNTS_ENABLED') -and $entries['ACCOUNTS_ENABLED'] -eq 'true') {
        if (-not $entries.Contains('DATABASE_ENABLED') -or
            $entries['DATABASE_ENABLED'] -ne 'true') {
            throw 'ACCOUNTS_ENABLED=true 时 DATABASE_ENABLED 必须在同一私有文件中明确设为 true。'
        }
        $phoneAuthEnabled = $entries.Contains('PHONE_AUTH_ENABLED') -and
            $entries['PHONE_AUTH_ENABLED'] -eq 'true'
        if (-not $phoneAuthEnabled) {
            throw 'ACCOUNTS_ENABLED=true 时必须启用 PHONE_AUTH_ENABLED。'
        }
        foreach ($requiredValue in @(
            'DATABASE_URL',
            'AUTH_HASH_ACTIVE_VERSION',
            'AUTH_HASH_KEYS_JSON',
            'AUTH_IDENTITY_DEDUP_KEY_VERSION'
        )) {
            if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredValue)) {
                throw "ACCOUNTS_ENABLED=true 时必须在私有文件或受控进程环境中填写 $requiredValue。"
            }
        }
        $wechatAuthEnabled = $entries.Contains('WECHAT_AUTH_ENABLED') -and
            $entries['WECHAT_AUTH_ENABLED'] -eq 'true'
        if ($wechatAuthEnabled) {
            foreach ($requiredWechatValue in @(
                'WECHAT_APP_ID',
                'WECHAT_APP_SECRET',
                'WECHAT_OPEN_PLATFORM_REALM_ID'
            )) {
                if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredWechatValue)) {
                    throw "WECHAT_AUTH_ENABLED=true 时必须在私有文件或受控进程环境中填写 $requiredWechatValue。"
                }
            }
        }
        $emailAuthEnabled = $entries.Contains('EMAIL_AUTH_ENABLED') -and
            $entries['EMAIL_AUTH_ENABLED'] -eq 'true'
        if ($emailAuthEnabled) {
            foreach ($requiredOtpValue in @(
                'AUTH_OTP_PEPPER_ACTIVE_VERSION',
                'AUTH_OTP_PEPPER_KEYS_JSON'
            )) {
                if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredOtpValue)) {
                    throw "邮箱验证码启用时必须在私有文件或受控进程环境中填写 $requiredOtpValue。"
                }
            }
        }
        if ($phoneAuthEnabled) {
            foreach ($requiredPhoneValue in @(
                'ALIYUN_PNVS_SIGN_NAME',
                'ALIYUN_PNVS_TEMPLATE_CODE'
            )) {
                if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredPhoneValue)) {
                    throw "PHONE_AUTH_ENABLED=true 时必须在私有文件或受控进程环境中填写 $requiredPhoneValue。"
                }
            }
        }
    }
    if ($entries.Contains('EMAIL_AUTH_ENABLED') -and $entries['EMAIL_AUTH_ENABLED'] -eq 'true') {
        foreach ($requiredSmtpValue in @(
            'SMTP_HOST',
            'SMTP_USERNAME',
            'SMTP_PASSWORD',
            'SMTP_FROM_ADDRESS',
            'SMTP_REPLY_TO'
        )) {
            if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredSmtpValue)) {
                throw "EMAIL_AUTH_ENABLED=true 时必须在私有文件或受控进程环境中填写 $requiredSmtpValue。"
            }
        }
    }
    if ($entries.Contains('QQ_AUTH_ENABLED') -and $entries['QQ_AUTH_ENABLED'] -eq 'true') {
        foreach ($requiredQqValue in @('QQ_APP_ID', 'QQ_APP_KEY')) {
            if (-not (Test-ConfiguredValue -Entries $entries -Key $requiredQqValue)) {
                throw "QQ_AUTH_ENABLED=true 时必须在私有文件或受控进程环境中填写 $requiredQqValue。"
            }
        }
    }
    if ($entries.Contains('QQ_UNION_ID_ENABLED') -and
        $entries['QQ_UNION_ID_ENABLED'] -eq 'true' -and
        (-not $entries.Contains('QQ_AUTH_ENABLED') -or
            $entries['QQ_AUTH_ENABLED'] -ne 'true')) {
        throw 'QQ_UNION_ID_ENABLED=true 时必须同时启用 QQ_AUTH_ENABLED。'
    }
    if ($entries.Contains('QQ_UNION_ID_ENABLED') -and
        $entries['QQ_UNION_ID_ENABLED'] -eq 'true' -and
        (-not $entries.Contains('QQ_OPEN_PLATFORM_REALM_ID') -or
            $entries['QQ_OPEN_PLATFORM_REALM_ID'] -cnotmatch
                '^[a-z0-9][a-z0-9._-]{0,63}$')) {
        throw 'QQ_UNION_ID_ENABLED=true 时必须填写稳定的小写 QQ_OPEN_PLATFORM_REALM_ID。'
    }

    if ($ValidateOnly) {
        $validatedSecrets = @($entries.Keys | Where-Object { $secretKeys.Contains($_) }).Count
        Write-Host "公开 API 环境文件结构与启用依赖校验通过：$resolvedEnvFile"
        Write-Host "配置项：$($entries.Count)；密钥字段：$validatedSecrets（值不回显）"
        return
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
        throw '未找到 pnpm。请先安装项目指定的 pnpm 11.17.0，或在已配置 Node/pnpm 的终端运行。'
    }

    $runtimeEnvironment = New-RuntimeChildEnvironment -Entries $entries
    $publicKeys = @($entries.Keys | Where-Object { -not $secretKeys.Contains($_) })
    $secretCount = @(
        $runtimeEnvironment.Keys |
            Where-Object {
                $secretKeys.Contains($_) -or $approvedInheritedSecretKeys -ccontains $_
            }
    ).Count
    Write-Host "环境文件：$resolvedEnvFile"
    Write-Host "运行进程非敏感配置：$($publicKeys -join '，')"
    if ($secretCount -gt 0) {
        Write-Host "已注入 $secretCount 个服务端密钥（值不回显）"
    }
    Write-Host '先在无运行时密钥的最小环境中构建 API。'
    $commandProcessor = [Environment]::GetEnvironmentVariable('ComSpec', 'Process')
    if ([string]::IsNullOrWhiteSpace($commandProcessor)) {
        $commandProcessor = Join-Path $env:SystemRoot 'System32\cmd.exe'
    }
    $buildArguments = '/d /s /c ""' + $pnpm.Source +
        '" --filter @chi-shen-me/api build"'
    $buildExitCode = Invoke-IsolatedProcess `
        -FileName $commandProcessor `
        -Arguments $buildArguments `
        -WorkingDirectory $workspaceRoot `
        -Environment (New-MinimalChildEnvironment)
    if ($buildExitCode -ne 0) {
        throw "无密钥 API 构建失败，退出码为 $buildExitCode。"
    }

    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $node) {
        $node = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $node) {
        throw '未找到 Node.js 24。'
    }
    $devEntrypoint = Join-Path $workspaceRoot 'apps\api\scripts\dev-compiled.mjs'
    $runtimeFileName = $node.Source
    $runtimeArguments = '"' + $devEntrypoint + '"'
    if ([System.IO.Path]::GetExtension($node.Source) -in @('.cmd', '.bat')) {
        $runtimeFileName = $commandProcessor
        $runtimeArguments = '/d /s /c ""' + $node.Source + '" "' +
            $devEntrypoint + '""'
    }
    Write-Host '正在以最小运行环境启动本机 API；按 Ctrl+C 停止。'
    $runtimeExitCode = Invoke-IsolatedProcess `
        -FileName $runtimeFileName `
        -Arguments $runtimeArguments `
        -WorkingDirectory $workspaceRoot `
        -Environment $runtimeEnvironment
    if ($runtimeExitCode -ne 0) {
        throw "API 进程退出码为 $runtimeExitCode。"
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
