<#
.SYNOPSIS
在唯一一台 Android 调试设备上严格执行指定的 instrumentation 测试类。

.DESCRIPTION
脚本验证本机 API、ADB 反向映射、已安装的 Debug App/Test 包和设备实际登记的
instrumentation component，再执行指定测试类。成功条件不是固定测试总数，而是唯一的
非零 OK 结果、runner 成功终态且不存在失败或跳过标记。

脚本不会启动、停止或重配 API，也不会默认安装 APK。只有显式传入 -Install 才会把当前
统一构建产物安装到所选设备。

.PARAMETER ClassName
要执行的完整测试类名，例如 com.chishenme.app.MainActivityDecisionFlowTest。

.PARAMETER InstrumentationArguments
可选的 instrumentation -e 参数表。最低版本门禁用例需要
@{ minimumVersionGate = 'true' }。

.PARAMETER ExpectedMinimumSupportedVersion
可选的服务端最低版本精确值。提供后，测试前会读取 /v1/config 并严格比对。

.PARAMETER UseDeviceLocalApiFixture
仅供精确登记的设备内 API 专用用例使用。脚本会在运行前暂时移除设备的 tcp:3001
反向映射，让测试进程在设备回环地址启动隔离夹具；无论测试成功或失败，都会停止测试
App 并恢复原映射。

.PARAMETER Install
先安装当前 Debug App APK 和 Debug AndroidTest APK。不会构建 APK。

.PARAMETER AdbPath
可选的 adb.exe 完整路径。未提供时依次查找 PATH、Android 环境变量、仓库工具目录和
当前用户默认 Android SDK。

.PARAMETER Serial
可选的设备序列号。未提供时必须恰好有一台状态为 device 的设备。

.PARAMETER ShowFullSerial
显式允许在终端显示完整设备序列号。默认只显示掩码后的末四位。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z_$][A-Za-z0-9_.$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$')]
    [string]$ClassName,
    [hashtable]$InstrumentationArguments = @{},
    [ValidatePattern('^[0-9]+(?:\.[0-9]+)*$')]
    [string]$ExpectedMinimumSupportedVersion,
    [switch]$UseDeviceLocalApiFixture,
    [switch]$Install,
    [string]$AdbPath,
    [string]$Serial,
    [switch]$ShowFullSerial
)

Set-StrictMode -Version Latest
$previousErrorActionPreference = $ErrorActionPreference
$previousPath = $env:PATH
$previousAndroidHome = $env:ANDROID_HOME
$previousAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidProject = Join-Path $workspaceRoot 'apps\android'
$debugApplicationId = 'com.chishenme.app.debug'
$debugTestApplicationId = 'com.chishenme.app.debug.test'
$apiBaseUrl = 'http://127.0.0.1:3001'
$script:ResolvedAdbPath = $null
$selectedSerial = $null
$deviceLocalReverseRemoved = $false
$reverseRestoreTarget = $null
$reverseMutex = $null
$reverseMutexAcquired = $false
$scriptFailure = $null
$restoreFailure = $null
$cleanupFailureMessages = [System.Collections.Generic.List[string]]::new()

function Resolve-AdbExecutable {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        $item = Get-Item -LiteralPath $RequestedPath -ErrorAction SilentlyContinue
        if (-not $item -or $item.PSIsContainer) {
            throw "指定的 ADB 不存在或不是文件：$RequestedPath"
        }
        return $item.FullName
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    $pathCommand = Get-Command 'adb.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($pathCommand) {
        $candidates.Add($pathCommand.Source)
    }
    foreach ($sdkRoot in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)) {
        if (-not [string]::IsNullOrWhiteSpace($sdkRoot)) {
            $candidates.Add((Join-Path $sdkRoot 'platform-tools\adb.exe'))
        }
    }
    $candidates.Add((Join-Path $workspaceRoot '.tools\android-sdk\platform-tools\adb.exe'))
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'))
    }

    $resolved = $candidates |
        Select-Object -Unique |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $resolved) {
        throw '未找到 adb.exe。请安装 Android SDK Platform-Tools，或使用 -AdbPath 指定 adb.exe。'
    }
    return (Resolve-Path -LiteralPath $resolved).Path
}

function Format-DeviceSerial {
    param([string]$DeviceSerial)

    if ($ShowFullSerial -or [string]::IsNullOrEmpty($DeviceSerial)) {
        return $DeviceSerial
    }
    if ($DeviceSerial.Length -le 6) {
        return '*' * $DeviceSerial.Length
    }
    return ('*' * ($DeviceSerial.Length - 4)) + $DeviceSerial.Substring($DeviceSerial.Length - 4)
}

function Invoke-AdbCommand {
    param(
        [string[]]$CommandArguments,
        [switch]$AllowFailure
    )

    # Windows PowerShell 5.1 converts native stderr into non-terminating
    # NativeCommandError records. With the script-wide Stop preference that
    # would throw before we can read LASTEXITCODE or intentionally parse a
    # failed instrumentation run, so capture native output under Continue and
    # restore the caller preference before applying our own strict policy.
    $functionErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $script:ResolvedAdbPath @CommandArguments 2>&1 |
            ForEach-Object { $_.ToString() })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $functionErrorActionPreference
    }
    if (-not $AllowFailure -and $exitCode -ne 0) {
        $details = ($output -join [Environment]::NewLine).Trim()
        for ($index = 0; $index -lt ($CommandArguments.Count - 1); $index += 1) {
            if ($CommandArguments[$index] -eq '-s') {
                $commandSerial = $CommandArguments[$index + 1]
                $details = $details.Replace(
                    $commandSerial,
                    (Format-DeviceSerial -DeviceSerial $commandSerial)
                )
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = 'ADB 未返回错误详情。'
        }
        throw "ADB 命令失败（退出码 $exitCode）：$details"
    }
    return [PSCustomObject]@{
        ExitCode = $exitCode
        Output = $output
    }
}

function Select-ReadyDevice {
    param([string]$RequestedSerial)

    if (-not [string]::IsNullOrWhiteSpace($RequestedSerial) -and
        $RequestedSerial -notmatch '^[^\s\x00-\x1F\x7F]+$') {
        throw '设备序列号不能包含空白符或控制字符。'
    }

    $deviceResult = Invoke-AdbCommand -CommandArguments @('devices', '-l')
    $devices = @($deviceResult.Output | ForEach-Object {
        if ($_ -match '^(\S+)\s+(\S+)(?:\s|$)' -and $Matches[1] -ne 'List') {
            [PSCustomObject]@{ Serial = $Matches[1]; State = $Matches[2] }
        }
    })

    if (-not [string]::IsNullOrWhiteSpace($RequestedSerial)) {
        $selected = $devices | Where-Object { $_.Serial -eq $RequestedSerial } | Select-Object -First 1
        if (-not $selected) {
            throw "未发现设备：$(Format-DeviceSerial -DeviceSerial $RequestedSerial)"
        }
        if ($selected.State -ne 'device') {
            throw "设备 $(Format-DeviceSerial -DeviceSerial $RequestedSerial) 状态为 $($selected.State)，不是 device。"
        }
        return $selected.Serial
    }

    $ready = @($devices | Where-Object { $_.State -eq 'device' })
    if ($ready.Count -eq 0) {
        throw '没有状态为 device 的 Android 调试设备。'
    }
    if ($ready.Count -ne 1) {
        $display = ($ready | ForEach-Object {
            Format-DeviceSerial -DeviceSerial $_.Serial
        }) -join '，'
        throw "检测到多台可用设备：$display。请使用 -Serial 明确选择。"
    }
    return $ready[0].Serial
}

function Assert-InstalledPackage {
    param(
        [string]$DeviceSerial,
        [string]$PackageName
    )

    $result = Invoke-AdbCommand -CommandArguments @(
        '-s', $DeviceSerial, 'shell', 'pm', 'path', $PackageName
    )
    if (-not (($result.Output -join [Environment]::NewLine) -match '(?m)^package:')) {
        throw "设备未安装 $PackageName。可先使用 -Install 安装当前构建产物。"
    }
}

function Get-Tcp3001ReverseSnapshot {
    param([string[]]$OutputLines)

    $targets = @()
    $unrecognizedLines = @()
    foreach ($line in $OutputLines) {
        $trimmedLine = ([string]$line).Trim()
        if ($trimmedLine -notmatch '(?:^|\s)tcp:3001(?:\s|$)') {
            continue
        }
        if ($trimmedLine -match '^(?:\S+\s+)?tcp:3001\s+(tcp:[1-9][0-9]{0,4})$') {
            $targets += $Matches[1]
        } else {
            $unrecognizedLines += $trimmedLine
        }
    }

    return [PSCustomObject]@{
        Targets = [string[]]$targets
        UnrecognizedLines = [string[]]$unrecognizedLines
    }
}

function Assert-ExactTcp3001ReverseTarget {
    param(
        [object]$Snapshot,
        [string]$ExpectedTarget,
        [string]$Context
    )

    if ($Snapshot.UnrecognizedLines.Count -gt 0) {
        throw "$Context 检测到无法安全解析的 tcp:3001 映射；脚本拒绝继续。"
    }
    if ($Snapshot.Targets.Count -ne 1 -or
        $Snapshot.Targets[0] -cne $ExpectedTarget) {
        $actualTargets = if ($Snapshot.Targets.Count -eq 0) {
            '不存在'
        } else {
            $Snapshot.Targets -join '，'
        }
        throw "$Context 的 tcp:3001 映射为 $actualTargets，预期唯一映射到 $ExpectedTarget；脚本拒绝继续。"
    }
}

try {
    $script:ResolvedAdbPath = Resolve-AdbExecutable -RequestedPath $AdbPath
    $selectedSerial = Select-ReadyDevice -RequestedSerial $Serial
    Write-Host "ADB：$script:ResolvedAdbPath"
    Write-Host "设备：$(Format-DeviceSerial -DeviceSerial $selectedSerial)"

    $configUnavailableClass = 'com.chishenme.app.MainActivityConfigUnavailableTest'
    $runtimeVersionRaiseClass = 'com.chishenme.app.MainActivityRuntimeVersionRaiseTest'
    $authLocalFixtureClass = 'com.chishenme.app.MainActivityAuthLocalFixtureTest'
    $amapLiveFixtureClass = 'com.chishenme.app.MainActivityAmapLiveFixtureTest'
    $minimumVersionClass = 'com.chishenme.app.MainActivityMinimumVersionGateTest'
    foreach ($key in $InstrumentationArguments.Keys) {
        $keyText = [string]$key
        $valueText = [string]$InstrumentationArguments[$key]
        $minimumVersionArgumentAllowed = $ClassName -ceq $minimumVersionClass -and
            $keyText -ceq 'minimumVersionGate' -and $valueText -ceq 'true'
        $configUnavailableArgumentAllowed = $ClassName -ceq $configUnavailableClass -and
            $keyText -ceq 'configUnavailable' -and $valueText -ceq 'true'
        $runtimeVersionRaiseArgumentAllowed = $ClassName -ceq $runtimeVersionRaiseClass -and
            $keyText -ceq 'runtimeVersionRaise' -and $valueText -ceq 'true'
        $authLocalFixtureArgumentAllowed = $ClassName -ceq $authLocalFixtureClass -and
            $keyText -ceq 'authLocalFixture' -and $valueText -ceq 'true'
        $amapLiveFixtureArgumentAllowed = $ClassName -ceq $amapLiveFixtureClass -and
            $keyText -ceq 'amapLiveFixture' -and $valueText -ceq 'true'
        if (-not $minimumVersionArgumentAllowed -and
            -not $configUnavailableArgumentAllowed -and
            -not $runtimeVersionRaiseArgumentAllowed -and
            -not $authLocalFixtureArgumentAllowed -and
            -not $amapLiveFixtureArgumentAllowed) {
            throw '只允许与专用测试类精确匹配的 minimumVersionGate=true、configUnavailable=true、runtimeVersionRaise=true、authLocalFixture=true 或 amapLiveFixture=true；任意 shell 值均被拒绝。'
        }
    }
    if ($UseDeviceLocalApiFixture) {
        $configUnavailableFixtureAllowed = $ClassName -ceq $configUnavailableClass -and
            $InstrumentationArguments.Count -eq 1 -and
            [string]$InstrumentationArguments['configUnavailable'] -ceq 'true'
        $runtimeVersionRaiseFixtureAllowed = $ClassName -ceq $runtimeVersionRaiseClass -and
            $InstrumentationArguments.Count -eq 1 -and
            [string]$InstrumentationArguments['runtimeVersionRaise'] -ceq 'true'
        $authLocalFixtureAllowed = $ClassName -ceq $authLocalFixtureClass -and
            $InstrumentationArguments.Count -eq 1 -and
            [string]$InstrumentationArguments['authLocalFixture'] -ceq 'true'
        $amapLiveFixtureAllowed = $ClassName -ceq $amapLiveFixtureClass -and
            $InstrumentationArguments.Count -eq 1 -and
            [string]$InstrumentationArguments['amapLiveFixture'] -ceq 'true'
        if (-not $configUnavailableFixtureAllowed -and
            -not $runtimeVersionRaiseFixtureAllowed -and
            -not $authLocalFixtureAllowed -and
            -not $amapLiveFixtureAllowed) {
            throw '-UseDeviceLocalApiFixture 只允许与已登记测试类及其唯一 true 参数精确配套使用。'
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedMinimumSupportedVersion)) {
            throw '设备内隔离夹具模式不允许声明主服务端最低版本。'
        }
        Write-Host "API：将使用 $ClassName 的设备内隔离夹具，不读取或重配主服务端"
    } else {
        if ($InstrumentationArguments.ContainsKey('configUnavailable') -or
            $InstrumentationArguments.ContainsKey('runtimeVersionRaise') -or
            $InstrumentationArguments.ContainsKey('authLocalFixture') -or
            $InstrumentationArguments.ContainsKey('amapLiveFixture')) {
            throw '设备内 API 专用参数必须同时使用 -UseDeviceLocalApiFixture，以免与 ADB 反向映射争用端口。'
        }
        try {
            $health = Invoke-RestMethod -Method Get -Uri "$apiBaseUrl/health" -TimeoutSec 5
            $config = Invoke-RestMethod -Method Get -Uri "$apiBaseUrl/v1/config" -TimeoutSec 5
        } catch {
            throw "本机 API 验证失败；脚本不会启动或重配后端。原始错误：$($_.Exception.Message)"
        }
        if ($null -eq $health -or $health.status -ne 'ok') {
            throw '本机 API /health 未返回 status=ok。'
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedMinimumSupportedVersion) -and
            $config.minimumSupportedVersion -ne $ExpectedMinimumSupportedVersion) {
            throw "服务端最低版本为 $($config.minimumSupportedVersion)，预期为 $ExpectedMinimumSupportedVersion。"
        }
        Write-Host "本机 API：健康，最低版本 $($config.minimumSupportedVersion)"
    }

    $mutexKeyBytes = [System.Text.Encoding]::UTF8.GetBytes(
        "$selectedSerial`ntcp:3001"
    )
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $mutexKey = ([System.BitConverter]::ToString(
            $sha256.ComputeHash($mutexKeyBytes)
        )).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
    $reverseMutexName = "Local\ChiShenMeAndroidReverse_$mutexKey"
    $reverseMutex = [System.Threading.Mutex]::new($false, $reverseMutexName)
    try {
        $reverseMutexAcquired = $reverseMutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        # WaitOne throws only after granting ownership when the previous owner
        # exited without releasing the mutex. Treat that state as acquired and
        # revalidate the live mapping below before doing anything destructive.
        $reverseMutexAcquired = $true
        Write-Warning '检测到上一次设备端口操作异常退出；已接管互斥锁并将重新核验实时映射。'
    }
    if (-not $reverseMutexAcquired) {
        throw '另一测试进程正在使用所选设备的 tcp:3001 反向映射；本次未修改设备，请稍后重试。'
    }

    $reverseResult = Invoke-AdbCommand -CommandArguments @(
        '-s', $selectedSerial, 'reverse', '--list'
    )
    $reverseSnapshot = Get-Tcp3001ReverseSnapshot -OutputLines $reverseResult.Output
    if ($reverseSnapshot.UnrecognizedLines.Count -gt 0 -or
        $reverseSnapshot.Targets.Count -ne 1) {
        throw '设备缺少唯一、可恢复的 tcp:3001 ADB 反向映射。请先运行 connect-android-debug.ps1。'
    }
    $reverseRestoreTarget = $reverseSnapshot.Targets[0]
    if (-not $UseDeviceLocalApiFixture -and $reverseRestoreTarget -cne 'tcp:3001') {
        throw "设备 tcp:3001 当前映射到 $reverseRestoreTarget；脚本不会静默覆盖不同目标。"
    }

    if ($Install) {
        $appApk = Join-Path $androidProject 'app\build\outputs\apk\debug\app-debug.apk'
        $testApk = Join-Path $androidProject 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
        foreach ($apk in @($appApk, $testApk)) {
            if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) {
                throw "缺少构建产物：$apk。请先运行 scripts\verify.ps1。"
            }
            Invoke-AdbCommand -CommandArguments @(
                '-s', $selectedSerial, 'install', '-r', '-t', $apk
            ) | Out-Null
        }
        Write-Host 'APK：Debug App/Test 当前构建产物已安装'
    }

    Assert-InstalledPackage -DeviceSerial $selectedSerial -PackageName $debugApplicationId
    Assert-InstalledPackage -DeviceSerial $selectedSerial -PackageName $debugTestApplicationId

    $instrumentationResult = Invoke-AdbCommand -CommandArguments @(
        '-s', $selectedSerial, 'shell', 'pm', 'list', 'instrumentation'
    )
    $expectedComponent = "$debugTestApplicationId/androidx.test.runner.AndroidJUnitRunner"
    $expectedInstrumentationLine =
        "instrumentation:$expectedComponent (target=$debugApplicationId)"
    $matchingLines = @($instrumentationResult.Output | Where-Object {
        $_.Trim() -eq $expectedInstrumentationLine
    })
    if ($matchingLines.Count -ne 1) {
        $targetingLines = @($instrumentationResult.Output | Where-Object {
            $_ -match ('\(target=' + [regex]::Escape($debugApplicationId) + '\)$')
        })
        throw "未找到当前 Test 包登记的唯一官方 runner；目标设备记录：$($targetingLines -join '，')"
    }
    $component = $expectedComponent

    $runnerArgs = @(
        '-s', $selectedSerial, 'shell', 'am', 'instrument', '-w', '-r',
        '-e', 'class', $ClassName
    )
    foreach ($key in @($InstrumentationArguments.Keys | Sort-Object)) {
        $runnerArgs += @('-e', [string]$key, [string]$InstrumentationArguments[$key])
    }
    $runnerArgs += $component

    if ($UseDeviceLocalApiFixture) {
        $preRemovalReverse = Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'reverse', '--list'
        )
        $preRemovalSnapshot = Get-Tcp3001ReverseSnapshot -OutputLines $preRemovalReverse.Output
        Assert-ExactTcp3001ReverseTarget `
            -Snapshot $preRemovalSnapshot `
            -ExpectedTarget $reverseRestoreTarget `
            -Context '移除前复核'
        Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'reverse', '--remove', 'tcp:3001'
        ) | Out-Null
        $deviceLocalReverseRemoved = $true
        Write-Host "ADB：已暂移 tcp:3001 -> $reverseRestoreTarget，测试结束后自动恢复"
    }

    Write-Host "测试类：$ClassName"
    $testResult = Invoke-AdbCommand -CommandArguments $runnerArgs -AllowFailure
    $testResult.Output | ForEach-Object { Write-Host $_ }
    $successLines = @($testResult.Output | Where-Object {
        $_.Trim() -match '^OK \([1-9][0-9]* tests?\)$'
    })
    $failureLines = @($testResult.Output | Where-Object {
        $_ -match 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED|shortMsg=|Process crashed|INSTRUMENTATION_STATUS_CODE: -[0-9]+'
    })
    $hasRunnerSuccess = @($testResult.Output | Where-Object {
        $_.Trim() -eq 'INSTRUMENTATION_CODE: -1'
    }).Count -eq 1
    $okCount = if ($successLines.Count -eq 1) {
        [int][regex]::Match($successLines[0], '\(([0-9]+) tests?\)').Groups[1].Value
    } else {
        0
    }

    # Parse AndroidJUnitRunner status packets instead of trusting the final OK
    # line alone. Every advertised test must emit one start packet (1) and one
    # successful terminal packet (0), with an identical class/name/index.
    $statusPackets = [System.Collections.Generic.List[object]]::new()
    $packetFields = @{}
    foreach ($line in $testResult.Output) {
        if ($line -match '^INSTRUMENTATION_STATUS: ([A-Za-z]+)=(.*)$') {
            $packetFields[$Matches[1]] = $Matches[2]
            continue
        }
        if ($line -match '^INSTRUMENTATION_STATUS_CODE: (-?[0-9]+)$') {
            $statusPackets.Add([PSCustomObject]@{
                Code = [int]$Matches[1]
                TestClass = $packetFields['class']
                Current = $packetFields['current']
                NumTests = $packetFields['numtests']
                TestName = $packetFields['test']
            })
            $packetFields = @{}
        }
    }

    $lifecycleValid = $okCount -gt 0 -and $statusPackets.Count -eq (2 * $okCount)
    if ($lifecycleValid) {
        foreach ($packet in $statusPackets) {
            if ($packet.TestClass -cne $ClassName -or
                $packet.Current -notmatch '^[1-9][0-9]*$' -or
                [int]$packet.Current -gt $okCount -or
                $packet.NumTests -ne [string]$okCount -or
                [string]::IsNullOrWhiteSpace([string]$packet.TestName) -or
                $packet.Code -notin @(0, 1)) {
                $lifecycleValid = $false
                break
            }
        }
    }
    if ($lifecycleValid) {
        for ($current = 1; $current -le $okCount; $current += 1) {
            $testPackets = @($statusPackets | Where-Object {
                [int]$_.Current -eq $current
            })
            $startPackets = @($testPackets | Where-Object { $_.Code -eq 1 })
            $completePackets = @($testPackets | Where-Object { $_.Code -eq 0 })
            if ($testPackets.Count -ne 2 -or
                $startPackets.Count -ne 1 -or
                $completePackets.Count -ne 1 -or
                $startPackets[0].TestName -cne $completePackets[0].TestName) {
                $lifecycleValid = $false
                break
            }
        }
    }

    if ($testResult.ExitCode -ne 0 -or
        $successLines.Count -ne 1 -or
        $failureLines.Count -gt 0 -or
        -not $hasRunnerSuccess -or
        -not $lifecycleValid) {
        throw "设备 instrumentation 未通过严格验收：$ClassName"
    }

    Write-Host "设备 instrumentation：通过（$okCount 个用例）"
} catch {
    $scriptFailure = $_
} finally {
    if ($deviceLocalReverseRemoved -and
        -not [string]::IsNullOrWhiteSpace($selectedSerial) -and
        -not [string]::IsNullOrWhiteSpace($reverseRestoreTarget)) {
        try {
            Invoke-AdbCommand -CommandArguments @(
                '-s', $selectedSerial, 'shell', 'am', 'force-stop', $debugApplicationId
            ) | Out-Null
        } catch {
            $cleanupFailureMessages.Add(
                "停止测试 App 失败：$($_.Exception.Message)"
            )
        }

        try {
            $currentReverse = Invoke-AdbCommand -CommandArguments @(
                '-s', $selectedSerial, 'reverse', '--list'
            )
            $currentSnapshot = Get-Tcp3001ReverseSnapshot -OutputLines $currentReverse.Output
            if ($currentSnapshot.UnrecognizedLines.Count -gt 0) {
                throw '恢复前检测到无法安全解析的 tcp:3001 映射；拒绝覆盖。'
            }

            if ($currentSnapshot.Targets.Count -eq 0) {
                Invoke-AdbCommand -CommandArguments @(
                    '-s', $selectedSerial, 'reverse', 'tcp:3001', $reverseRestoreTarget
                ) | Out-Null
                $restoredReverse = Invoke-AdbCommand -CommandArguments @(
                    '-s', $selectedSerial, 'reverse', '--list'
                )
                $restoredSnapshot = Get-Tcp3001ReverseSnapshot -OutputLines $restoredReverse.Output
                Assert-ExactTcp3001ReverseTarget `
                    -Snapshot $restoredSnapshot `
                    -ExpectedTarget $reverseRestoreTarget `
                    -Context '恢复后复核'
                Write-Host "ADB：已恢复 tcp:3001 -> $reverseRestoreTarget"
            } elseif ($currentSnapshot.Targets.Count -eq 1 -and
                $currentSnapshot.Targets[0] -ceq $reverseRestoreTarget) {
                Write-Host "ADB：tcp:3001 已是原映射 $reverseRestoreTarget，保持不变"
            } else {
                $currentTargets = $currentSnapshot.Targets -join '，'
                throw "恢复前 tcp:3001 已被外部改为 $currentTargets；为避免覆盖外部状态，拒绝恢复。"
            }
        } catch {
            $cleanupFailureMessages.Add(
                "恢复 ADB 反向映射失败：$($_.Exception.Message)"
            )
        }
    }

    if ($reverseMutexAcquired -and $null -ne $reverseMutex) {
        try {
            $reverseMutex.ReleaseMutex()
        } catch {
            $cleanupFailureMessages.Add(
                "释放设备端口互斥锁失败：$($_.Exception.Message)"
            )
        } finally {
            $reverseMutex.Dispose()
            $reverseMutex = $null
            $reverseMutexAcquired = $false
        }
    } elseif ($null -ne $reverseMutex) {
        $reverseMutex.Dispose()
        $reverseMutex = $null
    }

    if ($cleanupFailureMessages.Count -gt 0) {
        $restoreFailure = $cleanupFailureMessages -join '；'
    }
    $env:PATH = $previousPath
    $env:ANDROID_HOME = $previousAndroidHome
    $env:ANDROID_SDK_ROOT = $previousAndroidSdkRoot
    $ErrorActionPreference = $previousErrorActionPreference
}

if ($null -ne $scriptFailure) {
    if ($null -ne $restoreFailure) {
        throw "设备测试失败，且设备清理也失败：$restoreFailure；原测试错误：$($scriptFailure.Exception.Message)"
    }
    throw $scriptFailure
}
if ($null -ne $restoreFailure) {
    throw "设备测试已结束，但设备清理失败：$restoreFailure"
}
