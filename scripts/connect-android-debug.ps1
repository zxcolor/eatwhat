<#
.SYNOPSIS
为 Android 自动化测试 Fixture 建立本机隔离 API 的 ADB 反向端口映射。

.DESCRIPTION
脚本只服务固定连接 127.0.0.1:3001 的自动化测试 Fixture：验证本机隔离 API、选择
已就绪设备并建立 adb reverse。它不用于日常云端 Debug，不会安装 APK，不会启动或
停止后端，默认也不会打开 App。只有显式传入 -OpenApp 才会打开已安装的 Fixture
测试包 com.chishenme.app.debug。

.PARAMETER AdbPath
可选的 adb.exe 完整路径。未提供时依次查找 PATH、Android 环境变量、仓库内
.tools/android-sdk 和当前用户的默认 Android SDK。

.PARAMETER Serial
可选的 adb 设备序列号。未提供时必须恰好有一台状态为 device 的设备。

.PARAMETER OpenApp
建立并验证端口映射后，打开已经安装的 Fixture 测试 App。不会安装 APK。

.PARAMETER ShowFullSerial
显式允许在终端输出完整设备序列号。默认仅显示掩码后的末四位。
#>
[CmdletBinding()]
param(
    [string]$AdbPath,
    [string]$Serial,
    [switch]$OpenApp,
    [switch]$ShowFullSerial
)

Set-StrictMode -Version Latest
$previousErrorActionPreference = $ErrorActionPreference
$previousPath = $env:PATH
$previousAndroidHome = $env:ANDROID_HOME
$previousAndroidSdkRoot = $env:ANDROID_SDK_ROOT
$ErrorActionPreference = 'Stop'

$apiHealthUrl = 'http://127.0.0.1:3001/health'
$debugApplicationId = 'com.chishenme.app.debug'
$localPort = 3001
$script:ResolvedAdbPath = $null

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
    $workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
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
    param([string[]]$CommandArguments)

    $output = @(& $script:ResolvedAdbPath @CommandArguments 2>&1 |
        ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $details = ($output -join [Environment]::NewLine).Trim()
        for ($index = 0; $index -lt ($CommandArguments.Count - 1); $index += 1) {
            if ($CommandArguments[$index] -eq '-s') {
                $commandSerial = $CommandArguments[$index + 1]
                $details = $details.Replace($commandSerial, (Format-DeviceSerial -DeviceSerial $commandSerial))
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = 'ADB 未返回错误详情。'
        }
        throw "ADB 命令失败（退出码 $exitCode）：$details"
    }
    return $output
}

function Select-ReadyDevice {
    param([string]$RequestedSerial)

    if (-not [string]::IsNullOrWhiteSpace($RequestedSerial) -and
        $RequestedSerial -notmatch '^[^\s\x00-\x1F\x7F]+$') {
        throw '设备序列号不能包含空白符或控制字符。请复制 adb devices 输出中的完整序列号。'
    }

    $deviceLines = Invoke-AdbCommand -CommandArguments @('devices', '-l')
    $devices = @($deviceLines | ForEach-Object {
        if ($_ -match '^(\S+)\s+(\S+)(?:\s|$)' -and $Matches[1] -ne 'List') {
            [PSCustomObject]@{ Serial = $Matches[1]; State = $Matches[2] }
        }
    })

    if (-not [string]::IsNullOrWhiteSpace($RequestedSerial)) {
        $selected = $devices | Where-Object { $_.Serial -eq $RequestedSerial } | Select-Object -First 1
        if (-not $selected) {
            $displaySerial = Format-DeviceSerial -DeviceSerial $RequestedSerial
            throw "未发现序列号为 $displaySerial 的设备。请运行 adb devices -l 检查连接。"
        }
        if ($selected.State -ne 'device') {
            $hint = if ($selected.State -eq 'unauthorized') {
                '请解锁设备并允许 USB 调试授权。'
            } elseif ($selected.State -eq 'offline') {
                '请重新连接设备或重启模拟器后再试。'
            } else {
                '请让设备进入可调试的 device 状态。'
            }
            $displaySerial = Format-DeviceSerial -DeviceSerial $RequestedSerial
            throw "设备 $displaySerial 当前状态为 $($selected.State)。$hint"
        }
        return $selected.Serial
    }

    $readyDevices = @($devices | Where-Object { $_.State -eq 'device' })
    if ($readyDevices.Count -eq 0) {
        $knownStates = if ($devices.Count -eq 0) {
            '未检测到设备。'
        } else {
            '已检测：' + (($devices | ForEach-Object {
                "$(Format-DeviceSerial -DeviceSerial $_.Serial)=$($_.State)"
            }) -join '，')
        }
        throw "$knownStates 请启动模拟器或连接并授权真机；本脚本不会替你启动设备。"
    }
    if ($readyDevices.Count -ne 1) {
        $serials = ($readyDevices | ForEach-Object {
            Format-DeviceSerial -DeviceSerial $_.Serial
        }) -join '，'
        throw "检测到多台已就绪设备：$serials。请使用 -Serial 明确选择一台。"
    }
    return $readyDevices[0].Serial
}

try {
    $script:ResolvedAdbPath = Resolve-AdbExecutable -RequestedPath $AdbPath
    Write-Host "ADB：$script:ResolvedAdbPath"

    $selectedSerial = Select-ReadyDevice -RequestedSerial $Serial
    Write-Host "设备：$(Format-DeviceSerial -DeviceSerial $selectedSerial)"

    try {
        $health = Invoke-RestMethod -Method Get -Uri $apiHealthUrl -TimeoutSec 5
    } catch {
        throw "本机 API 健康检查失败：$apiHealthUrl。请先在另一终端启动 pnpm dev:api 并确认 /health 可访问；本脚本不会启动或重启后端。原始错误：$($_.Exception.Message)"
    }
    if ($null -eq $health -or $health.status -ne 'ok') {
        throw "本机 API 返回了非健康状态：$apiHealthUrl。请检查 API 日志后重试。"
    }
    Write-Host '本机 API：健康'

    $remoteEndpoint = "tcp:$localPort"
    $reverseMappings = Invoke-AdbCommand -CommandArguments @(
        '-s', $selectedSerial, 'reverse', '--list'
    )
    $remotePattern = "(?:^|\s)$([regex]::Escape($remoteEndpoint))\s+(?<Target>\S+)(?:\s|$)"
    $existingTargets = @($reverseMappings | ForEach-Object {
        if ($_ -match $remotePattern) {
            $Matches.Target
        }
    })
    $conflictingTargets = @($existingTargets | Where-Object { $_ -ne $remoteEndpoint })
    if ($conflictingTargets.Count -gt 0) {
        throw "设备 $remoteEndpoint 已存在不同反向映射（目标：$($conflictingTargets -join '，')）；为避免静默覆盖，本脚本已安全停止。"
    }
    if ($existingTargets -contains $remoteEndpoint) {
        # `adb reverse --list` can retain a mapping whose forwarding socket is
        # stale after an emulator/ADB restart. The target has already been
        # checked above, so refreshing this exact same mapping cannot overwrite
        # an unrelated destination.
        Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'reverse', '--remove', $remoteEndpoint
        ) | Out-Null
        Write-Host "端口映射：$remoteEndpoint 已存在，已安全刷新"
    }
    Invoke-AdbCommand -CommandArguments @(
        '-s', $selectedSerial, 'reverse', $remoteEndpoint, $remoteEndpoint
    ) | Out-Null

    $reverseMappings = Invoke-AdbCommand -CommandArguments @(
        '-s', $selectedSerial, 'reverse', '--list'
    )
    $mappingPattern = "(?:^|\s)$([regex]::Escape($remoteEndpoint))\s+$([regex]::Escape($remoteEndpoint))(?:\s|$)"
    if (-not (($reverseMappings -join [Environment]::NewLine) -match $mappingPattern)) {
        throw "ADB 未报告 tcp:$localPort 到 tcp:$localPort 的反向映射。请检查设备调试连接后重试。"
    }
    Write-Host "端口映射：设备 tcp:$localPort -> 本机 tcp:$localPort（已验证）"

    if ($OpenApp) {
        $packagePaths = Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'shell', 'pm', 'path', $debugApplicationId
        )
        if (-not (($packagePaths -join [Environment]::NewLine) -match '^package:')) {
            throw "设备上未安装 $debugApplicationId。请先构建并安装 Fixture 测试 APK；本脚本不会安装应用。"
        }

        $resolvedActivities = Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
            '-a', 'android.intent.action.MAIN',
            '-c', 'android.intent.category.LAUNCHER',
            $debugApplicationId
        )
        $launchComponent = $resolvedActivities |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -match '^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$' } |
            Select-Object -Last 1
        if ([string]::IsNullOrWhiteSpace($launchComponent)) {
            throw "无法解析 $debugApplicationId 的启动 Activity。请确认安装的是当前 Fixture 测试 APK。"
        }

        $launchOutput = Invoke-AdbCommand -CommandArguments @(
            '-s', $selectedSerial, 'shell', 'am', 'start', '-W',
            '-n', $launchComponent
        )
        $launchText = $launchOutput -join [Environment]::NewLine
        if ($launchText -notmatch 'Status:\s+ok') {
            # A very slow first ART/Compose verification on an unaccelerated
            # emulator can make `am start -W` report timeout even though the
            # requested activity is already resumed in a live process. Accept
            # only that narrow, independently verified fallback; crashes or a
            # different foreground activity still fail closed.
            $processIds = Invoke-AdbCommand -CommandArguments @(
                '-s', $selectedSerial, 'shell', 'pidof', $debugApplicationId
            )
            $activityState = Invoke-AdbCommand -CommandArguments @(
                '-s', $selectedSerial, 'shell', 'dumpsys', 'activity', 'activities'
            )
            $componentPattern = 'topResumedActivity=.*\s' + [regex]::Escape($launchComponent) + '\s'
            $isVerifiedSlowLaunch =
                $launchText -match 'Status:\s+timeout' -and
                -not [string]::IsNullOrWhiteSpace(($processIds -join '')) -and
                (($activityState -join [Environment]::NewLine) -match $componentPattern)
            if (-not $isVerifiedSlowLaunch) {
                throw "Fixture 测试 App 启动结果不明确：$($launchOutput -join ' ')"
            }
            Write-Warning 'Fixture 测试 App 已进入前台，但模拟器首次类验证较慢；请等待启动画面结束。'
        }
        Write-Host 'Fixture 测试 App：已打开'
    } else {
        Write-Host 'Fixture 测试 App：未打开（如需打开，请显式增加 -OpenApp）'
    }

    Write-Host 'Android 自动化测试 Fixture 连接已就绪。设备或模拟器重启后请重新运行本脚本。'
} finally {
    $env:PATH = $previousPath
    $env:ANDROID_HOME = $previousAndroidHome
    $env:ANDROID_SDK_ROOT = $previousAndroidSdkRoot
    $ErrorActionPreference = $previousErrorActionPreference
}
