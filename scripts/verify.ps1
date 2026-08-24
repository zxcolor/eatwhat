param(
    [string]$AlphaApiBaseUrl = $env:CHISHENME_ALPHA_API_BASE_URL
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

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $workspaceRoot

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
} finally {
    $env:CHISHENME_PARENT_SECRET_DECOY = $previousDecoySecret
    $env:AMAP_WEB_SERVICE_KEY = $previousExternalAmapKey
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
                '.kt', '.kts', '.properties', '.ps1', '.cmd', '.bat', '.txt'
            ) -or $_.Name -in @('.env.example', '.env.local.example'))
        }
)
$highConfidenceCredentialLeak = @(
    $credentialTextFiles |
        Select-String -Pattern @(
            '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            '\bLTAI[A-Za-z0-9]{16,32}\b',
            '(?:AMAP_WEB_SERVICE_KEY|AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY|WECHAT_APP_SECRET)\s*[:=]\s*["'']?[0-9a-fA-F]{32}["'']?'
        )
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
            'SMTP_PASSWORD',
            'ALIBABA_CLOUD_ACCESS_KEY_ID',
            'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
            'AUTH_HASH_KEYS_JSON',
            'AUTH_OTP_PEPPER_KEYS_JSON'
        )
)
if ($androidForbiddenSecretIdentifier.Count -gt 0) {
    throw "Android 源码引用了服务端密钥：$($androidForbiddenSecretIdentifier[0].Path):$($androidForbiddenSecretIdentifier[0].LineNumber)"
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
        if (Get-PSDrive -Name $availableDrive -ErrorAction SilentlyContinue) {
            throw '固定 Android 构建盘符 W: 已被占用；为避免混合 DEX，本次验证已安全停止。'
        }

        $mappedDrive = "${availableDrive}:"
        & subst $mappedDrive $workspaceRoot
        $mappedDriveCreated = $LASTEXITCODE -eq 0
        if (-not $mappedDriveCreated -or -not (Test-Path "$mappedDrive\apps\android")) {
            throw '创建 Android 临时 ASCII 盘符失败。'
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

    function Assert-ApkHasNoServerSecrets {
        param(
            [string]$Label,
            [string]$Path,
            [string]$ExpectedApiBaseUrl = '',
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
                $dexEntries = @(
                    $archive.Entries |
                        Where-Object { $_.FullName -match '^classes(?:[2-9][0-9]*)?\.dex$' }
                )
                if ($dexEntries.Count -lt 1) {
                    throw "$Label APK 不包含可扫描的 DEX。"
                }
                $expectedEndpointObserved = [string]::IsNullOrEmpty($ExpectedApiBaseUrl)
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
                    foreach ($forbiddenApiBaseUrl in $ForbiddenApiBaseUrls) {
                        if ($dexDumpOutput |
                            Select-String -SimpleMatch $forbiddenApiBaseUrl -Quiet) {
                            throw "$Label APK 的 DEX 包含其他变体的 API 地址：$forbiddenApiBaseUrl"
                        }
                    }
                    $forbidden = @(
                        $dexDumpOutput | Select-String -Pattern @(
                                'AMAP_WEB_SERVICE_KEY',
                                'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY',
                                'WECHAT_APP_SECRET',
                                'SMTP_PASSWORD',
                                'ALIBABA_CLOUD_ACCESS_KEY_ID',
                                'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
                                'AUTH_HASH_KEYS_JSON',
                                'AUTH_OTP_PEPPER_KEYS_JSON',
                                '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                                '\bLTAI[A-Za-z0-9]{16,32}\b'
                            )
                    )
                    if ($forbidden.Count -gt 0) {
                        throw "$Label APK 包含服务端密钥标识或疑似凭据。"
                    }
                }
                if (-not $expectedEndpointObserved) {
                    throw "$Label APK 的 DEX 未包含预期 API 地址：$ExpectedApiBaseUrl"
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
        -ForbiddenApiBaseUrls @('http://127.0.0.1:3001/')
    Assert-ApkHasNoServerSecrets -Label 'Fixture' -Path $fixtureApkPath `
        -ExpectedApiBaseUrl 'http://127.0.0.1:3001/' `
        -ForbiddenApiBaseUrls @($AlphaApiBaseUrl)
    Assert-ApkHasNoServerSecrets -Label 'FixtureTest' -Path $testApkPath
    Assert-ApkHasNoServerSecrets -Label 'Alpha' -Path $alphaApkPath `
        -ExpectedApiBaseUrl $AlphaApiBaseUrl `
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
        'com.chishenme.app.MainActivityAmapLiveFixtureTest'
    )
    Assert-ApkDexClasses -Label 'Alpha' -Path $alphaApkPath -RequiredClasses @(
        'com.chishenme.app.ChiShenMeApplication',
        'com.chishenme.app.MainActivity',
        'com.chishenme.app.alpha.wxapi.WXEntryActivity'
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
    $testManifestLines = @(& $apkAnalyzer manifest print $testApkPath)
    if ($LASTEXITCODE -ne 0) {
        throw 'apkanalyzer 无法读取 Test APK Manifest。'
    }
    try {
        [xml]$testManifestXml = $testManifestLines -join "`n"
    } catch {
        throw "Test APK Manifest XML 无法解析：$($_.Exception.Message)"
    }
    $androidNamespace = 'http://schemas.android.com/apk/res/android'
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

    $certificateDigests = @{}
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
        $certificateLines = @(
            $signature |
                Select-String -Pattern '^Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})$'
        )
        if ($certificateLines.Count -ne 1) {
            throw "$label APK 的 signer 证书摘要数量异常：$($certificateLines.Count)"
        }
        $certificateDigests[$label] =
            $certificateLines[0].Matches[0].Groups[1].Value.ToLowerInvariant()

        & $zipAlign -c -P 16 4 $path
        if ($LASTEXITCODE -ne 0) {
            throw "$label APK 未通过 16 KB zipalign 校验。"
        }
    }
    if (@($certificateDigests.Values | Select-Object -Unique).Count -ne 1) {
        throw 'Debug、Fixture、FixtureTest、Alpha APK 的签名证书不一致。'
    }

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
