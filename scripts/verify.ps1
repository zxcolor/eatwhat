param(
    [string]$AlphaApiBaseUrl = $env:CHISHENME_ALPHA_API_BASE_URL,
    [string]$AlphaWechatAppId = $env:CHISHENME_ALPHA_WECHAT_APP_ID,
    [string]$AlphaQqAppId = $env:CHISHENME_ALPHA_QQ_APP_ID
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($AlphaApiBaseUrl)) {
    throw @'
完整验证必须显式提供云端 Alpha API 地址：
  .\scripts\verify.ps1 -AlphaApiBaseUrl https://api.your-domain.example/
也可仅在当前进程设置 CHISHENME_ALPHA_API_BASE_URL。地址仍会由 Gradle 公网 HTTPS 门禁复核。
'@
}
$AlphaApiBaseUrl = $AlphaApiBaseUrl.Trim()

if ([string]::IsNullOrWhiteSpace($AlphaWechatAppId)) {
    throw @'
完整验证必须通过参数或当前进程环境显式提供 Alpha 对应的微信 AppID。
该公开应用标识必须来自受控配置，禁止把 AppSecret 或其他服务端凭据传入构建。
'@
}
$AlphaWechatAppId = $AlphaWechatAppId.Trim().ToLowerInvariant()
if ($AlphaWechatAppId -cnotmatch '^wx[0-9a-f]{16}$') {
    throw 'Alpha 微信 AppID 格式无效；必须为 wx 加 16 位十六进制字符。'
}

if ([string]::IsNullOrWhiteSpace($AlphaQqAppId)) {
    throw @'
完整验证必须通过参数或当前进程环境显式提供 Alpha 对应的 QQ AppID。
该公开应用标识必须来自受控配置，禁止把 AppKey 或其他服务端凭据传入构建。
'@
}
$AlphaQqAppId = $AlphaQqAppId.Trim()
if ($AlphaQqAppId -cnotmatch '^[1-9][0-9]{4,15}$') {
    throw 'Alpha QQ AppID 格式无效；必须为 5 至 16 位且不以 0 开头的纯数字。'
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $workspaceRoot

$alphaCertificateMetadataPath = Join-Path $workspaceRoot `
    'apps\android\alpha-signing-certificate.properties'
if (-not (Test-Path -LiteralPath $alphaCertificateMetadataPath -PathType Leaf)) {
    throw "Alpha 固定签名证书元数据缺失：$alphaCertificateMetadataPath"
}
$alphaCertificateMetadata = ConvertFrom-StringData (
    [System.IO.File]::ReadAllText($alphaCertificateMetadataPath)
)
$expectedAlphaApplicationId = [string]$alphaCertificateMetadata.applicationId
$expectedAlphaCertificateMd5 = ([string]$alphaCertificateMetadata.md5).ToLowerInvariant()
$expectedAlphaCertificateSha256 = ([string]$alphaCertificateMetadata.sha256).ToLowerInvariant()
if ($expectedAlphaApplicationId -ne 'com.chishenme.app.alpha' -or
    $expectedAlphaCertificateMd5 -notmatch '^[0-9a-f]{32}$' -or
    $expectedAlphaCertificateSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Alpha 固定签名证书元数据无效。'
}

Write-Host '== PowerShell scripts: Windows PowerShell compatibility =='
foreach ($scriptFile in Get-ChildItem -LiteralPath (Join-Path $workspaceRoot 'scripts') -Filter '*.ps1') {
    $scriptBytes = [System.IO.File]::ReadAllBytes($scriptFile.FullName)
    $hasUtf8Bom = $scriptBytes.Length -ge 3 -and
        $scriptBytes[0] -eq 0xEF -and
        $scriptBytes[1] -eq 0xBB -and
        $scriptBytes[2] -eq 0xBF
    if (-not $hasUtf8Bom) {
        throw "$($scriptFile.Name) 缺少 UTF-8 BOM；包含中文的脚本会在 Windows PowerShell 5.1 中误码。"
    }
    $parseTokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $scriptFile.FullName,
        [ref]$parseTokens,
        [ref]$parseErrors
    ) | Out-Null
    if ($parseErrors.Count -gt 0) {
        throw "$($scriptFile.Name) 无法解析：$($parseErrors[0].Message)"
    }
}

Write-Host '== ECS shell scripts: LF and Bash syntax =='
$bashCandidates = New-Object System.Collections.Generic.List[string]
foreach ($commandName in @('bash', 'sh')) {
    $shellCommand = Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($shellCommand -and -not $bashCandidates.Contains($shellCommand.Source)) {
        $bashCandidates.Add($shellCommand.Source)
    }
}
$gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($gitCommand) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
    foreach ($relativeShell in @('usr\bin\bash.exe', 'usr\bin\sh.exe', 'bin\bash.exe')) {
        $candidateShell = Join-Path $gitRoot $relativeShell
        if ((Test-Path -LiteralPath $candidateShell -PathType Leaf) -and
            -not $bashCandidates.Contains($candidateShell)) {
            $bashCandidates.Add($candidateShell)
        }
    }
}
$bashExecutable = $null
foreach ($candidateShell in $bashCandidates) {
    $shellVersion = @(& $candidateShell --version 2>&1)
    if ($LASTEXITCODE -eq 0 -and ($shellVersion -join "`n") -match 'GNU bash') {
        $bashExecutable = $candidateShell
        break
    }
}
if (-not $bashExecutable) {
    throw '完整验证需要 Bash 解析 ECS 运维脚本；未找到 GNU Bash。'
}
$ecsScriptDirectory = Join-Path $workspaceRoot 'infra\ecs\scripts'
foreach ($scriptFile in Get-ChildItem -LiteralPath $ecsScriptDirectory -Filter '*.sh') {
    $scriptBytes = [System.IO.File]::ReadAllBytes($scriptFile.FullName)
    if ($scriptBytes -contains 0x0D) {
        throw "$($scriptFile.Name) 必须使用 LF，不能提交 CRLF。"
    }
    $firstScriptLine = [System.IO.File]::ReadLines($scriptFile.FullName) |
        Select-Object -First 1
    if ($firstScriptLine -cne '#!/usr/bin/env bash') {
        throw "$($scriptFile.Name) 缺少固定 Bash shebang。"
    }
    & $bashExecutable -n -- $scriptFile.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "$($scriptFile.Name) 未通过 bash -n，退出码：$LASTEXITCODE"
    }
}

Write-Host '== AMap live smoke wrapper: offline safety =='
& (Join-Path $PSScriptRoot 'run-amap-live-smoke.test.ps1')

Write-Host '== Local public API environment template =='
$localApiEnvironmentTemplate = Join-Path $workspaceRoot '.env.local.example'
& (Join-Path $PSScriptRoot 'start-api-local.ps1') `
    -EnvFile $localApiEnvironmentTemplate `
    -ValidateOnly

Write-Host '== Local API launcher: child environment isolation =='
$previousDecoySecret = $env:CHISHENME_PARENT_SECRET_DECOY
$previousExternalAmapKey = $env:AMAP_WEB_SERVICE_KEY
try {
    $env:CHISHENME_PARENT_SECRET_DECOY = 'must-not-reach-any-child'
    $env:AMAP_WEB_SERVICE_KEY = 'approved-external-secret'
    . (Join-Path $PSScriptRoot 'start-api-local.ps1') `
        -EnvFile $localApiEnvironmentTemplate `
        -ValidateOnly
    $isolationFixture = [ordered]@{
        NODE_ENV = 'development'
        AMAP_ENABLED = 'true'
        AMAP_WEB_SERVICE_KEY = ''
        GROUP_RECOMMENDATIONS_ENABLED = 'true'
    }
    $runtimeFixture = New-RuntimeChildEnvironment -Entries $isolationFixture
    $buildFixture = New-MinimalChildEnvironment
    if ($runtimeFixture.Contains('CHISHENME_PARENT_SECRET_DECOY') -or
        $buildFixture.Contains('CHISHENME_PARENT_SECRET_DECOY')) {
        throw '本机启动器把未授权的父进程密钥泄漏给了子进程。'
    }
    if ($runtimeFixture['AMAP_WEB_SERVICE_KEY'] -cne 'approved-external-secret') {
        throw '本机启动器没有把显式批准的外部高德密钥注入运行进程。'
    }
    if ($buildFixture.Contains('AMAP_WEB_SERVICE_KEY')) {
        throw '本机启动器把运行时高德密钥泄漏给了构建进程。'
    }
    if ($runtimeFixture['GROUP_RECOMMENDATIONS_ENABLED'] -cne 'true' -or
        $buildFixture.Contains('GROUP_RECOMMENDATIONS_ENABLED')) {
        throw '本机启动器没有把群组能力开关只注入运行进程。'
    }
} finally {
    $env:CHISHENME_PARENT_SECRET_DECOY = $previousDecoySecret
    $env:AMAP_WEB_SERVICE_KEY = $previousExternalAmapKey
}

Write-Host '== Local API launcher: PNVS PHONE_ONLY without unrelated provider secrets =='
$launcherFixtureTempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$launcherFixturePath = Join-Path $launcherFixtureTempBase (
    'chishenme-pnvs-phone-only-' + [Guid]::NewGuid().ToString('N') + '.env'
)
$fixtureHashKey = [Convert]::ToBase64String([byte[]](1..32))
try {
    [System.IO.File]::WriteAllLines(
        $launcherFixturePath,
        @(
            'NODE_ENV=development',
            'DATABASE_ENABLED=true',
            'DATABASE_URL=postgresql://fixture:fixture@localhost:5432/fixture',
            'AUTH_SCHEMA_TRANSITION_MODE=none',
            'ACCOUNTS_ENABLED=true',
            'PHONE_AUTH_ENABLED=true',
            'EMAIL_AUTH_ENABLED=false',
            'WECHAT_AUTH_ENABLED=false',
            'QQ_AUTH_ENABLED=false',
            'QQ_UNION_ID_ENABLED=false',
            'AUTH_HASH_ACTIVE_VERSION=hash.v1',
            ('AUTH_HASH_KEYS_JSON={"hash.v1":"' + $fixtureHashKey + '"}'),
            'AUTH_IDENTITY_DEDUP_KEY_VERSION=hash.v1',
            'AUTH_OTP_PEPPER_ACTIVE_VERSION=',
            'AUTH_OTP_PEPPER_KEYS_JSON=',
            'ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/env',
            'ALIYUN_PNVS_SIGN_NAME=测试签名',
            'ALIYUN_PNVS_TEMPLATE_CODE=100001'
        ),
        [System.Text.UTF8Encoding]::new($false)
    )
    & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
        -EnvFile $launcherFixturePath `
        -ValidateOnly

    $phoneFixtureEntries = [ordered]@{}
    $fixtureLineNumber = 0
    foreach ($fixtureLine in [System.IO.File]::ReadLines($launcherFixturePath)) {
        $fixtureLineNumber += 1
        $fixtureEntry = ConvertFrom-PrivateEnvLine `
            -Line $fixtureLine `
            -LineNumber $fixtureLineNumber
        if ($null -ne $fixtureEntry) {
            $phoneFixtureEntries[$fixtureEntry.Key] = $fixtureEntry.Value
        }
    }
    $phoneRuntimeFixture = New-RuntimeChildEnvironment -Entries $phoneFixtureEntries
    if ($phoneRuntimeFixture['PHONE_AUTH_ENABLED'] -cne 'true' -or
        $phoneRuntimeFixture['WECHAT_AUTH_ENABLED'] -cne 'false' -or
        $phoneRuntimeFixture['QQ_AUTH_ENABLED'] -cne 'false') {
        throw 'PHONE_ONLY 启动器夹具没有保持 Phone=true、WeChat=false、QQ=false。'
    }
    if ($phoneRuntimeFixture.Contains('AUTH_OTP_PEPPER_KEYS_JSON') -or
        ($phoneRuntimeFixture.Contains('AUTH_OTP_PEPPER_ACTIVE_VERSION') -and
            -not [string]::IsNullOrEmpty(
                [string]$phoneRuntimeFixture['AUTH_OTP_PEPPER_ACTIVE_VERSION']
            ))) {
        throw 'PNVS 手机验证码不应向运行进程注入本地 OTP pepper。'
    }
    if (-not $phoneRuntimeFixture.Contains('AUTH_HASH_KEYS_JSON')) {
        throw 'PHONE_ONLY 启动器遗漏了账号必需的 hash key ring。'
    }
    if ($phoneRuntimeFixture.Contains('WECHAT_APP_ID') -or
        $phoneRuntimeFixture.Contains('WECHAT_APP_SECRET') -or
        $phoneRuntimeFixture.Contains('SMTP_PASSWORD') -or
        $phoneRuntimeFixture.Contains('SMTP_REPLY_TO') -or
        $phoneRuntimeFixture.Contains('QQ_APP_ID') -or
        $phoneRuntimeFixture.Contains('QQ_APP_KEY')) {
        throw '关闭的微信、邮件或 QQ 通道仍向 PHONE_ONLY 运行进程注入了配置。'
    }

    $phoneOnlyFixture = [System.IO.File]::ReadAllLines($launcherFixturePath)
    $unionAliasBridgeFixture = [string[]]$phoneOnlyFixture.Clone()
    for ($fixtureIndex = 0; $fixtureIndex -lt $unionAliasBridgeFixture.Length; $fixtureIndex++) {
        if ($unionAliasBridgeFixture[$fixtureIndex] -ceq 'AUTH_SCHEMA_TRANSITION_MODE=none') {
            $unionAliasBridgeFixture[$fixtureIndex] =
                'AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending'
        }
    }
    [System.IO.File]::WriteAllLines(
        $launcherFixturePath,
        $unionAliasBridgeFixture,
        [System.Text.UTF8Encoding]::new($false)
    )
    & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
        -EnvFile $launcherFixturePath `
        -ValidateOnly

    $unsafeUnionAliasBridgeFixture = [string[]]$unionAliasBridgeFixture.Clone()
    for ($fixtureIndex = 0; $fixtureIndex -lt $unsafeUnionAliasBridgeFixture.Length; $fixtureIndex++) {
        if ($unsafeUnionAliasBridgeFixture[$fixtureIndex] -ceq 'WECHAT_AUTH_ENABLED=false') {
            $unsafeUnionAliasBridgeFixture[$fixtureIndex] = 'WECHAT_AUTH_ENABLED=true'
        }
    }
    [System.IO.File]::WriteAllLines(
        $launcherFixturePath,
        $unsafeUnionAliasBridgeFixture,
        [System.Text.UTF8Encoding]::new($false)
    )
    $unsafeUnionAliasBridgeRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
            -EnvFile $launcherFixturePath `
            -ValidateOnly
    } catch {
        if ($_.Exception.Message -notmatch
            'wechat_union_aliases_pending 要求 WECHAT_AUTH_ENABLED=false') {
            throw
        }
        $unsafeUnionAliasBridgeRejected = $true
    }
    if (-not $unsafeUnionAliasBridgeRejected) {
        throw '启动器错误接受了 wechat_union_aliases_pending 与 WECHAT_AUTH_ENABLED=true 的组合。'
    }

    $legacyDrainFixture = [string[]]$phoneOnlyFixture.Clone()
    for ($fixtureIndex = 0; $fixtureIndex -lt $legacyDrainFixture.Length; $fixtureIndex++) {
        if ($legacyDrainFixture[$fixtureIndex] -ceq 'AUTH_SCHEMA_TRANSITION_MODE=none') {
            $legacyDrainFixture[$fixtureIndex] =
                'AUTH_SCHEMA_TRANSITION_MODE=legacy_phone_drain'
        }
    }
    [System.IO.File]::WriteAllLines(
        $launcherFixturePath,
        $legacyDrainFixture,
        [System.Text.UTF8Encoding]::new($false)
    )
    $legacyDrainRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
            -EnvFile $launcherFixturePath `
            -ValidateOnly
    } catch {
        if ($_.Exception.Message -notmatch
            'legacy_phone_drain 要求 ACCOUNTS_ENABLED=false') {
            throw
        }
        $legacyDrainRejected = $true
    }
    if (-not $legacyDrainRejected) {
        throw '启动器错误接受了 legacy_phone_drain 与 ACCOUNTS_ENABLED=true 的组合。'
    }
} finally {
    $resolvedLauncherFixturePath = [System.IO.Path]::GetFullPath($launcherFixturePath)
    if (-not $resolvedLauncherFixturePath.StartsWith(
        $launcherFixtureTempBase,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or [System.IO.Path]::GetFileName($resolvedLauncherFixturePath) -notlike
        'chishenme-pnvs-phone-only-*.env') {
        throw 'PHONE_ONLY 启动器夹具临时文件越界，拒绝清理。'
    }
    if ([System.IO.File]::Exists($resolvedLauncherFixturePath)) {
        [System.IO.File]::Delete($resolvedLauncherFixturePath)
    }
}

Write-Host '== Local API launcher: support feedback secret isolation =='
$feedbackLauncherFixturePath = Join-Path $launcherFixtureTempBase (
    'chishenme-support-feedback-' + [Guid]::NewGuid().ToString('N') + '.env'
)
$feedbackEncryptionBytes = New-Object byte[] 32
$feedbackHmacBytes = New-Object byte[] 32
$feedbackRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $feedbackRandom.GetBytes($feedbackEncryptionBytes)
    $feedbackEncryptionKey = [Convert]::ToBase64String($feedbackEncryptionBytes)
    do {
        $feedbackRandom.GetBytes($feedbackHmacBytes)
        $feedbackHmacKey = [Convert]::ToBase64String($feedbackHmacBytes)
    } while ($feedbackHmacKey -ceq $feedbackEncryptionKey)

    [System.IO.File]::WriteAllLines(
        $feedbackLauncherFixturePath,
        @(
            'NODE_ENV=development',
            'DATABASE_ENABLED=true',
            'DATABASE_URL=postgresql://fixture:fixture@localhost:5432/fixture',
            'SUPPORT_FEEDBACK_ENABLED=true',
            'SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION=fixture-enc-v1',
            ('SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON={"fixture-enc-v1":"' +
                $feedbackEncryptionKey + '"}'),
            'SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION=fixture-hmac-v1',
            ('SUPPORT_FEEDBACK_HMAC_KEYS_JSON={"fixture-hmac-v1":"' +
                $feedbackHmacKey + '"}')
        ),
        [System.Text.UTF8Encoding]::new($false)
    )
    & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
        -EnvFile $feedbackLauncherFixturePath `
        -ValidateOnly

    $feedbackFixtureEntries = [ordered]@{}
    $feedbackFixtureLineNumber = 0
    foreach ($feedbackFixtureLine in [System.IO.File]::ReadLines($feedbackLauncherFixturePath)) {
        $feedbackFixtureLineNumber += 1
        $feedbackFixtureEntry = ConvertFrom-PrivateEnvLine `
            -Line $feedbackFixtureLine `
            -LineNumber $feedbackFixtureLineNumber
        if ($null -ne $feedbackFixtureEntry) {
            $feedbackFixtureEntries[$feedbackFixtureEntry.Key] = $feedbackFixtureEntry.Value
        }
    }
    $feedbackRuntimeFixture = New-RuntimeChildEnvironment -Entries $feedbackFixtureEntries
    foreach ($requiredFeedbackRuntimeKey in @(
        'SUPPORT_FEEDBACK_ENABLED',
        'SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION',
        'SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON',
        'SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION',
        'SUPPORT_FEEDBACK_HMAC_KEYS_JSON'
    )) {
        if (-not $feedbackRuntimeFixture.Contains($requiredFeedbackRuntimeKey)) {
            throw "反馈启动器夹具遗漏了 $requiredFeedbackRuntimeKey。"
        }
    }
    $feedbackBuildFixture = New-MinimalChildEnvironment
    if ($feedbackBuildFixture.Contains('SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON') -or
        $feedbackBuildFixture.Contains('SUPPORT_FEEDBACK_HMAC_KEYS_JSON')) {
        throw '本机启动器把反馈密钥泄漏给了构建进程。'
    }

    $feedbackFixtureEntries['SUPPORT_FEEDBACK_ENABLED'] = 'false'
    $disabledFeedbackRuntimeFixture = New-RuntimeChildEnvironment -Entries $feedbackFixtureEntries
    if ($disabledFeedbackRuntimeFixture.Contains('SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON') -or
        $disabledFeedbackRuntimeFixture.Contains('SUPPORT_FEEDBACK_HMAC_KEYS_JSON')) {
        throw '反馈关闭后本机启动器仍向运行进程注入反馈密钥。'
    }

    $feedbackFixtureEntries['SUPPORT_FEEDBACK_ENABLED'] = 'true'
    $feedbackFixtureEntries['DATABASE_ENABLED'] = 'false'
    [System.IO.File]::WriteAllLines(
        $feedbackLauncherFixturePath,
        @($feedbackFixtureEntries.Keys | ForEach-Object {
            "$_=$($feedbackFixtureEntries[$_])"
        }),
        [System.Text.UTF8Encoding]::new($false)
    )
    $feedbackWithoutDatabaseRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'start-api-local.ps1') `
            -EnvFile $feedbackLauncherFixturePath `
            -ValidateOnly
    } catch {
        if ($_.Exception.Message -notmatch
            'SUPPORT_FEEDBACK_ENABLED=true 时 DATABASE_ENABLED 必须') {
            throw
        }
        $feedbackWithoutDatabaseRejected = $true
    }
    if (-not $feedbackWithoutDatabaseRejected) {
        throw '本机启动器错误接受了没有 PostgreSQL 的反馈服务。'
    }
} finally {
    [Array]::Clear($feedbackEncryptionBytes, 0, $feedbackEncryptionBytes.Length)
    [Array]::Clear($feedbackHmacBytes, 0, $feedbackHmacBytes.Length)
    $feedbackRandom.Dispose()
    $feedbackEncryptionKey = $null
    $feedbackHmacKey = $null
    $resolvedFeedbackLauncherFixturePath =
        [System.IO.Path]::GetFullPath($feedbackLauncherFixturePath)
    if (-not $resolvedFeedbackLauncherFixturePath.StartsWith(
        $launcherFixtureTempBase,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or [System.IO.Path]::GetFileName($resolvedFeedbackLauncherFixturePath) -notlike
        'chishenme-support-feedback-*.env') {
        throw '反馈启动器夹具临时文件越界，拒绝清理。'
    }
    if ([System.IO.File]::Exists($resolvedFeedbackLauncherFixturePath)) {
        [System.IO.File]::Delete($resolvedFeedbackLauncherFixturePath)
    }
}

Write-Host '== Credentials: repository and Android secret boundary =='
foreach ($ignoreFile in @('.gitignore', '.dockerignore')) {
    $ignoreText = [System.IO.File]::ReadAllText((Join-Path $workspaceRoot $ignoreFile))
    foreach ($requiredPattern in @('*.pem', '*.key', '*.p12', '*.pfx')) {
        if ($ignoreText -notmatch ('(?m)^' + [regex]::Escape($requiredPattern) + '$')) {
            throw "$ignoreFile 没有排除私钥容器格式 $requiredPattern。"
        }
    }
}
$excludedCredentialPathPattern =
    '[\\/](?:\.git|node_modules|\.pnpm-store|\.gradle|\.tools|build|dist|coverage)[\\/]'
$privateCredentialFiles = @(
    Get-ChildItem -LiteralPath $workspaceRoot -Recurse -File |
        Where-Object {
            $_.FullName -notmatch $excludedCredentialPathPattern -and
            $_.Extension -in @('.pem', '.key', '.p12', '.pfx')
        }
)
if ($privateCredentialFiles.Count -gt 0) {
    throw "仓库工作区包含私钥文件：$($privateCredentialFiles[0].FullName)"
}
$credentialTextFiles = @(
    Get-ChildItem -LiteralPath $workspaceRoot -Recurse -File |
        Where-Object {
            $_.FullName -notmatch $excludedCredentialPathPattern -and
            ($_.Extension -in @(
                '.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.xml',
                '.kt', '.kts', '.java', '.sh', '.sql', '.gradle', '.toml',
                '.properties', '.ps1', '.cmd', '.bat', '.txt'
            ) -or $_.Name -in @('.env.example', '.env.local.example') -or
                $_.Name -like '*.env.example')
        }
)
$qqCredentialAssignmentPattern =
    '(?i)^[ \t]*(?:(?:export|const|let|var)[ \t]+)?(?:-[ \t]+)?' +
    '[\x22\x27]?QQ_APP_(?:KEY|SECRET)[\x22\x27]?[ \t]*[:=][ \t]*'
function Test-QqCredentialLiteral {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Line
    )

    $assignmentMatches = [regex]::Matches(
        $Line,
        $qqCredentialAssignmentPattern
    )
    for ($index = 0; $index -lt $assignmentMatches.Count; $index++) {
        $assignment = $assignmentMatches[$index]
        $valueStart = $assignment.Index + $assignment.Length
        $valueEnd = if ($index + 1 -lt $assignmentMatches.Count) {
            $assignmentMatches[$index + 1].Index
        } else {
            $Line.Length
        }
        $rawValue = $Line.Substring($valueStart, $valueEnd - $valueStart).Trim()
        if ([string]::IsNullOrWhiteSpace($rawValue) -or
            $rawValue.StartsWith('<', [StringComparison]::Ordinal) -or
            $rawValue.StartsWith('`', [StringComparison]::Ordinal) -or
            $rawValue.IndexOf('${', [StringComparison]::Ordinal) -ge 0 -or
            $rawValue.IndexOf('.repeat(', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            continue
        }

        $candidate = $rawValue
        if ($rawValue[0] -in @([char]0x22, [char]0x27)) {
            $quote = $rawValue[0]
            $closingQuote = $rawValue.IndexOf($quote, 1)
            if ($closingQuote -lt 1) {
                continue
            }
            $candidate = $rawValue.Substring(1, $closingQuote - 1)
        } else {
            $candidate = $candidate.TrimEnd()
            while ($candidate.Length -gt 0 -and
                $candidate[$candidate.Length - 1] -in @(',', ';', '}')) {
                $candidate = $candidate.Substring(0, $candidate.Length - 1).TrimEnd()
            }
        }

        if ($candidate.Length -lt 16 -or $candidate.Length -gt 256) {
            continue
        }
        $nonPrintableCharacter = @(
            $candidate.ToCharArray() |
                Where-Object { [int]$_ -lt 0x20 -or [int]$_ -gt 0x7E }
        )
        if ($nonPrintableCharacter.Count -eq 0) {
            return $true
        }
    }
    return $false
}

$qqCredentialName = 'QQ_APP_' + 'KEY'
if (-not (Test-QqCredentialLiteral -Line ($qqCredentialName + '="Abc!2345:xyz?6789"')) -or
    -not (Test-QqCredentialLiteral -Line ($qqCredentialName + '=' + ('A!' * 128))) -or
    (Test-QqCredentialLiteral -Line ($qqCredentialName + '=' + ('A!' * 128) + 'Z')) -or
    (Test-QqCredentialLiteral -Line ($qqCredentialName + '=<server-only-placeholder>')) -or
    (Test-QqCredentialLiteral -Line ($qqCredentialName + ': "a".repeat(32),')) -or
    (Test-QqCredentialLiteral -Line ($qqCredentialName + ': `${appKeyMarker}\n`,') )) {
    throw 'QQ AppKey 高置信扫描规则未覆盖 API 接受的 16-256 位可打印 ASCII 边界。'
}
$highConfidenceCredentialLeak = @(
    $credentialTextFiles |
        Select-String -Pattern @(
            '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            '\bLTAI[A-Za-z0-9]{16,32}\b',
            '(?:AMAP_WEB_SERVICE_KEY|AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY|WECHAT_APP_SECRET)\s*[:=]\s*["'']?[0-9a-fA-F]{32}["'']?'
        )
    $credentialTextFiles |
        Select-String -Pattern $qqCredentialAssignmentPattern |
        Where-Object { Test-QqCredentialLiteral -Line $_.Line }
)
if ($highConfidenceCredentialLeak.Count -gt 0) {
    throw "检测到疑似真实凭据：$($highConfidenceCredentialLeak[0].Path):$($highConfidenceCredentialLeak[0].LineNumber)"
}
$androidSourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $workspaceRoot 'apps\android') -Recurse -File |
        Where-Object {
            $_.FullName -notmatch '[\\/](?:\.gradle|build)[\\/]' -and
            $_.Extension -in @('.kt', '.kts', '.java', '.xml', '.properties')
        }
)
$androidForbiddenSecretIdentifier = @(
    $androidSourceFiles |
        Select-String -SimpleMatch -Pattern @(
            'AMAP_WEB_SERVICE_KEY',
            'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
            'WECHAT_APP_SECRET',
            'QQ_APP_KEY',
            'QQ_APP_SECRET',
            'SMTP_PASSWORD',
            'SMTP_REPLY_TO',
            'ALIBABA_CLOUD_ACCESS_KEY_ID',
            'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
            'AUTH_HASH_KEYS_JSON',
            'AUTH_OTP_PEPPER_KEYS_JSON',
            'SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON',
            'SUPPORT_FEEDBACK_HMAC_KEYS_JSON'
        )
)
if ($androidForbiddenSecretIdentifier.Count -gt 0) {
    throw "Android 源码引用了服务端密钥：$($androidForbiddenSecretIdentifier[0].Path):$($androidForbiddenSecretIdentifier[0].LineNumber)"
}

Write-Host '== Android: pinned QQ OpenSDK Lite integrity =='
$qqOpenSdkJar = Join-Path $workspaceRoot `
    'apps\android\app\libs\open_sdk_3.5.19_r9483ffc7_lite.jar'
if (-not (Test-Path -LiteralPath $qqOpenSdkJar -PathType Leaf)) {
    throw '固定 QQ OpenSDK Lite JAR 缺失。'
}
$qqOpenSdkArtifact = Get-Item -LiteralPath $qqOpenSdkJar
if ($qqOpenSdkArtifact.Length -ne 333248) {
    throw '固定 QQ OpenSDK Lite JAR 大小不匹配。'
}
$qqOpenSdkHash = (Get-FileHash -LiteralPath $qqOpenSdkJar -Algorithm SHA256).Hash
if ($qqOpenSdkHash -cne '9D57FE61FF9026D34AC84BC63DC719F61DA6AA40533A299CC6F73D4CE9DF7AF8') {
    throw '固定 QQ OpenSDK Lite JAR SHA-256 不匹配。'
}
$qqOpenSdkCandidates = @(
    Get-ChildItem -LiteralPath (Split-Path -Parent $qqOpenSdkJar) -File |
        Where-Object { $_.Name -match '(?i)(?:open[_-]?sdk|qq).*\.(?:jar|aar)$' }
)
if ($qqOpenSdkCandidates.Count -ne 1 -or
    $qqOpenSdkCandidates[0].FullName -cne $qqOpenSdkArtifact.FullName) {
    throw 'QQ SDK 目录必须且只能包含固定的 OpenSDK Lite 工件。'
}
$qqSdkAdapterSource = Join-Path $workspaceRoot `
    'apps\android\app\src\main\java\com\chishenme\app\auth\qq\QqSdkAdapter.kt'
$qqSdkAdapterText = [System.IO.File]::ReadAllText($qqSdkAdapterSource)
if ([regex]::Matches(
        $qqSdkAdapterText,
        'tencent\.loginServerSide\(activity, LOGIN_SCOPE, listener\)'
    ).Count -ne 1 -or
    $qqSdkAdapterText -match 'tencent\.login\(' -or
    [regex]::Matches(
        $qqSdkAdapterText,
        'json\.optString\("access_token"\)\.takeIf\(String::isNotBlank\)'
    ).Count -ne 1 -or
    [regex]::Matches(
        $qqSdkAdapterText,
        'QqSdkCallback\.Authorized\(authorizationCode\)'
    ).Count -ne 1 -or
    $qqSdkAdapterText -match 'optString\("(?:openid|unionid)"\)') {
    throw 'QQ Android 适配器必须固定使用 loginServerSide，并只把历史 access_token 字段映射为 authorization code。'
}

Write-Host '== Android: decision-only product boundary =='
$androidMainSourceRoot = Join-Path $workspaceRoot 'apps\android\app\src\main'
$androidRestaurantSearchFiles = @(
    'java\com\chishenme\app\data\PlaceSearchRepository.kt',
    'java\com\chishenme\app\data\remote\PlaceSearchApi.kt',
    'java\com\chishenme\app\data\remote\PlaceSearchContracts.kt'
)
foreach ($relativePath in $androidRestaurantSearchFiles) {
    $candidate = Join-Path $androidMainSourceRoot $relativePath
    if (Test-Path -LiteralPath $candidate) {
        throw "Android 不得保留直接餐厅搜索生产文件：$relativePath"
    }
}
$androidRestaurantSearchUiFiles = @(
    Get-ChildItem -LiteralPath (
        Join-Path $androidMainSourceRoot 'java\com\chishenme\app\feature\search'
    ) -Filter 'PlaceSearch*.kt' -File -ErrorAction SilentlyContinue
)
if ($androidRestaurantSearchUiFiles.Count -gt 0) {
    throw "Android 不得保留直接餐厅搜索界面文件：$($androidRestaurantSearchUiFiles[0].FullName)"
}
$androidMainProductSourceFiles = @(
    Get-ChildItem -LiteralPath $androidMainSourceRoot -Recurse -File |
        Where-Object { $_.Extension -in @('.kt', '.java', '.xml') }
)
$androidRestaurantSearchResidue = @(
    $androidMainProductSourceFiles |
        Select-String -CaseSensitive -Pattern @(
            '\bPlaceSearch[A-Za-z0-9_]*\b',
            '\bplace-search\b',
            '\bonOpenPlaceSearch\b',
            '已经知道想吃什么',
            '搜索附近餐厅',
            '餐厅搜索'
        )
)
if ($androidRestaurantSearchResidue.Count -gt 0) {
    throw "Android 仍包含直接餐厅搜索模块、路由或 API 调用：$($androidRestaurantSearchResidue[0].Path):$($androidRestaurantSearchResidue[0].LineNumber)"
}
$serviceCapabilitiesContract = [System.IO.Path]::GetFullPath(
    (Join-Path $androidMainSourceRoot 'java\com\chishenme\app\data\remote\RecommendationContracts.kt')
)
$unexpectedPlaceSearchCapabilityUse = @(
    $androidMainProductSourceFiles |
        Select-String -SimpleMatch 'placeSearchEnabled' |
        Where-Object {
            [System.IO.Path]::GetFullPath($_.Path) -ne $serviceCapabilitiesContract
        }
)
if ($unexpectedPlaceSearchCapabilityUse.Count -gt 0) {
    throw "Android 只能在 v1 配置 DTO 中兼容 placeSearchEnabled，产品代码不得消费该字段：$($unexpectedPlaceSearchCapabilityUse[0].Path):$($unexpectedPlaceSearchCapabilityUse[0].LineNumber)"
}

Write-Host '== Node workspace: lint =='
pnpm lint
if ($LASTEXITCODE -ne 0) {
    throw "Node lint 失败，pnpm 退出码：$LASTEXITCODE"
}

Write-Host '== Node workspace: typecheck =='
pnpm typecheck
if ($LASTEXITCODE -ne 0) {
    throw "Node typecheck 失败，pnpm 退出码：$LASTEXITCODE"
}

Write-Host '== Node workspace: tests =='
pnpm test
if ($LASTEXITCODE -ne 0) {
    throw "Node 测试失败，pnpm 退出码：$LASTEXITCODE"
}

Write-Host '== Node workspace: production build =='
pnpm build
if ($LASTEXITCODE -ne 0) {
    throw "Node 生产构建失败，pnpm 退出码：$LASTEXITCODE"
}

Write-Host '== ECS preflight: production auth-config fixture =='
$authConfigFixture = @'
const { loadAuthRuntimeConfig } = await import("./apps/api/dist/auth/auth-config.js");
const { loadDatabaseConfig } = await import("./apps/api/dist/database/database-config.js");
const hashKey = Buffer.alloc(32, 7).toString("base64");
const valid = {
  AUTH_SCHEMA_TRANSITION_MODE: "none",
  PHONE_AUTH_ENABLED: "true",
  EMAIL_AUTH_ENABLED: "false",
  WECHAT_AUTH_ENABLED: "false",
  QQ_AUTH_ENABLED: "false",
  QQ_UNION_ID_ENABLED: "false",
  AUTH_HASH_ACTIVE_VERSION: "hash.v1",
  AUTH_HASH_KEYS_JSON: JSON.stringify({ "hash.v1": hashKey }),
  AUTH_IDENTITY_DEDUP_KEY_VERSION: "hash.v1",
  ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/ecs_ram_role",
  ALIYUN_PNVS_SIGN_NAME: "吃什么",
  ALIYUN_PNVS_TEMPLATE_CODE: "100001",
};
const options = { accountsEnabled: true, databaseEnabled: true, production: true };
const config = loadAuthRuntimeConfig(valid, options);
if (
  Object.hasOwn(valid, "WECHAT_APP_ID") ||
  Object.hasOwn(valid, "WECHAT_APP_SECRET") ||
  Object.hasOwn(valid, "SMTP_PASSWORD") ||
  Object.hasOwn(valid, "SMTP_REPLY_TO") ||
  Object.hasOwn(valid, "QQ_APP_ID") ||
  Object.hasOwn(valid, "QQ_APP_KEY")
) process.exit(20);
if (
  !config.phone.enabled ||
  config.email.enabled ||
  config.wechat.enabled ||
  config.qq.enabled ||
  config.qq.unionIdEnabled ||
  !config.registrationEnabled ||
  config.otpPepperRing !== null
) process.exit(21);
const unionAliasBridge = loadDatabaseConfig({
  DATABASE_ENABLED: "false",
  AUTH_SCHEMA_TRANSITION_MODE: "wechat_union_aliases_pending",
  WECHAT_AUTH_ENABLED: "false",
}, "test");
if (unionAliasBridge.authSchemaTransitionMode !== "wechat_union_aliases_pending") {
  process.exit(22);
}
let unsafeUnionAliasBridgeRejected = false;
try {
  loadDatabaseConfig({
    DATABASE_ENABLED: "false",
    AUTH_SCHEMA_TRANSITION_MODE: "wechat_union_aliases_pending",
    WECHAT_AUTH_ENABLED: "true",
  }, "test");
} catch (error) {
  unsafeUnionAliasBridgeRejected = String(error).includes(
    "wechat_union_aliases_pending 时必须关闭 WECHAT_AUTH_ENABLED",
  );
}
if (!unsafeUnionAliasBridgeRejected) process.exit(23);

const wechatEnabled = {
  ...valid,
  WECHAT_AUTH_ENABLED: "true",
  WECHAT_APP_ID: "wx0123456789abcdef",
  WECHAT_APP_SECRET: "ci-placeholder-not-a-real-secret",
  WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
};
const wechatConfig = loadAuthRuntimeConfig(wechatEnabled, options);
if (
  !wechatConfig.wechat.enabled ||
  wechatConfig.wechat.openPlatformRealmId !== "eatwhat-primary"
) process.exit(24);
for (const invalid of [
  Object.fromEntries(
    Object.entries(wechatEnabled).filter(([name]) => name !== "WECHAT_OPEN_PLATFORM_REALM_ID"),
  ),
  { ...wechatEnabled, WECHAT_OPEN_PLATFORM_REALM_ID: "EatWhat-Primary" },
]) {
  let rejected = false;
  try { loadAuthRuntimeConfig(invalid, options); } catch { rejected = true; }
  if (!rejected) process.exit(25);
}
const qqUnionEnabled = {
  ...valid,
  QQ_AUTH_ENABLED: "true",
  QQ_UNION_ID_ENABLED: "true",
  QQ_APP_ID: "123456789",
  QQ_APP_KEY: "a".repeat(32),
  QQ_OPEN_PLATFORM_REALM_ID: "eatwhat-qq-primary",
};
const qqConfig = loadAuthRuntimeConfig(qqUnionEnabled, options);
if (
  !qqConfig.qq.enabled ||
  !qqConfig.qq.unionIdEnabled ||
  qqConfig.qq.openPlatformRealmId !== "eatwhat-qq-primary"
) process.exit(27);
for (const invalid of [
  Object.fromEntries(
    Object.entries(qqUnionEnabled).filter(([name]) => name !== "QQ_OPEN_PLATFORM_REALM_ID"),
  ),
  { ...qqUnionEnabled, QQ_OPEN_PLATFORM_REALM_ID: "EatWhat-QQ-Primary" },
]) {
  let rejected = false;
  try { loadAuthRuntimeConfig(invalid, options); } catch { rejected = true; }
  if (!rejected) process.exit(28);
}
for (const invalid of [
  { ...valid, AUTH_HASH_ACTIVE_VERSION: "bad/version" },
  { ...valid, AUTH_HASH_KEYS_JSON: JSON.stringify({ "hash.v1": "***" }) },
  { ...valid, AUTH_HASH_KEYS_JSON: JSON.stringify({ a: hashKey, b: hashKey, c: hashKey, d: hashKey }) },
  { ...valid, AUTH_IDENTITY_DEDUP_KEY_VERSION: "missing" },
  { ...valid, ALIYUN_PNVS_SIGN_NAME: "" },
  { ...valid, ALIYUN_PNVS_TEMPLATE_CODE: "bad code" },
  { ...valid, QQ_UNION_ID_ENABLED: "true" },
]) {
  let rejected = false;
  try { loadAuthRuntimeConfig(invalid, options); } catch { rejected = true; }
  if (!rejected) process.exit(26);
}
process.stdout.write("AUTH_CONFIG_FIXTURE=OK\n");
'@
node --input-type=module --eval $authConfigFixture
if ($LASTEXITCODE -ne 0) {
    throw "ECS 生产认证配置夹具失败，Node 退出码：$LASTEXITCODE"
}

Write-Host '== ECS: immutable deployment bundle and operational gates =='
$ecsBundleTempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$ecsBundleTemp = Join-Path $ecsBundleTempBase (
    'chishenme-ecs-bundle-' + [Guid]::NewGuid().ToString('N')
)
try {
    & (Join-Path $PSScriptRoot 'build-ecs-deployment-bundle.ps1') `
        -RepositoryRoot $workspaceRoot `
        -OutputDirectory $ecsBundleTemp
    & (Join-Path $PSScriptRoot 'verify-ecs-deployment-bundle.ps1') `
        -RepositoryRoot $workspaceRoot `
        -BundleDirectory $ecsBundleTemp
} finally {
    $resolvedEcsBundleTemp = [System.IO.Path]::GetFullPath($ecsBundleTemp)
    if (-not $resolvedEcsBundleTemp.StartsWith(
        $ecsBundleTempBase,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or [System.IO.Path]::GetFileName($resolvedEcsBundleTemp) -notlike
        'chishenme-ecs-bundle-*') {
        throw 'ECS bundle 临时目录越界，拒绝清理。'
    }
    if ([System.IO.Directory]::Exists($resolvedEcsBundleTemp)) {
        [System.IO.Directory]::Delete($resolvedEcsBundleTemp, $true)
    }
}

Write-Host '== Android: cloud Debug unit tests and lint =='
$mappedDrive = $null
$mappedDriveCreated = $false
$androidWorkspaceRoot = $workspaceRoot
$previousJavaHome = $env:JAVA_HOME
$previousAndroidHome = $env:ANDROID_HOME
$previousAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$previousPath = $env:PATH
$androidBuildMutex = [System.Threading.Mutex]::new($false, 'Local\ChiShenMeAndroidBuild')
$androidBuildLockAcquired = $false

try {
    try {
        $androidBuildLockAcquired = $androidBuildMutex.WaitOne([TimeSpan]::FromSeconds(30))
    } catch [System.Threading.AbandonedMutexException] {
        $androidBuildLockAcquired = $true
    }
    if (-not $androidBuildLockAcquired) {
        throw '等待 Android 构建锁超时；请先结束其他 Android Studio/Gradle 构建。'
    }

    # AGP/KAPT on Windows can misread an SDK or project path containing non-ASCII
    # characters. A temporary subst drive keeps the repository in place while all
    # Java/Android paths seen by the build remain ASCII-only.
    if ($workspaceRoot -match '[^\x00-\x7F]') {
        # A single stable path identity is required. Rotating among W:/V:/U:/T:
        # previously let concurrent Gradle invocations merge DEX buckets from
        # different builds into one incomplete APK.
        $availableDrive = 'W'
        $mappedDrive = "${availableDrive}:"
        $existingDrive = Get-PSDrive -Name $availableDrive -ErrorAction SilentlyContinue
        if ($existingDrive) {
            # Some managed runners pre-map W: to the workspace. Reuse it only
            # after NTFS file IDs prove both paths resolve to the same file.
            $workspaceIdentityProbe = Join-Path $workspaceRoot 'scripts\verify.ps1'
            $mappedIdentityProbe = Join-Path $mappedDrive 'scripts\verify.ps1'
            $workspaceIdentity = & fsutil.exe file queryfileid $workspaceIdentityProbe 2>$null
            $workspaceIdentityExitCode = $LASTEXITCODE
            $mappedIdentity = & fsutil.exe file queryfileid $mappedIdentityProbe 2>$null
            $mappedIdentityExitCode = $LASTEXITCODE
            $normalizedWorkspaceIdentity = ($workspaceIdentity -join "`n").Trim()
            $normalizedMappedIdentity = ($mappedIdentity -join "`n").Trim()
            if ($workspaceIdentityExitCode -ne 0 -or
                $mappedIdentityExitCode -ne 0 -or
                [string]::IsNullOrWhiteSpace($normalizedWorkspaceIdentity) -or
                $normalizedWorkspaceIdentity -ne $normalizedMappedIdentity) {
                throw '固定 Android 构建盘符 W: 已被其他目标占用；为避免混合 DEX，本次验证已安全停止。'
            }
        } else {
            & subst $mappedDrive $workspaceRoot
            $mappedDriveCreated = $LASTEXITCODE -eq 0
            if (-not $mappedDriveCreated) {
                throw '创建 Android 临时 ASCII 盘符失败。'
            }
        }
        if (-not (Test-Path "$mappedDrive\apps\android")) {
            throw 'Android 临时 ASCII 工作区不完整。'
        }
        $androidWorkspaceRoot = "$mappedDrive\"
    }

    . (Join-Path $PSScriptRoot 'android-env.ps1') -WorkspaceRoot $androidWorkspaceRoot
    $androidProject = Join-Path $androidWorkspaceRoot 'apps\android'
    $wrapper = Join-Path $androidProject 'gradlew.bat'
    if (-not (Test-Path $wrapper)) {
        throw 'Android Gradle wrapper 尚未生成。'
    }

    $androidAppBuildFile = Join-Path $androidProject 'app\build.gradle.kts'
    $androidAppBuildText = [System.IO.File]::ReadAllText($androidAppBuildFile)
    $shareFlagMentions = [regex]::Matches($androidAppBuildText, '\bSHARE_FEATURE_ENABLED\b')
    $fixedDisabledShareFlag = [regex]::Matches(
        $androidAppBuildText,
        'buildConfigField\(\s*"boolean"\s*,\s*"SHARE_FEATURE_ENABLED"\s*,\s*"false"\s*\)'
    )
    if ($shareFlagMentions.Count -ne 1 -or $fixedDisabledShareFlag.Count -ne 1) {
        throw 'Android 1.0 分享功能必须且只能由一处固定为 false 的编译期 BuildConfig 常量控制。'
    }

    Write-Host '== Android: no Fusion SDK, phone-state permission, or legacy auth UI =='
    $androidNegativeScanRoots = @(
        (Join-Path $androidProject 'app\src'),
        $androidAppBuildFile
    )
    $androidNegativeSourceFiles = @(
        foreach ($scanRoot in $androidNegativeScanRoots) {
            if (Test-Path -LiteralPath $scanRoot -PathType Container) {
                Get-ChildItem -LiteralPath $scanRoot -Recurse -File |
                    Where-Object { $_.Extension -in @('.kt', '.java', '.xml', '.kts', '.properties') }
            } elseif (Test-Path -LiteralPath $scanRoot -PathType Leaf) {
                Get-Item -LiteralPath $scanRoot
            }
        }
    )
    $androidNegativeSourcePatterns = @(
        'com\.alicom\.fusion',
        '\bAlicomFusion',
        '\bFusionAuth',
        'fusionauth-[^\s"'']*\.aar',
        'umeng-(?:common|asms)[^\s"'']*\.aar',
        'android\.permission\.READ_PHONE_STATE',
        '一键登录',
        '图形验证'
    )
    foreach ($sourceFile in $androidNegativeSourceFiles) {
        $negativeMatch = Select-String -LiteralPath $sourceFile.FullName `
            -Pattern $androidNegativeSourcePatterns -CaseSensitive:$false |
            Select-Object -First 1
        if ($negativeMatch) {
            throw "Android 源码或构建配置仍包含已放弃的 Fusion/电话权限/旧入口：$($negativeMatch.Path):$($negativeMatch.LineNumber)"
        }
    }

    Write-Host '== Android: release endpoint build-logic tests =='
    $buildLogicProject = Join-Path $androidProject 'buildSrc'
    & $wrapper -p $buildLogicProject clean test --stacktrace --no-daemon --no-build-cache --rerun-tasks
    if ($LASTEXITCODE -ne 0) {
        throw "Android 构建逻辑测试失败，Gradle 退出码：$LASTEXITCODE"
    }

    # Always create the installable APK from a clean Android output tree. Builds
    # may also be launched by Android Studio through the repository's real
    # non-ASCII path, so reusing merged DEX output across both path identities is
    # unsafe and previously produced an APK with a missing application class.
    # Ordinary Debug is the developer-facing cloud build. Always inject the
    # same explicitly approved public HTTPS endpoint used for Alpha, so a full
    # verification can never silently fall back to a workstation API.
    & $wrapper -p $androidProject clean testDebugUnitTest lintDebug assembleDebug `
        "-PCHISHENME_DEBUG_API_BASE_URL=$AlphaApiBaseUrl" `
        --stacktrace --no-daemon --no-build-cache --rerun-tasks
    if ($LASTEXITCODE -ne 0) {
        throw "Android 云端 Debug 验证失败，Gradle 退出码：$LASTEXITCODE"
    }

    # Release signing remains mandatory for every package/build task. The
    # dedicated Manifest-only task is deliberately isolated so Gradle can merge
    # the no-op Release Manifest without a keystore, while an invocation that
    # combines it with assemble/bundle still fails closed.
    & $wrapper -p $androidProject processReleaseMainManifest `
        "-PCHISHENME_API_BASE_URL=$AlphaApiBaseUrl" `
        --stacktrace --no-daemon --no-build-cache --rerun-tasks
    if ($LASTEXITCODE -ne 0) {
        throw "Android Release Manifest 门禁失败，Gradle 退出码：$LASTEXITCODE"
    }

    # Instrumentation owns a separate fixture variant with a fixed loopback
    # endpoint. Keep both fixture artifacts in their own Gradle invocation so
    # neither can reuse or overwrite the cloud Debug task graph.
    & $wrapper -p $androidProject assembleFixture assembleFixtureAndroidTest `
        --stacktrace --no-daemon --no-build-cache --rerun-tasks
    if ($LASTEXITCODE -ne 0) {
        throw "Android 隔离 Fixture 验证失败，Gradle 退出码：$LASTEXITCODE"
    }

    # Keep Alpha KAPT/R8 separate from Debug lint. Running both task graphs in
    # one Gradle invocation lets Alpha regenerate temporary KAPT stubs while
    # lintDebugUnitTest is reading them, which is a known Windows lint race.
    & $wrapper -p $androidProject assembleAlpha `
        "-PCHISHENME_ALPHA_API_BASE_URL=$AlphaApiBaseUrl" `
        "-PCHISHENME_ALPHA_WECHAT_APP_ID=$AlphaWechatAppId" `
        "-PCHISHENME_ALPHA_QQ_APP_ID=$AlphaQqAppId" `
        --stacktrace --no-daemon --no-build-cache --rerun-tasks
    if ($LASTEXITCODE -ne 0) {
        throw "Android Alpha 验证失败，Gradle 退出码：$LASTEXITCODE"
    }

    Write-Host '== Android: generated BuildConfig endpoint and share gates =='
    $expectedVariantEndpoints = [ordered]@{
        debug = $AlphaApiBaseUrl
        fixture = 'http://127.0.0.1:3001/'
        alpha = $AlphaApiBaseUrl
    }
    foreach ($variant in $expectedVariantEndpoints.Keys) {
        $generatedBuildConfig = Join-Path $androidProject `
            "app\build\generated\source\buildConfig\$variant\com\chishenme\app\BuildConfig.java"
        if (-not (Test-Path $generatedBuildConfig -PathType Leaf)) {
            throw "Android $variant BuildConfig 缺失：$generatedBuildConfig"
        }
        $generatedBuildConfigText = [System.IO.File]::ReadAllText($generatedBuildConfig)
        $generatedShareFlagMentions = [regex]::Matches(
            $generatedBuildConfigText,
            '\bSHARE_FEATURE_ENABLED\b'
        )
        $generatedDisabledShareFlag = [regex]::Matches(
            $generatedBuildConfigText,
            '(?m)^\s*public static final boolean SHARE_FEATURE_ENABLED = false;\s*$'
        )
        if ($generatedShareFlagMentions.Count -ne 1 -or $generatedDisabledShareFlag.Count -ne 1) {
            throw "Android $variant BuildConfig 未把 SHARE_FEATURE_ENABLED 唯一固定为 false。"
        }
        $expectedEndpoint = $expectedVariantEndpoints[$variant]
        $generatedEndpointFields = [regex]::Matches(
            $generatedBuildConfigText,
            '(?m)^\s*public static final String API_BASE_URL = "([^"]*)";\s*$'
        )
        if ($generatedEndpointFields.Count -ne 1 -or
            $generatedEndpointFields[0].Groups[1].Value -cne $expectedEndpoint) {
            throw "Android $variant BuildConfig 的 API_BASE_URL 不是预期地址：$expectedEndpoint"
        }
        if ($variant -in @('debug', 'alpha')) {
            if ($generatedBuildConfigText -match '(?i)API_BASE_URL\s*=\s*"http://' -or
                $generatedBuildConfigText -match '(?i)API_BASE_URL\s*=\s*"https?://(?:localhost|127\.)') {
                throw "Android $variant BuildConfig 仍包含明文或回环 API 地址。"
            }
        }
        if ($variant -ceq 'alpha') {
            $generatedWechatAppIdFields = [regex]::Matches(
                $generatedBuildConfigText,
                '(?m)^\s*public static final String CHISHENME_WECHAT_APP_ID = "([^"]*)";\s*$'
            )
            if ($generatedWechatAppIdFields.Count -ne 1 -or
                $generatedWechatAppIdFields[0].Groups[1].Value -cne $AlphaWechatAppId) {
                throw 'Android Alpha BuildConfig 未唯一写入预期的微信 AppID。'
            }
        }
        $generatedQqAppIdFields = [regex]::Matches(
            $generatedBuildConfigText,
            '(?m)^\s*public static final String CHISHENME_QQ_APP_ID = "([^"]*)";\s*$'
        )
        $expectedQqAppId = if ($variant -ceq 'alpha') { $AlphaQqAppId } else { '' }
        if ($generatedQqAppIdFields.Count -ne 1 -or
            $generatedQqAppIdFields[0].Groups[1].Value -cne $expectedQqAppId) {
            throw "Android $variant BuildConfig 的 QQ AppID 未保持预期的变体隔离。"
        }
    }

    Write-Host '== Android: installable APK integrity =='
    $debugApkPath = Join-Path $androidProject 'app\build\outputs\apk\debug\app-debug.apk'
    $fixtureApkPath = Join-Path $androidProject 'app\build\outputs\apk\fixture\app-fixture.apk'
    $testApkPath = Join-Path $androidProject 'app\build\outputs\apk\androidTest\fixture\app-fixture-androidTest.apk'
    $alphaApkPath = Join-Path $androidProject 'app\build\outputs\apk\alpha\app-alpha.apk'
    $apkAnalyzer = Join-Path $env:ANDROID_HOME 'cmdline-tools\latest\bin\apkanalyzer.bat'
    $buildTools = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0'
    $apkSigner = Join-Path $buildTools 'apksigner.bat'
    $aapt2 = Join-Path $buildTools 'aapt2.exe'
    $zipAlign = Join-Path $buildTools 'zipalign.exe'
    $dexDump = Join-Path $buildTools 'dexdump.exe'
    foreach ($requiredTool in @($apkAnalyzer, $apkSigner, $aapt2, $zipAlign, $dexDump)) {
        if (-not (Test-Path $requiredTool -PathType Leaf)) {
            throw "无法检查 APK 完整性，缺少 Android 工具：$requiredTool"
        }
    }
    $apkPaths = [ordered]@{
        Debug = $debugApkPath
        Fixture = $fixtureApkPath
        FixtureTest = $testApkPath
        Alpha = $alphaApkPath
    }
    foreach ($label in $apkPaths.Keys) {
        if (-not (Test-Path $apkPaths[$label] -PathType Leaf)) {
            throw "$label APK 缺失：$($apkPaths[$label])"
        }
    }

    $qqServerMarkerPattern = '\bQQ_APP_ID\b'
    if ('QQ_APP_ID' -notmatch $qqServerMarkerPattern) {
        throw 'QQ 服务端标识扫描规则失效。'
    }
    foreach ($allowedClientMarker in @(
            'CHISHENME_QQ_APP_ID',
            'CHISHENME_DEBUG_QQ_APP_ID',
            'CHISHENME_ALPHA_QQ_APP_ID',
            'getQQ_APP_ID'
        )) {
        if ($allowedClientMarker -match $qqServerMarkerPattern) {
            throw "QQ 客户端公开 AppID 标识被密钥规则误报：$allowedClientMarker"
        }
    }

    function Assert-ApkHasNoServerSecrets {
        param(
            [string]$Label,
            [string]$Path,
            [string]$ExpectedApiBaseUrl = '',
            [string]$ExpectedWechatAppId = '',
            [string]$ExpectedQqAppId = '',
            [string[]]$ForbiddenQqAppIds = @(),
            [string[]]$ForbiddenApiBaseUrls = @()
        )

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $scanRoot = Join-Path $tempBase (
            'chishenme-apk-secret-scan-' + [Guid]::NewGuid().ToString('N')
        )
        [System.IO.Directory]::CreateDirectory($scanRoot) | Out-Null
        try {
            $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
            try {
                $archiveForbiddenPatterns = @(
                    'AMAP_WEB_SERVICE_KEY',
                    'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
                    'WECHAT_APP_SECRET',
                    'QQ_APP_KEY',
                    'QQ_APP_SECRET',
                    'ALIYUN_PNVS_SIGN_NAME',
                    'ALIYUN_PNVS_TEMPLATE_CODE',
                    'SMTP_HOST',
                    'SMTP_USERNAME',
                    'SMTP_PASSWORD',
                    'SMTP_REPLY_TO',
                    $qqServerMarkerPattern,
                    'ALIBABA_CLOUD_ACCESS_KEY_ID',
                    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
                    'AUTH_HASH_KEYS_JSON',
                    'AUTH_OTP_PEPPER_KEYS_JSON',
                    'SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON',
                    'SUPPORT_FEEDBACK_HMAC_KEYS_JSON',
                    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                    '\bLTAI[A-Za-z0-9]{16,32}\b',
                    'com[\./]alicom[\./]fusion',
                    '\bAlicomFusion',
                    '\bFusionAuth',
                    'umeng-(?:common|asms)',
                    'android\.permission\.READ_PHONE_STATE',
                    '一键登录',
                    '图形验证'
                )
                foreach ($entry in $archive.Entries) {
                    if ($entry.Length -eq 0) {
                        continue
                    }
                    if ($entry.Length -gt 64MB) {
                        throw "$Label APK 包含超出安全扫描上限的条目。"
                    }
                    $entryStream = $entry.Open()
                    $entryBuffer = New-Object System.IO.MemoryStream
                    try {
                        $entryStream.CopyTo($entryBuffer)
                        $entryText = [System.Text.Encoding]::UTF8.GetString(
                            $entryBuffer.ToArray()
                        )
                    } finally {
                        $entryBuffer.Dispose()
                        $entryStream.Dispose()
                    }
                    if ($entryText | Select-String -Pattern $archiveForbiddenPatterns -Quiet) {
                        throw "$Label APK 的解压条目包含服务端密钥标识或疑似凭据。"
                    }
                }
                $dexEntries = @(
                    $archive.Entries |
                        Where-Object { $_.FullName -match '^classes(?:[2-9][0-9]*)?\.dex$' }
                )
                if ($dexEntries.Count -lt 1) {
                    throw "$Label APK 不包含可扫描的 DEX。"
                }
                $expectedEndpointObserved = [string]::IsNullOrEmpty($ExpectedApiBaseUrl)
                $expectedWechatAppIdObserved = [string]::IsNullOrEmpty($ExpectedWechatAppId)
                $expectedQqAppIdObserved = [string]::IsNullOrEmpty($ExpectedQqAppId)
                foreach ($entry in $dexEntries) {
                    $dexPath = Join-Path $scanRoot $entry.Name
                    $inputStream = $entry.Open()
                    $outputStream = [System.IO.File]::Create($dexPath)
                    try {
                        $inputStream.CopyTo($outputStream)
                    } finally {
                        $outputStream.Dispose()
                        $inputStream.Dispose()
                    }
                    $dexDumpOutput = @(& $dexDump -d $dexPath 2>&1)
                    if ($LASTEXITCODE -ne 0) {
                        throw "dexdump 无法扫描 $Label APK 的 $($entry.Name)。"
                    }
                    if (-not $expectedEndpointObserved -and
                        ($dexDumpOutput | Select-String -SimpleMatch $ExpectedApiBaseUrl -Quiet)) {
                        $expectedEndpointObserved = $true
                    }
                    if (-not $expectedWechatAppIdObserved -and
                        ($dexDumpOutput | Select-String -SimpleMatch $ExpectedWechatAppId -Quiet)) {
                        $expectedWechatAppIdObserved = $true
                    }
                    if (-not $expectedQqAppIdObserved -and
                        ($dexDumpOutput | Select-String -SimpleMatch $ExpectedQqAppId -Quiet)) {
                        $expectedQqAppIdObserved = $true
                    }
                    foreach ($forbiddenQqAppId in $ForbiddenQqAppIds) {
                        if ($dexDumpOutput |
                            Select-String -SimpleMatch $forbiddenQqAppId -Quiet) {
                            throw "$Label APK 的 DEX 包含其他变体的 QQ AppID。"
                        }
                    }
                    foreach ($forbiddenApiBaseUrl in $ForbiddenApiBaseUrls) {
                        if ($dexDumpOutput |
                            Select-String -SimpleMatch $forbiddenApiBaseUrl -Quiet) {
                            throw "$Label APK 的 DEX 包含其他变体的 API 地址：$forbiddenApiBaseUrl"
                        }
                    }
                    $forbidden = @(
                        $dexDumpOutput |
                            Select-String -Pattern $archiveForbiddenPatterns
                    )
                    if ($forbidden.Count -gt 0) {
                        throw "$Label APK 包含服务端密钥标识或疑似凭据。"
                    }
                }
                if (-not $expectedEndpointObserved) {
                    throw "$Label APK 的 DEX 未包含预期 API 地址：$ExpectedApiBaseUrl"
                }
                if (-not $expectedWechatAppIdObserved) {
                    throw "$Label APK 的 DEX 未包含预期微信 AppID。"
                }
                if (-not $expectedQqAppIdObserved) {
                    throw "$Label APK 的 DEX 未包含预期 QQ AppID。"
                }
            } finally {
                $archive.Dispose()
            }
        } finally {
            $resolvedScanRoot = [System.IO.Path]::GetFullPath($scanRoot)
            if (-not $resolvedScanRoot.StartsWith(
                $tempBase,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or [System.IO.Path]::GetFileName($resolvedScanRoot) -notlike
                'chishenme-apk-secret-scan-*') {
                throw 'APK 密钥扫描临时目录越界，拒绝清理。'
            }
            if ([System.IO.Directory]::Exists($resolvedScanRoot)) {
                [System.IO.Directory]::Delete($resolvedScanRoot, $true)
            }
        }
    }

    Assert-ApkHasNoServerSecrets -Label 'Debug' -Path $debugApkPath `
        -ExpectedApiBaseUrl $AlphaApiBaseUrl `
        -ForbiddenQqAppIds @($AlphaQqAppId) `
        -ForbiddenApiBaseUrls @('http://127.0.0.1:3001/')
    Assert-ApkHasNoServerSecrets -Label 'Fixture' -Path $fixtureApkPath `
        -ExpectedApiBaseUrl 'http://127.0.0.1:3001/' `
        -ForbiddenQqAppIds @($AlphaQqAppId) `
        -ForbiddenApiBaseUrls @($AlphaApiBaseUrl)
    Assert-ApkHasNoServerSecrets -Label 'FixtureTest' -Path $testApkPath `
        -ForbiddenQqAppIds @($AlphaQqAppId)
    Assert-ApkHasNoServerSecrets -Label 'Alpha' -Path $alphaApkPath `
        -ExpectedApiBaseUrl $AlphaApiBaseUrl `
        -ExpectedWechatAppId $AlphaWechatAppId `
        -ExpectedQqAppId $AlphaQqAppId `
        -ForbiddenApiBaseUrls @('http://127.0.0.1:3001/')

    function Assert-ApkDexClasses {
        param(
            [string]$Label,
            [string]$Path,
            [string[]]$RequiredClasses
        )

        $definedClasses = @(& $apkAnalyzer dex packages --defined-only $Path)
        if ($LASTEXITCODE -ne 0) {
            throw "apkanalyzer 无法读取 $Label APK。"
        }
        foreach ($requiredClass in $RequiredClasses) {
            $definitionPattern = '^C\s+.*\s' + [regex]::Escape($requiredClass) + '$'
            if (-not ($definedClasses | Select-String -Pattern $definitionPattern -Quiet)) {
                throw "$Label APK 缺少运行时类：$requiredClass"
            }
        }
    }

    function Get-ApkManifestEvidence {
        param(
            [string]$Label,
            [string]$Path,
            [string]$ExpectedPackage
        )

        $badging = @(& $aapt2 dump badging $Path)
        if ($LASTEXITCODE -ne 0) {
            throw "aapt2 无法读取 $Label APK 元数据。"
        }
        $badgingText = $badging -join "`n"
        if ($badgingText -notmatch ("^package: name='" + [regex]::Escape($ExpectedPackage) + "'(?:\s|$)")) {
            throw "$Label APK 包名不是预期值：$ExpectedPackage"
        }

        $manifest = @(& $aapt2 dump xmltree --file AndroidManifest.xml $Path)
        if ($LASTEXITCODE -ne 0) {
            throw "aapt2 无法读取 $Label APK Manifest。"
        }
        return @{
            Badging = $badgingText
            Manifest = ($manifest -join "`n")
        }
    }

    Assert-ApkDexClasses -Label 'Debug' -Path $debugApkPath -RequiredClasses @(
        'com.chishenme.app.ChiShenMeApplication',
        'com.chishenme.app.MainActivity',
        'com.chishenme.app.data.local.DecisionHistoryStore',
        'com.chishenme.app.debug.wxapi.WXEntryActivity'
    )
    Assert-ApkDexClasses -Label 'Fixture' -Path $fixtureApkPath -RequiredClasses @(
        'com.chishenme.app.ChiShenMeApplication',
        'com.chishenme.app.MainActivity',
        'com.chishenme.app.data.local.DecisionHistoryStore',
        'com.chishenme.app.debug.wxapi.WXEntryActivity'
    )
    Assert-ApkDexClasses -Label 'FixtureTest' -Path $testApkPath -RequiredClasses @(
        'androidx.test.runner.AndroidJUnitRunner',
        'com.chishenme.app.MainActivityDecisionFlowTest',
        'com.chishenme.app.MainActivityMinimumVersionGateTest',
        'com.chishenme.app.MainActivityConfigUnavailableTest',
        'com.chishenme.app.MainActivityRuntimeVersionRaiseTest',
        'com.chishenme.app.MainActivityAuthLocalFixtureTest',
        'com.chishenme.app.MainActivityAmapLiveFixtureTest',
        'com.chishenme.app.MainActivitySupportFeedbackLocalFixtureTest',
        'com.chishenme.app.MainActivityGroupDecisionLocalFixtureTest'
    )
    Assert-ApkDexClasses -Label 'Alpha' -Path $alphaApkPath -RequiredClasses @(
        'com.chishenme.app.ChiShenMeApplication',
        'com.chishenme.app.MainActivity',
        'com.chishenme.app.alpha.wxapi.WXEntryActivity',
        'com.tencent.tauth.Tencent',
        'com.tencent.tauth.IUiListener',
        'com.tencent.tauth.AuthActivity',
        'com.tencent.connect.common.AssistActivity',
        'okhttp3.internal.Version'
    )

    $debugManifest = Get-ApkManifestEvidence -Label 'Debug' -Path $debugApkPath `
        -ExpectedPackage 'com.chishenme.app.debug'
    $fixtureManifest = Get-ApkManifestEvidence -Label 'Fixture' -Path $fixtureApkPath `
        -ExpectedPackage 'com.chishenme.app.debug'
    $testManifest = Get-ApkManifestEvidence -Label 'FixtureTest' -Path $testApkPath `
        -ExpectedPackage 'com.chishenme.app.debug.test'
    $alphaManifest = Get-ApkManifestEvidence -Label 'Alpha' -Path $alphaApkPath `
        -ExpectedPackage 'com.chishenme.app.alpha'

    foreach ($appManifest in @(
        @{ Label = 'Debug'; Evidence = $debugManifest; Package = 'com.chishenme.app.debug' },
        @{ Label = 'Fixture'; Evidence = $fixtureManifest; Package = 'com.chishenme.app.debug' },
        @{ Label = 'Alpha'; Evidence = $alphaManifest; Package = 'com.chishenme.app.alpha' }
    )) {
        $label = $appManifest.Label
        $badgingText = $appManifest.Evidence.Badging
        $manifestText = $appManifest.Evidence.Manifest
        $packageName = $appManifest.Package
        foreach ($requiredPattern in @(
            "launchable-activity: name='com\.chishenme\.app\.MainActivity'",
            'android:name\(0x[0-9a-f]+\)="com\.chishenme\.app\.ChiShenMeApplication"',
            'android:allowBackup\(0x[0-9a-f]+\)=false',
            'android:usesCleartextTraffic\(0x[0-9a-f]+\)=false',
            ('android:authorities\(0x[0-9a-f]+\)="' + [regex]::Escape($packageName) + '\.share-file-provider"')
        )) {
            if (($badgingText + "`n" + $manifestText) -notmatch $requiredPattern) {
                throw "$label APK Manifest 缺少安全或启动约束：$requiredPattern"
            }
        }
        if ($manifestText -match 'android\.permission\.QUERY_ALL_PACKAGES') {
            throw "$label APK 意外申请 QUERY_ALL_PACKAGES。"
        }
        if ($manifestText -match 'android\.permission\.READ_PHONE_STATE') {
            throw "$label APK 意外申请 READ_PHONE_STATE。"
        }
        if ($manifestText -match '(?i)com\.alicom\.fusion|AlicomFusion|FusionAuth') {
            throw "$label APK Manifest 仍包含 Fusion 组件。"
        }
    }
    if ($debugManifest.Badging -notmatch '(?m)^application-debuggable$') {
        throw 'Debug APK 未标记为 debuggable。'
    }
    if ($fixtureManifest.Badging -notmatch '(?m)^application-debuggable$') {
        throw 'Fixture APK 未标记为 debuggable。'
    }
    if ($alphaManifest.Badging -match '(?m)^application-debuggable$') {
        throw '内部 Alpha APK 不得标记为 debuggable。'
    }
    function Get-ApkManifestXmlDocument {
        param(
            [string]$Label,
            [string]$Path
        )

        $manifestLines = @(& $apkAnalyzer manifest print $Path)
        if ($LASTEXITCODE -ne 0) {
            throw "apkanalyzer 无法读取 $Label APK Manifest。"
        }
        try {
            [xml]$manifestXml = $manifestLines -join "`n"
            return $manifestXml
        } catch {
            throw "$Label APK Manifest XML 无法解析：$($_.Exception.Message)"
        }
    }

    $debugManifestXml = Get-ApkManifestXmlDocument -Label 'Debug' -Path $debugApkPath
    $fixtureManifestXml = Get-ApkManifestXmlDocument -Label 'Fixture' -Path $fixtureApkPath
    $alphaManifestXml = Get-ApkManifestXmlDocument -Label 'Alpha' -Path $alphaApkPath
    $androidNamespace = 'http://schemas.android.com/apk/res/android'

    function Assert-QqManifestConfiguration {
        param(
            [string]$Label,
            [xml]$ManifestXml,
            [string]$ExpectedPackage,
            [bool]$ExpectedEnabled,
            [string]$ExpectedScheme
        )

        $activities = @($ManifestXml.manifest.application.activity)
        $authActivities = @(
            $activities |
                Where-Object {
                    $_.GetAttribute('name', $androidNamespace) -ceq
                        'com.tencent.tauth.AuthActivity'
                }
        )
        $assistActivities = @(
            $activities |
                Where-Object {
                    $_.GetAttribute('name', $androidNamespace) -ceq
                        'com.tencent.connect.common.AssistActivity'
                }
        )
        if ($authActivities.Count -ne 1 -or $assistActivities.Count -ne 1) {
            throw "$Label APK 必须各包含一个 QQ AuthActivity 和 AssistActivity。"
        }

        $expectedEnabledText = $ExpectedEnabled.ToString().ToLowerInvariant()
        $authActivity = $authActivities[0]
        # `apkanalyzer manifest print` renders enum/style values numerically on
        # current cmdline-tools, while older versions emitted symbolic names.
        # Accept only the exact equivalent encodings so the gate remains strict
        # without depending on one presentation format.
        $authLaunchMode = $authActivity.GetAttribute('launchMode', $androidNamespace)
        $authTheme = $authActivity.GetAttribute('theme', $androidNamespace)
        if ($authActivity.GetAttribute('enabled', $androidNamespace) -cne $expectedEnabledText -or
            $authActivity.GetAttribute('exported', $androidNamespace) -cne 'true' -or
            $authLaunchMode -cnotin @('singleTask', '2') -or
            $authActivity.GetAttribute('noHistory', $androidNamespace) -cne 'true' -or
            $authActivity.GetAttribute('taskAffinity', $androidNamespace) -cne $ExpectedPackage -or
            $authTheme -cnotin @(
                '@android:style/Theme.Translucent.NoTitleBar',
                '@ref/0x1030010'
            )) {
            throw "$Label APK 的 QQ AuthActivity 安全属性无效。"
        }
        $authFilters = @($authActivity.'intent-filter')
        if ($authFilters.Count -ne 1) {
            throw "$Label APK 的 QQ AuthActivity 必须恰好包含一个回调过滤器。"
        }
        $authFilter = $authFilters[0]
        $authActions = @(
            $authFilter.action |
                ForEach-Object { $_.GetAttribute('name', $androidNamespace) }
        )
        $authCategories = @(
            $authFilter.category |
                ForEach-Object { $_.GetAttribute('name', $androidNamespace) } |
                Sort-Object
        )
        $authData = @($authFilter.data)
        if ($authActions.Count -ne 1 -or
            $authActions[0] -cne 'android.intent.action.VIEW' -or
            ($authCategories -join '|') -cne
                'android.intent.category.BROWSABLE|android.intent.category.DEFAULT' -or
            $authData.Count -ne 1 -or
            $authData[0].GetAttribute('scheme', $androidNamespace) -cne $ExpectedScheme -or
            $authData[0].Attributes.Count -ne 1) {
            throw "$Label APK 的 QQ callback scheme 或 Intent Filter 无效。"
        }

        $assistActivity = $assistActivities[0]
        $assistConfigChanges = @(
            $assistActivity.GetAttribute('configChanges', $androidNamespace).Split('|') |
                Sort-Object
        ) -join '|'
        $assistScreenOrientation =
            $assistActivity.GetAttribute('screenOrientation', $androidNamespace)
        $assistTheme = $assistActivity.GetAttribute('theme', $androidNamespace)
        if ($assistActivity.GetAttribute('enabled', $androidNamespace) -cne $expectedEnabledText -or
            $assistActivity.GetAttribute('exported', $androidNamespace) -cne 'false' -or
            $assistActivity.GetAttribute('taskAffinity', $androidNamespace) -cne $ExpectedPackage -or
            $assistScreenOrientation -cnotin @('behind', '3') -or
            $assistTheme -cnotin @(
                '@android:style/Theme.Translucent.NoTitleBar',
                '@ref/0x1030010'
            ) -or
            $assistConfigChanges -cnotin @(
                'keyboardHidden|orientation|screenSize',
                '0x4a0'
            )) {
            throw "$Label APK 的 QQ AssistActivity 安全属性无效。"
        }

        $visibleTencentPackages = @(
            $ManifestXml.manifest.queries.package |
                ForEach-Object { $_.GetAttribute('name', $androidNamespace) } |
                Where-Object { $_ -match '^com\.tencent\.' } |
                Sort-Object
        )
        if (($visibleTencentPackages -join '|') -cne
            'com.tencent.mm|com.tencent.mobileqq|com.tencent.tim') {
            throw "$Label APK 的腾讯包可见性必须精确限定为微信、QQ 与 TIM。"
        }
    }

    Assert-QqManifestConfiguration -Label 'Debug' -ManifestXml $debugManifestXml `
        -ExpectedPackage 'com.chishenme.app.debug' -ExpectedEnabled $false `
        -ExpectedScheme 'tencent-disabled'
    Assert-QqManifestConfiguration -Label 'Fixture' -ManifestXml $fixtureManifestXml `
        -ExpectedPackage 'com.chishenme.app.debug' -ExpectedEnabled $false `
        -ExpectedScheme 'tencent-disabled'
    Assert-QqManifestConfiguration -Label 'Alpha' -ManifestXml $alphaManifestXml `
        -ExpectedPackage 'com.chishenme.app.alpha' -ExpectedEnabled $true `
        -ExpectedScheme "tencent$AlphaQqAppId"
    if (($alphaManifestXml.OuterXml) -match 'tencent-disabled') {
        throw 'Alpha APK Manifest 不得残留禁用态 QQ callback scheme。'
    }

    $alphaWechatActivities = @(
        $alphaManifestXml.manifest.application.activity |
            Where-Object {
                $_.GetAttribute('name', $androidNamespace) -ceq
                    'com.chishenme.app.alpha.wxapi.WXEntryActivity'
            }
    )
    if ($alphaWechatActivities.Count -ne 1) {
        throw "Alpha APK 必须恰好包含一个微信回调 Activity，实际为 $($alphaWechatActivities.Count)。"
    }
    $alphaWechatActivity = $alphaWechatActivities[0]
    if ($alphaWechatActivity.GetAttribute('enabled', $androidNamespace) -cne 'true' -or
        $alphaWechatActivity.GetAttribute('exported', $androidNamespace) -cne 'true') {
        throw 'Alpha APK 的微信回调 Activity 必须同时启用并导出。'
    }
    $testManifestLines = @(& $apkAnalyzer manifest print $testApkPath)
    if ($LASTEXITCODE -ne 0) {
        throw 'apkanalyzer 无法读取 Test APK Manifest。'
    }
    try {
        [xml]$testManifestXml = $testManifestLines -join "`n"
    } catch {
        throw "Test APK Manifest XML 无法解析：$($_.Exception.Message)"
    }
    $instrumentations = @($testManifestXml.manifest.instrumentation)
    if ($instrumentations.Count -ne 1) {
        throw "Test APK 必须恰好包含一个 instrumentation，实际为 $($instrumentations.Count)。"
    }
    $instrumentation = $instrumentations[0]
    $runner = $instrumentation.GetAttribute('name', $androidNamespace)
    $targetPackage = $instrumentation.GetAttribute('targetPackage', $androidNamespace)
    if ($runner -cne 'androidx.test.runner.AndroidJUnitRunner' -or
        $targetPackage -cne 'com.chishenme.app.debug') {
        throw "Test APK instrumentation 无效：runner=$runner，target=$targetPackage"
    }

    Write-Host '== Android: minified internal Alpha integrity =='
    $alphaDexFiles = @(& $apkAnalyzer dex list $alphaApkPath)
    if ($LASTEXITCODE -ne 0 -or $alphaDexFiles.Count -lt 1 -or $alphaDexFiles.Count -gt 4) {
        throw "内部 Alpha APK 的 DEX 性能预算异常：$($alphaDexFiles.Count)"
    }

    $certificateMd5Digests = @{}
    $certificateSha256Digests = @{}
    foreach ($label in $apkPaths.Keys) {
        $path = $apkPaths[$label]
        $signature = @(& $apkSigner verify --verbose --print-certs $path 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "$label APK 签名校验失败。"
        }
        if (-not ($signature | Select-String -Pattern '^Verified using v2 scheme .*: true$' -Quiet)) {
            throw "$label APK 未通过 v2 签名校验。"
        }
        if (-not ($signature | Select-String -Pattern '^Number of signers: 1$' -Quiet)) {
            throw "$label APK 必须恰好有一个 signer。"
        }
        $certificateMd5Lines = @(
            $signature |
                Select-String -Pattern '^Signer #1 certificate MD5 digest: ([0-9a-fA-F]{32})$'
        )
        if ($certificateMd5Lines.Count -ne 1) {
            throw "$label APK 的 signer MD5 证书摘要数量异常：$($certificateMd5Lines.Count)"
        }
        $certificateMd5Digests[$label] =
            $certificateMd5Lines[0].Matches[0].Groups[1].Value.ToLowerInvariant()

        $certificateSha256Lines = @(
            $signature |
                Select-String -Pattern '^Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})$'
        )
        if ($certificateSha256Lines.Count -ne 1) {
            throw "$label APK 的 signer SHA-256 证书摘要数量异常：$($certificateSha256Lines.Count)"
        }
        $certificateSha256Digests[$label] =
            $certificateSha256Lines[0].Matches[0].Groups[1].Value.ToLowerInvariant()

        & $zipAlign -c -P 16 4 $path
        if ($LASTEXITCODE -ne 0) {
            throw "$label APK 未通过 16 KB zipalign 校验。"
        }
    }
    $debugFamilySha256 = @(
        'Debug', 'Fixture', 'FixtureTest' |
            ForEach-Object { $certificateSha256Digests[$_] } |
            Select-Object -Unique
    )
    if ($debugFamilySha256.Count -ne 1) {
        throw 'Debug、Fixture 与 FixtureTest APK 必须保持同一测试签名证书。'
    }
    if ($certificateSha256Digests.Alpha -eq $debugFamilySha256[0]) {
        throw 'Alpha APK 不得继续回退到 Debug signer。'
    }
    if ($certificateMd5Digests.Alpha -ne $expectedAlphaCertificateMd5 -or
        $certificateSha256Digests.Alpha -ne $expectedAlphaCertificateSha256) {
        throw 'Alpha APK signer 与仓库固定的长期 Alpha 证书不一致。'
    }

    Write-Host "Alpha 阿里云包签名 MD5：$($certificateMd5Digests.Alpha)"
    Write-Host "Alpha signer SHA-256：$($certificateSha256Digests.Alpha)"

    foreach ($label in $apkPaths.Keys) {
        $artifact = Get-Item -LiteralPath $apkPaths[$label]
        $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash
        Write-Host "$label APK：$($artifact.Length) bytes；SHA-256 $hash"
    }
} finally {
    if ($mappedDriveCreated) {
        & subst $mappedDrive /d
    }
    if ($androidBuildLockAcquired) {
        $androidBuildMutex.ReleaseMutex()
    }
    $androidBuildMutex.Dispose()
    $env:JAVA_HOME = $previousJavaHome
    $env:ANDROID_HOME = $previousAndroidHome
    $env:ANDROID_SDK_ROOT = $previousAndroidSdkRoot
    $env:PATH = $previousPath
}

Write-Host '全部验证通过。'
