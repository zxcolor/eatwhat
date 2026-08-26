[CmdletBinding(DefaultParameterSetName = 'Prepare')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
    [ValidateNotNullOrEmpty()]
    [string]$SdkZipPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'TransactionSelfTest')]
    [switch]$RunTransactionSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedArchiveMd5 = 'FCF7AC166A39B2782A4E7933C0F50226'
$artifacts = @(
    [PSCustomObject]@{
        Label = 'Fusion Authentication'
        FileName = 'fusionauth-1.2.15-online-release.aar'
        EntryPattern = '^[^/]+/SDK/fusionauth-1\.2\.15-online-release\.aar$'
        Sha256 = '706653407DCD94C9214AA4277E14476723672E27AA998ADBF9E612EC038857FC'
    },
    [PSCustomObject]@{
        Label = 'Umeng Common'
        FileName = 'umeng-common-9.5.6.aar'
        EntryPattern = '^[^/]+/SDK/umeng-common/umeng-common-9\.5\.6\.aar$'
        Sha256 = '89C22AD4D6F761ABB14FB79CB0BE051C2DD5C59ADD655B808E2A9511FD7D40E4'
    },
    [PSCustomObject]@{
        Label = 'Umeng ASMS'
        FileName = 'umeng-asms-v1.8.0.aar'
        EntryPattern = '^[^/]+/SDK/umeng-asm/umeng-asms-v1\.8\.0\.aar$'
        Sha256 = '35021A4A64B12568F6804193E05D197420BE577622C6ED402FF7B736CE17E324'
    }
)
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destinationDirectory = Join-Path $repositoryRoot 'apps/android/.local/fusion-auth'

function Get-UnsignedExternalAttributes {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExternalAttributes
    )

    return [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$ExternalAttributes), 0)
}

function Assert-SafeZipEntry {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.Compression.ZipArchiveEntry]$Entry,

        [Parameter(Mandatory = $true)]
        [string]$ValidationRoot
    )

    $entryName = $Entry.FullName
    if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.IndexOf([char]0) -ge 0) {
        throw "ZIP contains an empty or NUL-containing entry name."
    }

    $normalizedName = $entryName.Replace([char]92, [char]47)
    if ($normalizedName.StartsWith('/', [StringComparison]::Ordinal) -or
        [IO.Path]::IsPathRooted($normalizedName) -or
        $normalizedName -match '^[A-Za-z]:') {
        throw "ZIP entry is rooted and unsafe: $entryName"
    }

    $segments = $normalizedName.Split(
        [char[]]@('/'),
        [StringSplitOptions]::None
    )
    for ($index = 0; $index -lt $segments.Length; $index += 1) {
        $segment = $segments[$index]
        $isTrailingDirectoryMarker =
            $index -eq ($segments.Length - 1) -and
            $segment.Length -eq 0 -and
            $normalizedName.EndsWith('/', [StringComparison]::Ordinal)

        if ($isTrailingDirectoryMarker) {
            continue
        }

        if ([string]::IsNullOrEmpty($segment) -or
            $segment -eq '.' -or
            $segment -eq '..' -or
            $segment.Contains(':')) {
            throw "ZIP entry contains an unsafe path segment: $entryName"
        }
    }

    $relativeWindowsPath = $normalizedName.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $validationRootFullPath = [IO.Path]::GetFullPath($ValidationRoot)
    $validationRootPrefix = $validationRootFullPath.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    $candidatePath = [IO.Path]::GetFullPath(
        [IO.Path]::Combine($validationRootFullPath, $relativeWindowsPath)
    )
    if (-not $candidatePath.StartsWith($validationRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "ZIP entry escapes the extraction root: $entryName"
    }

    $attributes = Get-UnsignedExternalAttributes -ExternalAttributes $Entry.ExternalAttributes
    $unixFileType = (($attributes -shr 16) -band 0xF000)
    $hasWindowsReparsePoint = ($attributes -band 0x0400) -ne 0
    if ($unixFileType -eq 0xA000 -or $hasWindowsReparsePoint) {
        throw "ZIP contains a symbolic link, which is not allowed: $entryName"
    }
}

function Install-PreparedArtifactsWithRollback {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.Generic.List[object]]$PreparedArtifacts,

        [Parameter()]
        [ValidateRange(0, [int]::MaxValue)]
        [int]$FailAfterCommitCount = 0
    )

    $committedCount = 0
    try {
        foreach ($item in $PreparedArtifacts) {
            $item.OriginalExisted = Test-Path -LiteralPath $item.DestinationPath -PathType Leaf
            if ((Test-Path -LiteralPath $item.DestinationPath) -and -not $item.OriginalExisted) {
                throw "SDK destination exists but is not a regular file: $($item.DestinationPath)"
            }

            if ($item.OriginalExisted) {
                $itemDestinationDirectory = Split-Path -Parent $item.DestinationPath
                $item.BackupPath = Join-Path $itemDestinationDirectory (
                    '.{0}.{1}.bak' -f $item.Artifact.FileName, [Guid]::NewGuid().ToString('N')
                )
                [IO.File]::Replace($item.TempPath, $item.DestinationPath, $item.BackupPath)
            }
            else {
                [IO.File]::Move($item.TempPath, $item.DestinationPath)
            }
            $item.TempPath = $null
            $item.Committed = $true
            $committedCount += 1

            if ($FailAfterCommitCount -gt 0 -and $committedCount -eq $FailAfterCommitCount) {
                throw "Injected SDK transaction failure after $committedCount committed artifacts."
            }
        }
    }
    catch {
        $originalError = $_
        $rollbackErrors = [Collections.Generic.List[string]]::new()
        for ($index = $PreparedArtifacts.Count - 1; $index -ge 0; $index -= 1) {
            $item = $PreparedArtifacts[$index]
            if (-not $item.Committed) {
                continue
            }

            try {
                if ($item.OriginalExisted) {
                    if ($null -eq $item.BackupPath -or
                        -not (Test-Path -LiteralPath $item.BackupPath -PathType Leaf)) {
                        throw "rollback backup is missing: $($item.BackupPath)"
                    }
                    if (Test-Path -LiteralPath $item.DestinationPath) {
                        if (-not (Test-Path -LiteralPath $item.DestinationPath -PathType Leaf)) {
                            throw "rollback destination is not a regular file: $($item.DestinationPath)"
                        }
                        $rollbackDiscardPath = Join-Path (
                            Split-Path -Parent $item.DestinationPath
                        ) (
                            '.{0}.{1}.rollback-discard' -f `
                                $item.Artifact.FileName,
                                [Guid]::NewGuid().ToString('N')
                        )
                        [IO.File]::Replace(
                            $item.BackupPath,
                            $item.DestinationPath,
                            $rollbackDiscardPath
                        )
                        $item.BackupPath = $null
                        try {
                            [IO.File]::Delete($rollbackDiscardPath)
                        }
                        catch {
                            Write-Warning "Rollback restored the original SDK artifact, but could not remove the discarded replacement: $rollbackDiscardPath"
                        }
                    }
                    else {
                        [IO.File]::Move($item.BackupPath, $item.DestinationPath)
                        $item.BackupPath = $null
                    }
                }
                elseif (Test-Path -LiteralPath $item.DestinationPath) {
                    if (-not (Test-Path -LiteralPath $item.DestinationPath -PathType Leaf)) {
                        throw "new rollback destination is not a regular file: $($item.DestinationPath)"
                    }
                    [IO.File]::Delete($item.DestinationPath)
                }
                $item.Committed = $false
            }
            catch {
                $rollbackErrors.Add(
                    "$($item.Artifact.Label): $($_.Exception.Message)"
                )
            }
        }

        if ($rollbackErrors.Count -gt 0) {
            $retainedBackups = @(
                $PreparedArtifacts |
                    Where-Object {
                        $null -ne $_.BackupPath -and
                        (Test-Path -LiteralPath $_.BackupPath -PathType Leaf)
                    } |
                    ForEach-Object { $_.BackupPath }
            )
            $recoveryText = if ($retainedBackups.Count -gt 0) {
                " Recovery backups retained: $($retainedBackups -join ', ')."
            }
            else {
                ''
            }
            throw [InvalidOperationException]::new(
                "SDK AAR replacement failed and rollback was incomplete: " +
                "$($rollbackErrors -join '; ').$recoveryText Original error: " +
                $originalError.Exception.Message,
                $originalError.Exception
            )
        }
        throw $originalError
    }

    foreach ($item in $PreparedArtifacts) {
        if ($null -ne $item.BackupPath -and (Test-Path -LiteralPath $item.BackupPath -PathType Leaf)) {
            try {
                [IO.File]::Delete($item.BackupPath)
                $item.BackupPath = $null
            }
            catch {
                Write-Warning "SDK installed, but the superseded backup could not be removed: $($item.BackupPath)"
            }
        }
    }
}

function Invoke-SdkTransactionSelfTest {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $fixtureRoot = Join-Path $tempRoot (
        'chi-shen-me-fusion-sdk-transaction-' + [Guid]::NewGuid().ToString('N')
    )
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null

    try {
        $fixtureItems = [Collections.Generic.List[object]]::new()
        for ($index = 1; $index -le 3; $index += 1) {
            $destinationPath = Join-Path $fixtureRoot "artifact-$index.aar"
            $tempPath = Join-Path $fixtureRoot ".artifact-$index.tmp"
            [IO.File]::WriteAllText($destinationPath, "old-$index")
            [IO.File]::WriteAllText($tempPath, "new-$index")
            $fixtureItems.Add([PSCustomObject]@{
                Artifact = [PSCustomObject]@{
                    Label = "Fixture $index"
                    FileName = "artifact-$index.aar"
                }
                TempPath = $tempPath
                DestinationPath = $destinationPath
                BackupPath = $null
                OriginalExisted = $false
                Committed = $false
                ActualSha256 = ''
            })
        }

        $injectedFailureObserved = $false
        try {
            Install-PreparedArtifactsWithRollback `
                -PreparedArtifacts $fixtureItems `
                -FailAfterCommitCount 2
        }
        catch {
            if ($_.Exception.Message -cne 'Injected SDK transaction failure after 2 committed artifacts.') {
                throw
            }
            $injectedFailureObserved = $true
        }
        if (-not $injectedFailureObserved) {
            throw 'SDK transaction self-test did not observe the injected failure.'
        }

        for ($index = 1; $index -le 3; $index += 1) {
            $destinationPath = Join-Path $fixtureRoot "artifact-$index.aar"
            if ([IO.File]::ReadAllText($destinationPath) -cne "old-$index") {
                throw "SDK transaction rollback did not restore artifact $index."
            }
        }
        if (@(Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.bak' -Force).Count -ne 0) {
            throw 'SDK transaction rollback left an unexpected backup file.'
        }

        $newFixtureItems = [Collections.Generic.List[object]]::new()
        for ($index = 1; $index -le 3; $index += 1) {
            $destinationPath = Join-Path $fixtureRoot "new-artifact-$index.aar"
            $tempPath = Join-Path $fixtureRoot ".new-artifact-$index.tmp"
            [IO.File]::WriteAllText($tempPath, "new-$index")
            $newFixtureItems.Add([PSCustomObject]@{
                Artifact = [PSCustomObject]@{
                    Label = "New fixture $index"
                    FileName = "new-artifact-$index.aar"
                }
                TempPath = $tempPath
                DestinationPath = $destinationPath
                BackupPath = $null
                OriginalExisted = $false
                Committed = $false
                ActualSha256 = ''
            })
        }
        try {
            Install-PreparedArtifactsWithRollback `
                -PreparedArtifacts $newFixtureItems `
                -FailAfterCommitCount 2
            throw 'SDK new-install rollback self-test did not inject a failure.'
        }
        catch {
            if ($_.Exception.Message -cne 'Injected SDK transaction failure after 2 committed artifacts.') {
                throw
            }
        }
        for ($index = 1; $index -le 3; $index += 1) {
            $destinationPath = Join-Path $fixtureRoot "new-artifact-$index.aar"
            if (Test-Path -LiteralPath $destinationPath) {
                throw "SDK new-install rollback left artifact $index installed."
            }
        }
        Write-Host 'Fusion Authentication SDK transaction rollback self-test passed.'
    }
    finally {
        $resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
        $fixturePrefix = $tempRoot.TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        ) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedFixtureRoot.StartsWith(
            $fixturePrefix,
            [StringComparison]::OrdinalIgnoreCase
        ) -or [IO.Path]::GetFileName($resolvedFixtureRoot) -notlike
            'chi-shen-me-fusion-sdk-transaction-*') {
            throw 'SDK transaction self-test cleanup path escaped the temporary directory.'
        }
        if ([IO.Directory]::Exists($resolvedFixtureRoot)) {
            [IO.Directory]::Delete($resolvedFixtureRoot, $true)
        }
    }
}

if ($PSCmdlet.ParameterSetName -eq 'TransactionSelfTest') {
    Invoke-SdkTransactionSelfTest
    return
}

$resolvedZipPath = (Resolve-Path -LiteralPath $SdkZipPath).Path
if (-not (Test-Path -LiteralPath $resolvedZipPath -PathType Leaf)) {
    throw "SDK archive is not a file: $resolvedZipPath"
}

$archiveMd5 = (Get-FileHash -LiteralPath $resolvedZipPath -Algorithm MD5).Hash.ToUpperInvariant()
if ($archiveMd5 -cne $expectedArchiveMd5) {
    throw "SDK archive MD5 mismatch. Expected $expectedArchiveMd5, got $archiveMd5."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = $null
$prepared = [Collections.Generic.List[object]]::new()
try {
    $zip = [IO.Compression.ZipFile]::OpenRead($resolvedZipPath)
    $validationRoot = Join-Path ([IO.Path]::GetTempPath()) 'chi-shen-me-fusion-auth-zip-validation'
    $matchingEntries = @{}
    foreach ($artifact in $artifacts) {
        $matchingEntries[$artifact.FileName] =
            [Collections.Generic.List[IO.Compression.ZipArchiveEntry]]::new()
    }

    foreach ($entry in $zip.Entries) {
        Assert-SafeZipEntry -Entry $entry -ValidationRoot $validationRoot

        $normalizedName = $entry.FullName.Replace([char]92, [char]47)
        foreach ($artifact in $artifacts) {
            if ($normalizedName -cmatch $artifact.EntryPattern) {
                $matchingEntries[$artifact.FileName].Add($entry)
            }
        }
    }

    foreach ($artifact in $artifacts) {
        $matches = $matchingEntries[$artifact.FileName]
        if ($matches.Count -ne 1) {
            throw "Expected exactly one $($artifact.Label) AAR, found $($matches.Count)."
        }
    }

    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    foreach ($artifact in $artifacts) {
        $tempPath = Join-Path $destinationDirectory (
            '.{0}.{1}.tmp' -f $artifact.FileName, [Guid]::NewGuid().ToString('N')
        )
        $inputStream = $matchingEntries[$artifact.FileName][0].Open()
        try {
            $outputStream = [IO.File]::Open(
                $tempPath,
                [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write,
                [IO.FileShare]::None
            )
            try {
                $inputStream.CopyTo($outputStream)
                $outputStream.Flush($true)
            }
            finally {
                $outputStream.Dispose()
            }
        }
        finally {
            $inputStream.Dispose()
        }

        $actualSha256 = (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actualSha256 -cne $artifact.Sha256) {
            throw "$($artifact.Label) AAR SHA-256 mismatch. Expected $($artifact.Sha256), got $actualSha256."
        }
        $prepared.Add([PSCustomObject]@{
            Artifact = $artifact
            TempPath = $tempPath
            DestinationPath = Join-Path $destinationDirectory $artifact.FileName
            BackupPath = $null
            OriginalExisted = $false
            Committed = $false
            ActualSha256 = $actualSha256
        })
    }

    Install-PreparedArtifactsWithRollback -PreparedArtifacts $prepared

    Write-Host 'Aliyun Fusion Authentication SDK prepared successfully.'
    Write-Host "Archive MD5: $archiveMd5"
    foreach ($item in $prepared) {
        Write-Host "$($item.Artifact.Label) SHA-256: $($item.ActualSha256)"
        Write-Host "Local ignored artifact: $($item.DestinationPath)"
    }
}
finally {
    if ($null -ne $zip) {
        $zip.Dispose()
    }
    foreach ($item in $prepared) {
        if ($null -ne $item.TempPath -and (Test-Path -LiteralPath $item.TempPath)) {
            Remove-Item -LiteralPath $item.TempPath -Force
        }
        # A non-null backup after failure is deliberate recovery evidence.
        # Install-PreparedArtifactsWithRollback removes it only after success
        # or consumes it while restoring the original artifact.
    }
}
