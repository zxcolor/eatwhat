param(
    [string]$WorkspaceRoot,
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT })
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$workspaceRoot = if ($WorkspaceRoot -match '^[A-Za-z]:\\$') {
    $WorkspaceRoot
} else {
    $WorkspaceRoot.TrimEnd('\')
}
$jdkRoot = Join-Path $workspaceRoot '.tools\jdk17'
$androidSdkRoot = Join-Path $workspaceRoot '.tools\android-sdk'

$jdk = Get-ChildItem -LiteralPath $jdkRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
    Select-Object -First 1

if (-not $jdk -and -not [string]::IsNullOrWhiteSpace($JavaHome) -and
    (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
    $jdk = Get-Item -LiteralPath $JavaHome
}

if (-not $jdk) {
    throw '未找到 .tools/jdk17。请安装 JDK 17，或在当前终端手动设置 JAVA_HOME。'
}

$javaReleasePath = Join-Path $jdk.FullName 'release'
if (-not (Test-Path -LiteralPath $javaReleasePath) -or
    -not (Select-String -LiteralPath $javaReleasePath -Pattern '^JAVA_VERSION="17(?:[.+_-]|")' -Quiet)) {
    throw 'Android 验证必须使用 JDK 17。请将 JAVA_HOME 指向已安装的 JDK 17。'
}

if (-not (Test-Path -LiteralPath (Join-Path $androidSdkRoot 'platforms\android-36')) -and
    -not [string]::IsNullOrWhiteSpace($AndroidSdk)) {
    $androidSdkRoot = $AndroidSdk
}

if (-not (Test-Path (Join-Path $androidSdkRoot 'platforms\android-36'))) {
    throw '未找到 Android SDK 36。请通过 Android Studio SDK Manager 安装 platforms;android-36。'
}

$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = $androidSdkRoot
$env:ANDROID_SDK_ROOT = $androidSdkRoot
$env:PATH = "$($jdk.FullName)\bin;$androidSdkRoot\platform-tools;$env:PATH"

Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
