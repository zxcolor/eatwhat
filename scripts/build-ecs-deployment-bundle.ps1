#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter()]
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),

    [Parameter(Mandatory = $true)]
    [Alias('BundleDirectory')]
    [string]$OutputDirectory,

    [Parameter()]
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ManifestName = 'SHA256SUMS'
$script:RequiredMappings = @(
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/compose.yml'
        BundleRelative = 'compose.yml'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/nginx/api.unfinished-era.com.conf'
        BundleRelative = 'nginx/api.unfinished-era.com.conf'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/nginx/api.unfinished-era.com.acme.conf'
        BundleRelative = 'nginx/api.unfinished-era.com.acme.conf'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/nginx/api.unfinished-era.com.well-known.conf'
        BundleRelative = 'nginx/api.unfinished-era.com.well-known.conf'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/postgres/pg_hba.conf'
        BundleRelative = 'postgres/pg_hba.conf'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/deployment.env.example'
        BundleRelative = 'deployment.env.example'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/activate-baota-nginx.sh'
        BundleRelative = 'scripts/activate-baota-nginx.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/activate-api-subdomain-nginx.sh'
        BundleRelative = 'scripts/activate-api-subdomain-nginx.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/activate-candidate-release.sh'
        BundleRelative = 'scripts/activate-candidate-release.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/assert-phone-only-bridge-runtime.sh'
        BundleRelative = 'scripts/assert-phone-only-bridge-runtime.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/assert-wechat-union-aliases-bridge-runtime.sh'
        BundleRelative = 'scripts/assert-wechat-union-aliases-bridge-runtime.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/backup-database.sh'
        BundleRelative = 'scripts/backup-database.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/harden-release-permissions.sh'
        BundleRelative = 'scripts/harden-release-permissions.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/prepare-secrets.sh'
        BundleRelative = 'scripts/prepare-secrets.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/preflight-deployment.sh'
        BundleRelative = 'scripts/preflight-deployment.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/provision-database.sh'
        BundleRelative = 'scripts/provision-database.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/reload-nginx-after-certificate-renewal.sh'
        BundleRelative = 'scripts/reload-nginx-after-certificate-renewal.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/restore-database.sh'
        BundleRelative = 'scripts/restore-database.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/rollback-database.sh'
        BundleRelative = 'scripts/rollback-database.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/smoke-test.sh'
        BundleRelative = 'scripts/smoke-test.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/verify-runtime.sh'
        BundleRelative = 'scripts/verify-runtime.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/update-amap-secrets.sh'
        BundleRelative = 'scripts/update-amap-secrets.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/update-auth-secrets.sh'
        BundleRelative = 'scripts/update-auth-secrets.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/ecs/scripts/verify-database-backup.sh'
        BundleRelative = 'scripts/verify-database-backup.sh'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/postgres/bootstrap-extensions.sql'
        BundleRelative = 'sql/bootstrap-extensions.sql'
    },
    [pscustomobject]@{
        SourceRelative = 'infra/postgres/role-grants.sql'
        BundleRelative = 'sql/role-grants.sql'
    }
)

function ConvertTo-NativeRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return $Path.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Get-NormalizedExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description does not exist or is not a directory: $Path"
    }

    return (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Get-NormalizedCandidatePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BasePath
    )

    $candidate = $Path
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        $candidate = Join-Path -Path $BasePath -ChildPath $candidate
    }

    return [System.IO.Path]::GetFullPath($candidate).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-PathSameOrChild {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $comparison = [System.StringComparison]::Ordinal
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $comparison = [System.StringComparison]::OrdinalIgnoreCase
    }

    if ([string]::Equals($Candidate, $Parent, $comparison)) {
        return $true
    }

    $parentWithSeparator = $Parent.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar

    return $Candidate.StartsWith($parentWithSeparator, $comparison)
}

function Assert-NoExistingReparseAncestor {
    param([Parameter(Mandatory = $true)][string]$Path)

    $cursor = $Path
    if (-not (Test-Path -LiteralPath $cursor)) {
        $cursor = Split-Path -Parent $cursor
    }

    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Output paths through links or reparse points are not allowed: $cursor"
            }
        }

        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
            break
        }
        $cursor = $parent
    }
}

function Get-ProtectedBroadDirectories {
    $paths = New-Object System.Collections.Generic.List[string]
    $candidates = @(
        [System.IO.Path]::GetPathRoot((Get-Location).ProviderPath),
        $env:SystemDrive,
        $env:USERPROFILE,
        $env:PUBLIC,
        $env:ProgramData,
        $env:SystemRoot,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop),
        [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments),
        [System.IO.Path]::GetTempPath()
    )

    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $candidates += (Join-Path -Path $env:USERPROFILE -ChildPath 'Downloads')
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        try {
            $normalized = [System.IO.Path]::GetFullPath($candidate).TrimEnd(
                [System.IO.Path]::DirectorySeparatorChar,
                [System.IO.Path]::AltDirectorySeparatorChar
            )
            if (-not $paths.Contains($normalized)) {
                $paths.Add($normalized)
            }
        }
        catch {
            # An unavailable optional known folder cannot make a chosen target safer.
        }
    }

    return $paths.ToArray()
}

function Assert-SafeOutputLocation {
    param(
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][string]$RepoPath,
        [Parameter(Mandatory = $true)][bool]$MustExist
    )

    if (Test-PathSameOrChild -Candidate $OutputPath -Parent $RepoPath) {
        throw "The bundle output must be outside the repository: $OutputPath"
    }
    if (Test-PathSameOrChild -Candidate $RepoPath -Parent $OutputPath) {
        throw "The bundle output must not be an ancestor of the repository: $OutputPath"
    }

    $root = [System.IO.Path]::GetPathRoot($OutputPath)
    [char[]]$pathSeparators = @(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $parts = @($OutputPath.Substring($root.Length).Trim(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ).Split($pathSeparators, [System.StringSplitOptions]::RemoveEmptyEntries))
    if ($parts.Count -lt 2) {
        throw "Refusing a broad output path. Choose a dedicated bundle directory: $OutputPath"
    }

    foreach ($protected in @(Get-ProtectedBroadDirectories)) {
        if ((Test-PathSameOrChild -Candidate $OutputPath -Parent $protected) -and
            (Test-PathSameOrChild -Candidate $protected -Parent $OutputPath)) {
            throw "Refusing to use a protected broad directory as the bundle output: $OutputPath"
        }
    }

    Assert-NoExistingReparseAncestor -Path $OutputPath

    if ($MustExist) {
        if (-not (Test-Path -LiteralPath $OutputPath -PathType Container)) {
            throw "Bundle directory does not exist: $OutputPath"
        }
        return
    }

    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
        throw "Bundle output is an existing file: $OutputPath"
    }
    if (Test-Path -LiteralPath $OutputPath -PathType Container) {
        $existingItems = @(Get-ChildItem -LiteralPath $OutputPath -Force)
        if ($existingItems.Count -ne 0) {
            throw "Refusing to overwrite a non-empty bundle directory: $OutputPath"
        }
    }
    else {
        $parent = Split-Path -Parent $OutputPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "The bundle output parent must already exist: $parent"
        }
    }
}

function Get-RelativeChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Child
    )

    if (-not (Test-PathSameOrChild -Candidate $Child -Parent $Root) -or
        [string]::Equals($Child, $Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is not a child of the expected root: $Child"
    }

    return $Child.Substring($Root.Length + 1).Replace(
        [System.IO.Path]::DirectorySeparatorChar,
        '/'
    ).Replace([System.IO.Path]::AltDirectorySeparatorChar, '/')
}

function Get-OrdinalSortedStrings {
    param([Parameter(Mandatory = $true)][object[]]$Values)

    [string[]]$result = @($Values | ForEach-Object { [string]$_ })
    [System.Array]::Sort($result, [System.StringComparer]::Ordinal)
    return $result
}

function Assert-ExactSet {
    param(
        [Parameter(Mandatory = $true)][string[]]$Actual,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $differences = @(Compare-Object -ReferenceObject @($Expected) -DifferenceObject @($Actual))
    if ($differences.Count -ne 0) {
        $details = ($differences | ForEach-Object {
            $side = if ($_.SideIndicator -eq '=>') { 'unexpected' } else { 'missing' }
            "$side=$($_.InputObject)"
        }) -join '; '
        throw "$Description does not match the reviewed allowlist: $details"
    }
}

function Assert-SourceContract {
    param([Parameter(Mandatory = $true)][string]$RepoPath)

    $ecsRoot = Join-Path -Path $RepoPath -ChildPath 'infra/ecs'
    if (-not (Test-Path -LiteralPath $ecsRoot -PathType Container)) {
        throw "Required ECS deployment source directory is missing: $ecsRoot"
    }
    $ecsRoot = (Resolve-Path -LiteralPath $ecsRoot).ProviderPath.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    foreach ($item in @(Get-ChildItem -LiteralPath $ecsRoot -Recurse -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Links or reparse points are not allowed in infra/ecs: $($item.FullName)"
        }
    }

    $actualEcsFiles = @(Get-ChildItem -LiteralPath $ecsRoot -Recurse -File -Force |
        ForEach-Object { Get-RelativeChildPath -Root $ecsRoot -Child $_.FullName })
    $expectedEcsFiles = @($script:RequiredMappings |
        Where-Object { $_.SourceRelative.StartsWith('infra/ecs/') } |
        ForEach-Object { $_.SourceRelative.Substring('infra/ecs/'.Length) })
    Assert-ExactSet -Actual $actualEcsFiles -Expected $expectedEcsFiles `
        -Description 'infra/ecs file inventory'

    foreach ($mapping in $script:RequiredMappings) {
        $source = Join-Path -Path $RepoPath -ChildPath (
            ConvertTo-NativeRelativePath -Path $mapping.SourceRelative
        )
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required deployment source file is missing: $($mapping.SourceRelative)"
        }
        $sourceItem = Get-Item -LiteralPath $source -Force
        if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Deployment source files must not be links: $($mapping.SourceRelative)"
        }
    }
}

function Test-SafePlaceholderValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $trimmed = ($Value.Trim() -replace '\s+&&\s*$', '').Trim()
    if ($trimmed.Length -ge 2) {
        if (($trimmed[0] -eq '"' -and $trimmed[$trimmed.Length - 1] -eq '"') -or
            ($trimmed[0] -eq "'" -and $trimmed[$trimmed.Length - 1] -eq "'")) {
            $trimmed = $trimmed.Substring(1, $trimmed.Length - 2).Trim()
        }
    }

    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $true
    }
    if ($trimmed -match '^\$\$?\{[A-Z0-9_]+(?::[-+?][^}]*)?\}$') {
        return $true
    }
    if ($trimmed -match '^\$\$?\(cat\s+/(?:run|opt)/[A-Za-z0-9_./-]*secrets[A-Za-z0-9_./-]*\)$') {
        return $true
    }
    if ($trimmed -match '^<[^>]+>$') {
        return $true
    }
    if ($trimmed -match '^(?i:CHANGE_ME|CHANGEME|REPLACE_ME|REQUIRED|PLACEHOLDER|EXAMPLE|NOT_SET)$') {
        return $true
    }
    if ($Name -match '(?i)(?:_FILE|_PATH)$' -and
        $trimmed -match '^(?:[./\\]|[A-Za-z]:[\\/])[A-Za-z0-9_./\\:-]+$') {
        return $true
    }
    if ($Name -ceq 'ALIYUN_CREDENTIAL_ALLOWED_PROVIDER' -and
        $trimmed -in @('default/ecs_ram_role', 'default/oidc_role_arn')) {
        return $true
    }
    return $false
}

function Assert-NoSensitiveMaterial {
    param(
        [Parameter(Mandatory = $true)][string]$BundleRoot,
        [Parameter(Mandatory = $true)][string[]]$PayloadPaths
    )

    foreach ($relative in $PayloadPaths) {
        $nativeRelative = ConvertTo-NativeRelativePath -Path $relative
        $path = Join-Path -Path $BundleRoot -ChildPath $nativeRelative
        $name = [System.IO.Path]::GetFileName($path)
        $lowerName = $name.ToLowerInvariant()

        if ($lowerName -match '(^|[.])env($|[.])' -and
            -not $lowerName.EndsWith('.env.example')) {
            throw "Only .env.example templates may be included in the bundle: $relative"
        }
        if ($lowerName -match '(?i)(^id_rsa$|^id_ed25519$|[.](key|pem|p12|pfx|jks|keystore)$)') {
            throw "Private key or credential material is forbidden in the bundle: $relative"
        }

        $bytes = [System.IO.File]::ReadAllBytes($path)
        if ($bytes -contains 0) {
            throw "Unexpected binary payload is forbidden in this source-only bundle: $relative"
        }
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)

        $forbiddenPatterns = @(
            '-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----',
            '(?<![A-Za-z0-9])LTAI[A-Za-z0-9]{12,}',
            '(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}',
            '(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}',
            '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}',
            '(?i)(?:postgres(?:ql)?|mysql|mongodb(?:[+]srv)?|redis)://[^\s/:]+:[^\s/@]+@'
        )
        foreach ($pattern in $forbiddenPatterns) {
            if ($text -match $pattern) {
                throw "Possible credential or private material detected in bundle payload: $relative"
            }
        }

        $assignmentPattern = '(?im)^\s*(?:export\s+)?(?<name>[A-Z][A-Z0-9_.-]*(?:KEY|SECRET|PASSWORD|TOKEN|PEPPER|CREDENTIAL)[A-Z0-9_.-]*)\s*(?:=|:)\s*(?<value>[^\r\n#]*)'
        foreach ($match in [System.Text.RegularExpressions.Regex]::Matches($text, $assignmentPattern)) {
            $nameValue = $match.Groups['name'].Value
            $assignedValue = $match.Groups['value'].Value
            if (-not (Test-SafePlaceholderValue -Name $nameValue -Value $assignedValue)) {
                throw "A sensitive setting has a non-placeholder value in ${relative}: $nameValue"
            }
        }
    }
}

function Write-HashManifest {
    param(
        [Parameter(Mandatory = $true)][string]$BundleRoot,
        [Parameter(Mandatory = $true)][string[]]$PayloadPaths
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# what-to-eat ECS deployment bundle SHA-256 manifest v1')
    $lines.Add('# Hashes cover every payload file; paths are repository-independent.')
    foreach ($relative in @(Get-OrdinalSortedStrings -Values $PayloadPaths)) {
        $path = Join-Path -Path $BundleRoot -ChildPath (
            ConvertTo-NativeRelativePath -Path $relative
        )
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $lines.Add("$hash  $relative")
    }

    $content = ($lines.ToArray() -join "`n") + "`n"
    $encoding = New-Object System.Text.ASCIIEncoding
    [System.IO.File]::WriteAllText(
        (Join-Path -Path $BundleRoot -ChildPath $script:ManifestName),
        $content,
        $encoding
    )
}

function Assert-EcsOperationalGates {
    param([Parameter(Mandatory = $true)][string]$BundleRoot)

    $compose = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'compose.yml')
    )
    $deploymentExample = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'deployment.env.example')
    )
    if ([System.Text.RegularExpressions.Regex]::Matches(
            $compose,
            '(?m)^\s*pull_policy:\s+never\s*$'
         ).Count -ne 4 -or
        -not $compose.Contains('POSTGRES_VOLUME_NAME') -or
        -not $compose.Contains('external: true') -or
        -not $compose.Contains('SMTP_TIMEOUT_MS: "5000"') -or
        -not $compose.Contains('GROUP_RECOMMENDATIONS_ENABLED: "${GROUP_RECOMMENDATIONS_ENABLED:-false}"') -or
        -not $compose.Contains('WECHAT_OPEN_PLATFORM_REALM_ID: "${WECHAT_OPEN_PLATFORM_REALM_ID:?WECHAT_OPEN_PLATFORM_REALM_ID is required}"') -or
        -not $compose.Contains('QQ_OPEN_PLATFORM_REALM_ID: "${QQ_OPEN_PLATFORM_REALM_ID:?QQ_OPEN_PLATFORM_REALM_ID is required}"') -or
        -not $compose.Contains('cap_drop:')) {
        throw 'ECS Compose is missing offline image, protected volume or capability gates.'
    }
    $groupFeatureAssignments = [System.Text.RegularExpressions.Regex]::Matches(
        $deploymentExample,
        '(?m)^GROUP_RECOMMENDATIONS_ENABLED=(?<enabled>true|false)$'
    )
    if ($groupFeatureAssignments.Count -ne 1 -or
        $groupFeatureAssignments[0].Groups['enabled'].Value -cne 'false') {
        throw 'Deployment example must define the group recommendation capability exactly once and keep it disabled by default.'
    }
    $realmAssignments = [System.Text.RegularExpressions.Regex]::Matches(
        $deploymentExample,
        '(?m)^WECHAT_OPEN_PLATFORM_REALM_ID=(?<realm>[^\r\n]+)$'
    )
    if ($realmAssignments.Count -ne 1 -or
        $realmAssignments[0].Groups['realm'].Value -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
        -not $deploymentExample.Contains('wechat_union_aliases_pending')) {
        throw 'Deployment example must define one stable WeChat Open Platform realm and document the Union alias bridge mode.'
    }
    $qqRealmAssignments = [System.Text.RegularExpressions.Regex]::Matches(
        $deploymentExample,
        '(?m)^QQ_OPEN_PLATFORM_REALM_ID=(?<realm>[^\r\n]+)$'
    )
    if ($qqRealmAssignments.Count -ne 1 -or
        $qqRealmAssignments[0].Groups['realm'].Value -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$') {
        throw 'Deployment example must define one stable QQ Open Platform realm.'
    }
    if ($deploymentExample -match '(?m)^QQ_UNION_ID_NAMESPACE_INITIALIZED=' -or
        $compose.Contains('QQ_UNION_ID_NAMESPACE_INITIALIZED')) {
        throw 'QQ UnionID namespace state must live only in the shared identity-state file, not deployment.env or Compose.'
    }

    $scriptsRoot = Join-Path -Path $BundleRoot -ChildPath 'scripts'
    foreach ($scriptFile in @(Get-ChildItem -LiteralPath $scriptsRoot -Filter '*.sh' -File)) {
        $text = [System.IO.File]::ReadAllText($scriptFile.FullName)
        if ($text.Contains("`r")) {
            throw "ECS shell script must use LF line endings: $($scriptFile.Name)"
        }
        if (-not $text.StartsWith("#!/usr/bin/env bash`n", [System.StringComparison]::Ordinal)) {
            throw "ECS shell script has an invalid interpreter line: $($scriptFile.Name)"
        }
        if ($text -notmatch '(?m)^set -Eeuo pipefail$' -or
            $text -notmatch '(?m)^umask 077$') {
            throw "ECS shell script must enable strict mode and a root-only umask: $($scriptFile.Name)"
        }
        foreach ($forbidden in @(
            '(?im)\bdocker\s+compose\b[^\r\n]*\bdown\b[^\r\n]*\s-v(?:\s|$)',
            '(?im)\bdocker\s+volume\s+(?:rm|prune)\b',
            '(?im)\bdocker\s+(?:system|image|builder)\s+prune\b',
            '(?im)^\s*set\s+[+-]x\s*$',
            '(?im)\bcurl\b[^\r\n]*--insecure\b',
            '(?im)\bfind\b[^\r\n]*-delete\b'
        )) {
            if ($text -match $forbidden) {
                throw "ECS shell script violates a destructive or secret-safety gate: $($scriptFile.Name)"
            }
        }
    }

    $apiVhost = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'nginx/api.unfinished-era.com.conf')
    )
    foreach ($required in @(
        'server_name api.unfinished-era.com;',
        'location = /health',
        'location = /health/ready',
        'location = /v1',
        'location ^~ /v1/',
        'proxy_pass http://127.0.0.1:__API_LOOPBACK_PORT__;',
        'return 404'
    )) {
        if (-not $apiVhost.Contains($required)) {
            throw "Dedicated API vhost is missing a route boundary: $required"
        }
    }
    $apiVhostWithoutComments = [System.Text.RegularExpressions.Regex]::Replace(
        $apiVhost,
        '(?m)#.*$',
        ''
    )
    $apiServerNames = @([System.Text.RegularExpressions.Regex]::Matches(
            $apiVhostWithoutComments,
            '(?is)\bserver_name\s+(?<names>[^;]+);'
        ) | ForEach-Object {
            $_.Groups['names'].Value -split '\s+' | Where-Object { $_ -ne '' }
        })
    if ($apiServerNames -contains 'www.unfinished-era.com' -or
        $apiServerNames -contains 'unfinished-era.com' -or
        $apiVhost -match '(?s)location\s+/\s*\{[^}]*proxy_pass') {
        throw 'Dedicated API vhost must not claim the website domain or proxy its root.'
    }

    $apiAcmeVhost = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'nginx/api.unfinished-era.com.acme.conf')
    )
    foreach ($required in @(
        'server_name api.unfinished-era.com;',
        'include /www/server/panel/vhost/nginx/well-known/api.unfinished-era.com.conf;',
        'return 404'
    )) {
        if (-not $apiAcmeVhost.Contains($required)) {
            throw "Dedicated API ACME vhost is missing a boundary: $required"
        }
    }
    $apiAcmeWithoutComments = [System.Text.RegularExpressions.Regex]::Replace(
        $apiAcmeVhost,
        '(?m)#.*$',
        ''
    )
    $apiAcmeServerNames = @([System.Text.RegularExpressions.Regex]::Matches(
            $apiAcmeWithoutComments,
            '(?is)\bserver_name\s+(?<names>[^;]+);'
        ) | ForEach-Object {
            $_.Groups['names'].Value -split '\s+' | Where-Object { $_ -ne '' }
        })
    if ($apiAcmeVhost -match '(?i)proxy_pass' -or
        $apiAcmeVhost -match '(?m)^\s*listen\s+443\b' -or
        $apiAcmeServerNames -contains 'www.unfinished-era.com' -or
        $apiAcmeServerNames -contains 'unfinished-era.com') {
        throw 'Dedicated API ACME vhost must be HTTP-only, must not proxy, and must not claim the website domain.'
    }

    $apiWellKnown = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'nginx/api.unfinished-era.com.well-known.conf')
    )
    foreach ($required in @(
        'location ^~ /.well-known/acme-challenge/',
        'root /opt/chi-shen-me/acme-webroot;',
        'try_files $uri =404;'
    )) {
        if (-not $apiWellKnown.Contains($required)) {
            throw "Dedicated API ACME include is missing a boundary: $required"
        }
    }
    if ($apiWellKnown -match '(?i)proxy_pass' -or
        $apiWellKnown -match '(?i)/admin/v1' -or
        $apiWellKnown -match '(?m)^\s*server\s*\{') {
        throw 'Dedicated API ACME include must expose only static challenge files.'
    }

    $legacyNginxActivation = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/activate-baota-nginx.sh')
    )
    $expectedLegacyNginxActivation = (@(
            '#!/usr/bin/env bash',
            '',
            'set -Eeuo pipefail',
            'umask 077',
            '',
            'printf ''LEGACY_MAIN_VHOST_ACTIVATION_DISABLED=true\n'' >&2',
            'printf ''This retired command can never modify www.unfinished-era.com. Use activate-api-subdomain-nginx.sh after dedicated API TLS is ready.\n'' >&2',
            'exit 64',
            ''
        ) -join "`n")
    if ($legacyNginxActivation -cne $expectedLegacyNginxActivation) {
        throw 'Retired main-site Nginx activation must remain an unconditional fail-closed tombstone.'
    }

    $apiNginxActivation = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/activate-api-subdomain-nginx.sh')
    )
    foreach ($required in @(
        'api_vhost="$vhost_directory/api.unfinished-era.com.conf"',
        'wordpress_vhost="$vhost_directory/www.unfinished-era.com.conf"',
        '[[ "$api_loopback_port" == ''13001'' ]]',
        'installed API ACME include differs from the reviewed release template',
        'lock_file="$lock_directory/public-nginx.lock"',
        'flock -n 9',
        'openssl x509 -in "$certificate" -noout -checkend 604800',
        'openssl s_client -connect 127.0.0.1:443 -servername api.unfinished-era.com',
        'proxy_pass http://127.0.0.1:13001;',
        '"$nginx" -t -q -p /www/server/nginx/ -c "$isolated_config"',
        'mv -Tf -- "$candidate" "$api_vhost"',
        '--resolve api.unfinished-era.com:80:127.0.0.1',
        '--resolve api.unfinished-era.com:443:127.0.0.1',
        'https://api.unfinished-era.com/admin/v1',
        'api.unfinished-era.com is claimed by an unexpected or duplicate vhost',
        'API vhost installation changed public hostname ownership',
        'wordpress_unchanged',
        'rollback_api_vhost',
        'NGINX_API_SUBDOMAIN_ROLLBACK=OK',
        'WORDPRESS_VHOST_UNCHANGED=true',
        'ADMIN_ENDPOINT_PUBLIC=false'
    )) {
        if (-not $apiNginxActivation.Contains($required)) {
            throw "Dedicated API Nginx activation is missing a safety gate: $required"
        }
    }
    if ($apiNginxActivation -match '(?im)^\s*(?:cp|install|mv|rm|sed)\b[^\r\n]*\$wordpress_vhost' -or
        $apiNginxActivation -match '(?i)--insecure' -or
        $apiNginxActivation -match '(?i)https?://www\.unfinished-era\.com') {
        throw 'Dedicated API Nginx activation must never mutate or publish through the WordPress vhost.'
    }

    $certificateReload = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/reload-nginx-after-certificate-renewal.sh')
    )
    foreach ($required in @(
        'lock_file="$lock_directory/public-nginx.lock"',
        'flock -n 9',
        'openssl x509 -in "$certificate" -noout -checkend 604800',
        'openssl s_client -connect 127.0.0.1:443 -servername api.unfinished-era.com',
        'active API vhost has the wrong upstream',
        '"$nginx" -t >/dev/null',
        '"$nginx" -s reload >/dev/null',
        '--resolve api.unfinished-era.com:443:127.0.0.1',
        'API_VHOST_UNCHANGED=true',
        'WORDPRESS_VHOST_UNCHANGED=true'
    )) {
        if (-not $certificateReload.Contains($required)) {
            throw "API certificate reload hook is missing a safety gate: $required"
        }
    }
    if ($certificateReload -match '(?i)systemctl' -or
        $certificateReload -match '(?i)--insecure' -or
        $certificateReload -match '(?im)^\s*(?:cp|install|mv|rm|sed)\b[^\r\n]*(?:\$api_vhost|\$wordpress_vhost)') {
        throw 'API certificate reload hook must validate and reload without mutating either vhost.'
    }

    $backup = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/backup-database.sh')
    )
    $verifyBackup = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/verify-database-backup.sh')
    )
    $phoneOnlyBridgeRuntime = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/assert-phone-only-bridge-runtime.sh')
    )
    $wechatUnionAliasesBridgeRuntime = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/assert-wechat-union-aliases-bridge-runtime.sh')
    )
    $runtimeVerifier = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/verify-runtime.sh')
    )
    $provision = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/provision-database.sh')
    )
    $restore = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/restore-database.sh')
    )
    $rollback = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/rollback-database.sh')
    )
    $amap = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/update-amap-secrets.sh')
    )
    $auth = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/update-auth-secrets.sh')
    )
    $preflight = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/preflight-deployment.sh')
    )
    $permissionHardener = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/harden-release-permissions.sh')
    )
    $releaseActivation = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/activate-candidate-release.sh')
    )
    foreach ($required in @(
        "current_link='/opt/chi-shen-me/current'",
        'AUTH_SCHEMA_TRANSITION_MODE=legacy_phone_drain',
        'ACCOUNTS_ENABLED PHONE_AUTH_ENABLED EMAIL_AUTH_ENABLED WECHAT_AUTH_ENABLED',
        'QQ_AUTH_ENABLED QQ_UNION_ID_ENABLED',
        "docker inspect --format '{{.Image}}'",
        'active bridge API container image differs from deployment.env',
        'active bridge API container environment mismatch'
    )) {
        if (-not $phoneOnlyBridgeRuntime.Contains($required)) {
            throw "Phone-only bridge runtime assertion is missing a safety gate: $required"
        }
    }
    foreach ($required in @(
        "current_link='/opt/chi-shen-me/current'",
        'AUTH_SCHEMA_TRANSITION_MODE)" == ''wechat_union_aliases_pending''',
        'WECHAT_AUTH_ENABLED)" == ''false''',
        "docker inspect --format '{{.Image}}'",
        'active bridge API container image differs from deployment.env',
        'AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending',
        'WECHAT_AUTH_ENABLED=false',
        'active bridge API container environment mismatch',
        '"$script_dir/verify-runtime.sh" >/dev/null',
        'WECHAT_UNION_ALIASES_BRIDGE_RUNTIME=OK'
    )) {
        if (-not $wechatUnionAliasesBridgeRuntime.Contains($required)) {
            throw "WeChat Union alias bridge runtime assertion is missing a safety gate: $required"
        }
    }
    foreach ($required in @(
        'AUTH_SCHEMA_TRANSITION_MODE',
        'SHARED_STATE_DIRECTORY',
        'WECHAT_OPEN_PLATFORM_REALM_ID',
        'QQ_OPEN_PLATFORM_REALM_ID',
        'auth-identity-state.env',
        'AUTH_IDENTITY_STATE_FORMAT_VERSION',
        'QQ_UNION_ID_NAMESPACE_INITIALIZED',
        'shared QQ identity state must be a root-only regular file',
        'shared QQ identity state must contain exactly three settings',
        'shared QQ identity realm differs from deployment.env',
        'QQ authentication requires initialized shared identity state',
        'wechat_union_aliases_pending requires WECHAT_AUTH_ENABLED=false',
        'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled',
        'assert_api_container_env "AUTH_SCHEMA_TRANSITION_MODE=$expected_schema_transition_mode"',
        'assert_api_container_env "WECHAT_OPEN_PLATFORM_REALM_ID=$expected_wechat_realm_id"',
        'assert_api_container_env "WECHAT_AUTH_ENABLED=$expected_wechat_enabled"',
        'assert_api_container_env "QQ_OPEN_PLATFORM_REALM_ID=$expected_qq_realm_id"',
        'assert_api_container_env "QQ_AUTH_ENABLED=$expected_qq_enabled"',
        'assert_api_container_env "QQ_UNION_ID_ENABLED=$expected_qq_union_id_enabled"',
        'public authentication capabilities do not match deployment.env'
    )) {
        if (-not $runtimeVerifier.Contains($required)) {
            throw "Runtime verifier is missing an authentication identity-continuity gate: $required"
        }
    }
    if (-not $backup.Contains("backup_root='/opt/chi-shen-me/backups/postgres'") -or
        -not $backup.Contains('--format=custom') -or
        -not $backup.Contains('pg_restore --list') -or
        -not $backup.Contains('sha256sum --check --strict') -or
        -not $backup.Contains('database backups must run from the active release') -or
        -not $backup.Contains('SCHEMA_MIGRATIONS.txt') -or
        -not $backup.Contains('ROLE_GRANTS.sql') -or
        -not $backup.Contains('phone_only_cutover_facts=') -or
        -not $backup.Contains("clock_timestamp() - interval '15 minutes'") -or
        -not $backup.Contains('mutation_lock="$lock_directory/mutation.lock"') -or
        -not $backup.Contains("if [[ `"`$mutation_lock_inherited`" == 'true' ]]") -or
        -not $backup.Contains('readlink -f -- "/proc/$$/fd/8"') -or
        -not $backup.Contains('flock -n 8')) {
        throw 'PostgreSQL backup script is missing its exact path, custom dump or integrity gates.'
    }
    foreach ($required in @(
        'SCHEMA_MIGRATIONS.txt',
        'ROLE_GRANTS.sql',
        'actual_file_count',
        'actual_entry_count',
        'backup checksum manifest must contain exactly five entries',
        'backup migration ledger count differs from metadata',
        'backup role-grant snapshot is invalid',
        'cmp -s "$generated_list" "$backup_dir/RESTORE_LIST.txt"'
    )) {
        if (-not $verifyBackup.Contains($required)) {
            throw "PostgreSQL backup verifier is missing a schema/ACL integrity gate: $required"
        }
    }
    foreach ($required in @(
        "lock_directory='/run/lock/chi-shen-me'",
        'mutation_lock="$lock_directory/mutation.lock"',
        "'700:0:0'",
        "'600:0:0'",
        'exec 8<>"$mutation_lock"',
        "flock -n 8 || die 'another deployment mutation, backup or secret update is running'"
    )) {
        if (-not $provision.Contains($required)) {
            throw "Database provisioner is missing its global mutation lock gate: $required"
        }
    }
    $provisionLock = 'flock -n 8 || die'
    $provisionPreflight = '"$script_dir/preflight-deployment.sh" >/dev/null'
    $provisionDatabaseStart = 'docker compose --env-file deployment.env up -d postgres'
    if ([regex]::Matches($provision, [regex]::Escape($provisionLock)).Count -ne 1 -or
        $provision.IndexOf($provisionLock, [System.StringComparison]::Ordinal) -gt
            $provision.IndexOf($provisionPreflight, [System.StringComparison]::Ordinal) -or
        $provision.IndexOf($provisionPreflight, [System.StringComparison]::Ordinal) -gt
            $provision.IndexOf($provisionDatabaseStart, [System.StringComparison]::Ordinal)) {
        throw 'Database provisioner must reject a concurrent deployment mutation before preflight or database work.'
    }
    if (-not $restore.Contains('chi_shen_me_restore_') -or
        -not $restore.Contains('--single-transaction') -or
        -not $restore.Contains('--role=schema_migrator') -or
        -not $restore.Contains('mutation_lock="$lock_directory/mutation.lock"') -or
        -not $restore.Contains('restore_lock="$lock_directory/postgres-restore.lock"') -or
        -not $restore.Contains('readlink -f -- "/proc/$$/fd/8"') -or
        -not $restore.Contains("flock -n 8 || die 'another deployment mutation, backup or secret update is running'")) {
        throw 'PostgreSQL restore script is missing its isolated target or transactional role gates.'
    }
    if (-not $rollback.Contains('ROLLBACK_chi_shen_me_FROM_') -or
        -not $rollback.Contains('PRESERVED_PREVIOUS_DATABASE') -or
        -not $rollback.Contains('mutation_lock="$lock_directory/mutation.lock"') -or
        -not $rollback.Contains('rollback_lock="$lock_directory/postgres-rollback.lock"') -or
        -not $rollback.Contains("flock -n 8 || die 'another deployment mutation, backup or secret update is running'") -or
        -not $rollback.Contains('backup-database.sh" --mutation-lock-held') -or
        -not $rollback.Contains('restore-database.sh" "$backup_dir" "$restore_database" --mutation-lock-held') -or
        -not $rollback.Contains('assert-phone-only-bridge-runtime.sh" >/dev/null') -or
        -not $rollback.Contains('assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null') -or
        $rollback -match '(?im)\bDROP\s+DATABASE\b') {
        throw 'PostgreSQL rollback must require confirmation and preserve the previous database.'
    }
    if (-not $provision.Contains('assert-phone-only-bridge-runtime.sh" >/dev/null') -or
        $provision.IndexOf('assert-phone-only-bridge-runtime.sh" >/dev/null', [System.StringComparison]::Ordinal) -gt
            $provision.IndexOf('backup-database.sh" --mutation-lock-held', [System.StringComparison]::Ordinal) -or
        $rollback.IndexOf('assert-phone-only-bridge-runtime.sh" >/dev/null', [System.StringComparison]::Ordinal) -gt
            $rollback.IndexOf('backup-database.sh" --mutation-lock-held', [System.StringComparison]::Ordinal)) {
        throw 'Provision and rollback must verify the active bridge container before any safety backup or mutation.'
    }
    if (-not $provision.Contains('assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null') -or
        $provision.IndexOf('assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null', [System.StringComparison]::Ordinal) -gt
            $provision.IndexOf('wechat_union_aliases_cutover_backup="$(sed', [System.StringComparison]::Ordinal) -or
        $rollback.IndexOf('assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null', [System.StringComparison]::Ordinal) -gt
            $rollback.IndexOf('backup-database.sh" --mutation-lock-held', [System.StringComparison]::Ordinal)) {
        throw 'Schema 0012 cutover and rollback must verify the active WeChat Union alias bridge before backup or mutation.'
    }
    foreach ($required in @(
        '--phone-only-cutover',
        "'10|1|10|fusion_phone_auth'",
        'backup-database.sh" --mutation-lock-held',
        'verify-database-backup.sh" "$phone_only_cutover_backup"',
        'SCHEMA_MIGRATIONS.txt',
        'cat "$bundle_root/sql/role-grants.sql"',
        "clock_timestamp() - interval '15 minutes'",
        'legacy authentication proof state changed after the cutover backup'
    )) {
        if (-not $provision.Contains($required)) {
            throw "PHONE_ONLY provisioner is missing a cutover safety gate: $required"
        }
    }
    if ([regex]::Matches(
            $provision,
            [regex]::Escape('read_active_auth_proof_count)')
        ).Count -lt 2) {
        throw 'PHONE_ONLY provisioner must check redeemable proofs both before and after its verified backup.'
    }
    foreach ($required in @(
        '--wechat-union-aliases-cutover',
        'schema 0011 requires explicit --wechat-union-aliases-cutover',
        "'11|1|11|phone_only_auth'",
        'WeChat Union alias cutover backup was not produced by the active bridge',
        'WeChat Union alias cutover backup migration ledger does not have 11 rows',
        '^11\|phone_only_auth\|[0-9a-f]{64}$',
        "'12|1|12|wechat_union_aliases'",
        'WeChat Union alias cutover did not reach exact schema 0012',
        "to_regclass('public.wechat_union_aliases') IS NOT NULL",
        "to_regprocedure('public.consume_oauth_state_with_wechat_union",
        "to_regprocedure('public.record_wechat_union_alias_from_consumed_state",
        "to_regprocedure('public.bind_oauth_identity_with_wechat_union_from_consumed_state",
        "NOT has_table_privilege('api_runtime', 'public.wechat_union_aliases'",
        "NOT has_table_privilege('retention_worker', 'public.wechat_union_aliases'",
        "NOT has_table_privilege('admin_api_runtime', 'public.wechat_union_aliases'",
        "NOT has_table_privilege('data_export_worker', 'public.wechat_union_aliases'",
        "WHERE privilege.grantee = 0",
        "WHERE NOT routine.prosecdef",
        "routine.proowner <> 'schema_migrator'::regrole",
        "'search_path=pg_catalog, public' = ANY(routine.proconfig)",
        "NOT has_function_privilege('api_runtime', routine.oid, 'EXECUTE')",
        "has_function_privilege('retention_worker', routine.oid, 'EXECUTE')",
        "has_function_privilege('admin_api_runtime', routine.oid, 'EXECUTE')",
        "has_function_privilege('data_export_worker', routine.oid, 'EXECUTE')",
        'privilege.grantee = 0',
        "privilege.privilege_type = 'EXECUTE'",
        'NOT EXISTS (SELECT 1 FROM public.wechat_union_aliases)',
        'WeChat Union alias schema or least-privilege ACL verification failed',
        'WECHAT_UNION_ALIASES_CUTOVER_BACKUP=%s'
    )) {
        if (-not $provision.Contains($required)) {
            throw "WeChat Union alias provisioner is missing a schema 0011 to 0012 cutover or ACL gate: $required"
        }
    }
    foreach ($required in @(
        'rollback-database.sh [--wechat-union-aliases]',
        "rollback_kind='wechat-union-aliases'",
        'WeChat Union alias rollback backup was not produced by the active bridge',
        'WeChat Union alias rollback requires an exact schema 0011 backup',
        'WeChat Union alias rollback backup ledger does not have 11 rows',
        '^11\|phone_only_auth\|[0-9a-f]{64}$',
        "count(*) = 12 AND min(version) = 1 AND max(version) = 12",
        "bool_or(version = 12 AND name = 'wechat_union_aliases')",
        "to_regclass('public.wechat_union_aliases') IS NOT NULL",
        'NOT EXISTS (SELECT 1 FROM public.wechat_union_aliases)',
        'schema 0012 downgrade is forbidden after any WeChat Union alias was stored'
    )) {
        if (-not $rollback.Contains($required)) {
            throw "PostgreSQL rollback is missing a schema 0012 to 0011 Union alias safety gate: $required"
        }
    }
    foreach ($required in @(
        'cat "$backup_dir/ROLE_GRANTS.sql"',
        'cmp -s "$restored_ledger" "$backup_dir/SCHEMA_MIGRATIONS.txt"'
    )) {
        if (-not $restore.Contains($required)) {
            throw "PostgreSQL restore is missing a schema-matched ACL or ledger gate: $required"
        }
    }
    $restoreGlobalLock = 'exec 8<>"$mutation_lock"'
    $restorePreflight = '"$script_dir/preflight-deployment.sh" >/dev/null'
    $restoreCreate = 'CREATE DATABASE :"target"'
    if ($restore.IndexOf($restoreGlobalLock, [System.StringComparison]::Ordinal) -lt 0 -or
        $restore.IndexOf($restoreGlobalLock, [System.StringComparison]::Ordinal) -gt
            $restore.IndexOf($restorePreflight, [System.StringComparison]::Ordinal) -or
        $restore.IndexOf($restorePreflight, [System.StringComparison]::Ordinal) -gt
            $restore.IndexOf($restoreCreate, [System.StringComparison]::Ordinal)) {
        throw 'PostgreSQL restore must hold the global mutation lock before preflight and database creation.'
    }
    $rollbackGlobalLock = 'exec 8<>"$mutation_lock"'
    $rollbackPreflight = '"$script_dir/preflight-deployment.sh" >/dev/null'
    $rollbackSafetyBackup = 'backup-database.sh" --mutation-lock-held'
    if ($rollback.IndexOf($rollbackGlobalLock, [System.StringComparison]::Ordinal) -lt 0 -or
        $rollback.IndexOf($rollbackGlobalLock, [System.StringComparison]::Ordinal) -gt
            $rollback.IndexOf($rollbackPreflight, [System.StringComparison]::Ordinal) -or
        $rollback.IndexOf($rollbackPreflight, [System.StringComparison]::Ordinal) -gt
            $rollback.IndexOf($rollbackSafetyBackup, [System.StringComparison]::Ordinal)) {
        throw 'PostgreSQL rollback must hold the global mutation lock across backup, restore and activation.'
    }
    if (-not $amap.Contains('--ip-whitelist-confirmed') -or
        -not $amap.Contains('API_RECREATE_REQUIRED=true') -or
        -not $amap.Contains('updated AMap configuration failed preflight and was rolled back') -or
        -not $amap.Contains('mutation_lock="$lock_directory/mutation.lock"') -or
        -not $amap.Contains('flock -n 8')) {
        throw 'AMap secret updater is missing its whitelist, recreate or rollback gate.'
    }
    foreach ($required in @(
        'update-auth-secrets.sh --apply --config-file FILE',
        'update-auth-secrets.sh --disable',
        'update-auth-secrets.sh --legacy-drain',
        'mutation_lock="$lock_directory/mutation.lock"',
        'flock -n 8',
        'updated authentication configuration failed preflight and was rolled back',
        "target_schema_transition_mode='legacy_phone_drain'",
        'legacy bridge must preserve the shared api.env byte-for-byte',
        'SHARED_API_ENV_PRESERVED=true',
        'assert_phone_only_cutover_ready',
        'assert_wechat_union_aliases_ready',
        'resolve_active_deploy',
        'active_deploy="$(resolve_active_deploy)"',
        '[[ "$active_deploy" != "$bundle_root" ]]',
        'authentication changes must be prepared in a non-active candidate release',
        'if [[ "$mode" != ''--legacy-drain'' ]]; then',
        "current_link='/opt/chi-shen-me/current'",
        'legacy Fusion, SMS and associated WeChat configuration can only be retired from the active legacy phone drain bridge',
        'phone-only migration and least-privilege ACL smoke must pass before updating authentication configuration',
        'preview_fusion_auth_retention_cleanup',
        "baseline_identity_config_present='true'",
        'const retiresLegacyPhone = [',
        'AUTH_IDENTITY_DEDUP_KEY_VERSION changes require a dedicated audited migration',
        'emergency disable must preserve authentication identity/session continuity',
        'emergency disable must preserve email OTP continuity',
        'identity_continuity_names=(',
        'otp_continuity_names=(',
        'reenabling disabled accounts must preserve authentication identity/session continuity',
        'disabling email authentication must preserve email OTP continuity',
        'PHONE_ONLY accounts require PHONE_AUTH_ENABLED=true',
        'QQ_UNION_ID_ENABLED requires QQ_AUTH_ENABLED=true',
        "shared_state_directory='/opt/chi-shen-me/shared'",
        'qq_identity_state_file="$shared_state_directory/auth-identity-state.env"',
        'assert_root_directory "$shared_state_directory" 700',
        'assert_qq_identity_state_change_ready',
        'persist_qq_identity_state',
        'candidate="$(mktemp "$shared_state_directory/.auth-identity-state.candidate.XXXXXX")"',
        'AUTH_IDENTITY_STATE_FORMAT_VERSION=1',
        'printf ''QQ_OPEN_PLATFORM_REALM_ID=%s\n''',
        'printf ''QQ_UNION_ID_NAMESPACE_INITIALIZED=%s\n''',
        'chown root:root "$candidate"',
        'chmod 600 "$candidate"',
        'mv -Tf -- "$candidate" "$qq_identity_state_file"',
        'assert_exact_env_keys "$qq_identity_state_file"',
        'QQ_BINDING_COUNT_BEFORE_IDENTITY_STATE_CHANGE=',
        "SELECT count(*) FROM public.identity_bindings WHERE identity_type = 'QQ';",
        'QQ identity state initialization or UnionID promotion requires the active QQ channel to be disabled',
        'QQ identity state initialization or UnionID promotion requires zero existing QQ bindings',
        'active QQ authentication state is missing its shared identity anchor',
        'candidate release differs from the shared QQ Open Platform realm',
        'candidate release must preserve the active WeChat Open Platform realm',
        'candidate release must preserve the active QQ Open Platform realm',
        'active release has a duplicate QQ Open Platform realm',
        'QQ identity state requires a stable candidate Open Platform realm',
        'active_qq_auth_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_AUTH_ENABLED)"',
        'active_qq_union_id_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_UNION_ID_ENABLED)"',
        'shared QQ identity state has an unsupported format version',
        'target_qq_union_id_namespace_initialized="$current_qq_union_id_namespace_initialized"',
        'target_qq_union_id_namespace_initialized="$target_qq_union_id_enabled"',
        "target_qq_union_id_namespace_initialized='true'",
        'sync -f "$shared_state_directory"',
        'A shared QQ identity-state initialization',
        'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled',
        'AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON',
        'ALIYUN_PNVS_SIGN_NAME ALIYUN_PNVS_TEMPLATE_CODE',
        'if [[ "$target_email_auth_enabled" == ''true'' ]]; then',
        'SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USERNAME SMTP_APP_PASSWORD',
        'SMTP_FROM_ADDRESS SMTP_REPLY_TO SMTP_FROM_NAME',
        '!/^SMTP_APP_PASSWORD=/',
        'read_env_value "$config_file" SMTP_APP_PASSWORD',
        'printf ''SMTP_PASSWORD=%s\n''',
        '"$target_email_auth_enabled" == ''false'' && "$baseline_otp_count" -eq "${#otp_continuity_names[@]}"',
        'if [[ "$target_wechat_auth_enabled" == ''true'' ]]; then',
        'input_names+=(WECHAT_APP_ID WECHAT_APP_SECRET)',
        'if [[ "$target_qq_auth_enabled" == ''true'' ]]; then',
        'input_names+=(QQ_APP_ID QQ_APP_KEY)',
        'activate the final schema 0012 release before updating authentication configuration',
        'WeChat authentication requires the final non-transition schema 0012 release',
        'active_realm="$(read_env_value "$active_deploy/deployment.env" WECHAT_OPEN_PLATFORM_REALM_ID)"',
        'WeChat authentication requires a stable Open Platform realm',
        '-v expected_wechat_realm="$1"',
        "WHERE realm_id <> :'expected_wechat_realm'",
        "count(*) = 12 AND min(version) = 1 AND max(version) = 12",
        "bool_or(version = 12 AND name = 'wechat_union_aliases')",
        "to_regclass('public.wechat_union_aliases') IS NOT NULL",
        "has_function_privilege(",
        "'public.consume_oauth_state_with_wechat_union",
        "'public.record_wechat_union_alias_from_consumed_state",
        "'public.bind_oauth_identity_with_wechat_union_from_consumed_state",
        "NOT has_table_privilege(",
        "WHERE NOT routine.prosecdef",
        "routine.proowner <> 'schema_migrator'::regrole",
        "'search_path=pg_catalog, public' = ANY(routine.proconfig)",
        "NOT has_function_privilege('api_runtime', routine.oid, 'EXECUTE')",
        "has_function_privilege('retention_worker', routine.oid, 'EXECUTE')",
        "has_function_privilege('admin_api_runtime', routine.oid, 'EXECUTE')",
        "has_function_privilege('data_export_worker', routine.oid, 'EXECUTE')",
        'privilege.grantee = 0',
        "privilege.privilege_type = 'EXECUTE'",
        'schema 0012 and WeChat Union alias least-privilege ACL smoke must pass before enabling WeChat',
        'API_RECREATE_REQUIRED=true'
    )) {
        if (-not $auth.Contains($required)) {
            throw "Authentication secret updater is missing a safety gate: $required"
        }
    }
    if ($auth.Contains('[[ "$active_deploy" == "$bundle_root" ]]') -or
        $auth.Contains('WeChat authentication must be enabled from the active immutable release') -or
        $auth.Contains('QQ identity state must be changed from the active immutable release') -or
        [regex]::IsMatch(
            $auth,
            'assert_qq_identity_state_change_ready\s+\\\s*\n\s*"\$current_qq_auth_enabled"'
        )) {
        throw 'Authentication updates must validate the active release without writing its deployment bundle.'
    }
    if ([regex]::IsMatch($auth, '(?m)\[\[[^\r\n]*==[ \t]*\r?\n')) {
        throw 'Authentication updater contains a split conditional comparison that Bash cannot parse.'
    }
    $authWeChatReadiness = [regex]::Match(
        $auth,
        '(?s)assert_wechat_union_aliases_ready\(\) \{(?<body>.*?)\n\}'
    )
    if (-not $authWeChatReadiness.Success -or
        -not $authWeChatReadiness.Groups['body'].Value.Contains(
            'candidate release must preserve the active WeChat Open Platform realm'
        ) -or
        -not $authWeChatReadiness.Groups['body'].Value.Contains('cd "$active_deploy"')) {
        throw 'WeChat readiness must inspect active schema/runtime state while preserving the candidate realm.'
    }
    $authQqReadiness = [regex]::Match(
        $auth,
        '(?s)assert_qq_identity_state_change_ready\(\) \{(?<body>.*?)\n\}'
    )
    $authQqReadinessBody = $authQqReadiness.Groups['body'].Value
    $authQqActiveSwitchRead = 'active_qq_auth_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_AUTH_ENABLED)"'
    $authQqActiveUnionRead = 'active_qq_union_id_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_UNION_ID_ENABLED)"'
    $authQqBindingQuery = "SELECT count(*) FROM public.identity_bindings WHERE identity_type = 'QQ';"
    if (-not $authQqReadiness.Success -or
        -not $authQqReadiness.Groups['body'].Value.Contains(
            $authQqActiveSwitchRead
        ) -or
        -not $authQqReadiness.Groups['body'].Value.Contains(
            $authQqActiveUnionRead
        ) -or
        -not $authQqReadiness.Groups['body'].Value.Contains(
            'candidate release must preserve the active QQ Open Platform realm'
        ) -or
        -not $authQqReadiness.Groups['body'].Value.Contains(
            'grep -E ''^QQ_OPEN_PLATFORM_REALM_ID='' "$active_deploy/deployment.env" || true'
        ) -or
        -not $authQqReadiness.Groups['body'].Value.Contains('cd "$active_deploy"') -or
        $authQqReadiness.Groups['body'].Value.Contains('$current_qq_auth_enabled') -or
        $authQqReadiness.Groups['body'].Value.Contains('$current_qq_union_id_enabled') -or
        $authQqReadinessBody.IndexOf($authQqActiveSwitchRead, [System.StringComparison]::Ordinal) -gt
            $authQqReadinessBody.IndexOf($authQqBindingQuery, [System.StringComparison]::Ordinal) -or
        $authQqReadinessBody.IndexOf($authQqActiveUnionRead, [System.StringComparison]::Ordinal) -gt
            $authQqReadinessBody.IndexOf($authQqBindingQuery, [System.StringComparison]::Ordinal)) {
        throw 'QQ identity-state changes must prove the active release is disabled and query its database without trusting candidate switches.'
    }
    if ($auth.Contains('EMAIL_OTP_PEPPER_')) {
        throw 'Authentication secret updater must reject the retired EMAIL_OTP_PEPPER_* field names.'
    }
    $authDeploymentCandidateBlock = [regex]::Match(
        $auth,
        '(?s)awk ''\s+!/\^AUTH_SCHEMA_TRANSITION_MODE=/.*?\} >>"\$deployment_candidate"'
    )
    if (-not $authDeploymentCandidateBlock.Success -or
        $authDeploymentCandidateBlock.Groups[0].Value.Contains(
            'QQ_UNION_ID_NAMESPACE_INITIALIZED'
        )) {
        throw 'Authentication updater must never copy the shared QQ marker into deployment.env.'
    }
    $authCutoverGate = 'assert_phone_only_cutover_ready "$retires_legacy_auth_configuration"'
    $authApiCandidate = 'api_candidate="$(mktemp'
    $authApiReplacement = 'mv -f -- "$api_candidate" "$api_env"'
    if ($auth.IndexOf($authCutoverGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authCutoverGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authCutoverGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiReplacement, [System.StringComparison]::Ordinal)) {
        throw 'Authentication cutover proof must pass before creating or replacing the shared api.env candidate.'
    }
    $authUnionPendingGate = 'if [[ "$mode" != ''--legacy-drain'' && "$current_schema_transition_mode" == ''wechat_union_aliases_pending'' ]]; then'
    $authUnionEnableGate = 'if [[ "$mode" == ''--apply'' && "$target_wechat_auth_enabled" == ''true'' ]]; then'
    $authUnionReadyCall = '  assert_wechat_union_aliases_ready'
    if ([regex]::Matches($auth, [regex]::Escape('assert_wechat_union_aliases_ready')).Count -ne 2 -or
        $auth.IndexOf($authUnionPendingGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authUnionEnableGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authUnionReadyCall, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authUnionEnableGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authUnionPendingGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authUnionReadyCall, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authUnionEnableGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal)) {
        throw 'WeChat enablement must reject the pending bridge and prove schema 0012 plus least-privilege ACL before creating an auth candidate.'
    }
    $authQqStateEnableGate = 'if [[ "$mode" == ''--apply'' && "$target_qq_auth_enabled" == ''true'' ]]; then'
    $authQqStateChangeGate = '  if [[ "$qq_identity_state_change_required" == ''true'' ]]; then'
    $authQqStateReadyCall = '    assert_qq_identity_state_change_ready'
    $authQqStatePersistCall = '    persist_qq_identity_state '
    $authQqStateCountGate = "SELECT count(*) FROM public.identity_bindings WHERE identity_type = 'QQ';"
    $authQqStatePersistDefinition = 'persist_qq_identity_state() {'
    $authNonActiveCandidateGate = '[[ "$active_deploy" != "$bundle_root" ]]'
    if ([regex]::Matches($auth, [regex]::Escape('assert_qq_identity_state_change_ready')).Count -ne 2 -or
        [regex]::Matches($auth, [regex]::Escape('persist_qq_identity_state')).Count -ne 2 -or
        $auth.IndexOf($authQqStateEnableGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authQqStateChangeGate, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authQqStateEnableGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authQqStateReadyCall, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authQqStateChangeGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authQqStatePersistCall, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authQqStateReadyCall, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authQqStatePersistCall, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authQqStateCountGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authQqStatePersistDefinition, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authQqStateCountGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authNonActiveCandidateGate, [System.StringComparison]::Ordinal) -lt 0 -or
        $auth.IndexOf($authNonActiveCandidateGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authUnionEnableGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authNonActiveCandidateGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authQqStateEnableGate, [System.StringComparison]::Ordinal) -or
        $auth.IndexOf($authNonActiveCandidateGate, [System.StringComparison]::Ordinal) -gt
            $auth.IndexOf($authApiCandidate, [System.StringComparison]::Ordinal)) {
        throw 'QQ shared identity-state initialization must pass the zero-binding gate and persist before API/deployment candidate creation.'
    }
    $authCleanup = [regex]::Match(
        $auth,
        '(?s)cleanup\(\) \{(?<body>.*?)\n\}\ntrap cleanup EXIT'
    )
    if (-not $authCleanup.Success -or
        $authCleanup.Groups['body'].Value.Contains('identity_state')) {
        throw 'Authentication rollback must restore API/deployment files without rolling back shared QQ identity state.'
    }
    $authPreflightCall = 'if ! "$preflight" >/dev/null; then'
    $authDeploymentReplace = 'mv -f -- "$deployment_candidate" "$deployment_env"'
    if ([regex]::Matches(
            $auth,
            [regex]::Escape($authPreflightCall)
        ).Count -ne 1 -or
        $auth.IndexOf($authPreflightCall, [System.StringComparison]::Ordinal) -lt
            $auth.IndexOf($authDeploymentReplace, [System.StringComparison]::Ordinal)) {
        throw 'Authentication updater must preflight exactly once after replacing the candidate deployment env; non-bridge modes also replace api.env first.'
    }
    foreach ($required in @(
        '--network none --read-only',
        '--env-file "$secrets_dir/api.env"',
        '--env AUTH_SCHEMA_TRANSITION_MODE="$auth_schema_transition_mode"',
        'AUTH_SCHEMA_TRANSITION_MODE must be none, legacy_phone_drain or wechat_union_aliases_pending',
        'legacy_phone_drain requires ACCOUNTS_ENABLED=false',
        'wechat_union_aliases_pending requires WECHAT_AUTH_ENABLED=false',
        'WECHAT_OPEN_PLATFORM_REALM_ID',
        'WECHAT_OPEN_PLATFORM_REALM_ID must be a stable lowercase internal identifier',
        '--env WECHAT_OPEN_PLATFORM_REALM_ID="$wechat_open_platform_realm_id"',
        'QQ_OPEN_PLATFORM_REALM_ID',
        'QQ_OPEN_PLATFORM_REALM_ID must be a stable lowercase internal identifier',
        '--env QQ_OPEN_PLATFORM_REALM_ID="$qq_open_platform_realm_id"',
        'qq_identity_state_file="$shared_state_directory/auth-identity-state.env"',
        'assert_regular_file "$qq_identity_state_file" 600',
        'AUTH_IDENTITY_STATE_FORMAT_VERSION',
        'QQ_UNION_ID_NAMESPACE_INITIALIZED',
        'assert_exact_env_keys "$qq_identity_state_file"',
        'release must preserve the shared QQ Open Platform realm',
        'QQ authentication requires initialized shared identity state',
        'if [[ "$qq_identity_state_present" == ''false'' ]]; then',
        'QQ_UNION_ID_ENABLED requires an initialized QQ UnionID namespace',
        'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled',
        'assert_env_keys_with_optional',
        'AUTH_OTP_PEPPER_ACTIVE_VERSION',
        'AUTH_OTP_PEPPER_KEYS_JSON',
        'ALIYUN_SMS_SIGN_NAME',
        'ALIYUN_FUSION_SCHEME_CODE',
        'ALIYUN_FUSION_PACKAGE_NAME',
        'ALIYUN_FUSION_PACKAGE_SIGN',
        'loadAuthRuntimeConfig(process.env',
        'production: true',
        'PHONE_ONLY accounts require SMS phone authentication',
        'QQ_UNION_ID_ENABLED requires QQ_AUTH_ENABLED',
        'ALIYUN_PNVS_SIGN_NAME ALIYUN_PNVS_TEMPLATE_CODE',
        'if [[ "$email_auth_enabled" == ''true'' ]]; then',
        'SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USERNAME SMTP_PASSWORD',
        'SMTP_FROM_ADDRESS SMTP_REPLY_TO SMTP_FROM_NAME',
        'if [[ "$wechat_auth_enabled" == ''true'' ]]; then',
        'api_env_names+=(WECHAT_APP_ID WECHAT_APP_SECRET)',
        'if [[ "$qq_auth_enabled" == ''true'' ]]; then',
        'api_env_names+=(QQ_APP_ID QQ_APP_KEY)',
        'config.registrationEnabled !== registrationEnabled',
        'config.wechat.openPlatformRealmId',
        'config.qq.unionIdEnabled',
        'config.qq.openPlatformRealmId',
        'AUTH_CONFIG_VALIDATION=OK',
        'api.env contains an incomplete authentication identity/session continuity group',
        'api.env contains an incomplete email OTP continuity group',
        'disabled authentication continuity validation failed',
        '/app/dist/auth/auth-config.js',
        '/app/migrations/0012_wechat_union_aliases.sql',
        'API image rejected authentication configuration'
    )) {
        if (-not $preflight.Contains($required)) {
            throw "Deployment preflight is missing runtime-equivalent authentication validation: $required"
        }
    }
    if ($preflight.Contains('SMTP_APP_PASSWORD') -or
        $preflight.Contains('EMAIL_OTP_PEPPER_')) {
        throw 'Deployment preflight must accept only runtime SMTP_PASSWORD and AUTH_OTP_PEPPER_* names.'
    }
    $preflightLegacyApiEnvGate = '(?s)if \[\[ "\$auth_schema_transition_mode" == ''legacy_phone_drain'' \]\]; then.*?' +
        'assert_env_keys_with_optional.*?else\s+' +
        'assert_exact_env_keys "\$secrets_dir/api\.env" "\$\{api_env_names\[@\]\}"\s+fi'
    if ($preflight -notmatch $preflightLegacyApiEnvGate) {
        throw 'Deployment preflight must allow the retired auth whitelist only in legacy_phone_drain and keep ordinary api.env validation exact.'
    }
    if (-not $permissionHardener.Contains('"$bundle_root/postgres/pg_hba.conf") chmod 644 "$path" ;;') -or
        -not $preflight.Contains('"$bundle_root/postgres/pg_hba.conf") assert_regular_file "$path" 644 ;;')) {
        throw 'PostgreSQL pg_hba.conf must remain root-owned and container-readable after release hardening.'
    }
    $authWechatFieldAppend = 'input_names\+=\(WECHAT_APP_ID WECHAT_APP_SECRET\)'
    $authWechatConditional = '(?s)if \[\[ "\$target_wechat_auth_enabled" == ''true'' \]\]; then\s+' +
        $authWechatFieldAppend + '\s+fi'
    $preflightWechatFieldAppend = 'api_env_names\+=\(WECHAT_APP_ID WECHAT_APP_SECRET\)'
    $preflightWechatConditional = '(?s)if \[\[ "\$wechat_auth_enabled" == ''true'' \]\]; then\s+' +
        $preflightWechatFieldAppend + '\s+fi'
    if ($auth -notmatch $authWechatConditional -or
        [regex]::Matches($auth, $authWechatFieldAppend).Count -ne 1 -or
        $preflight -notmatch $preflightWechatConditional -or
        [regex]::Matches($preflight, $preflightWechatFieldAppend).Count -ne 1) {
        throw 'WeChat credentials must be required exactly once and only inside the enabled-channel condition.'
    }
    $authQqFieldAppend = 'input_names\+=\(QQ_APP_ID QQ_APP_KEY\)'
    $authQqConditional = '(?s)if \[\[ "\$target_qq_auth_enabled" == ''true'' \]\]; then\s+' +
        $authQqFieldAppend + '\s+fi'
    $preflightQqFieldAppend = 'api_env_names\+=\(QQ_APP_ID QQ_APP_KEY\)'
    $preflightQqConditional = '(?s)if \[\[ "\$qq_auth_enabled" == ''true'' \]\]; then\s+' +
        $preflightQqFieldAppend + '\s+fi'
    if ($auth -notmatch $authQqConditional -or
        [regex]::Matches($auth, $authQqFieldAppend).Count -ne 1 -or
        $preflight -notmatch $preflightQqConditional -or
        [regex]::Matches($preflight, $preflightQqFieldAppend).Count -ne 1) {
        throw 'QQ AppID/AppKey must be required exactly once and only inside the enabled-channel condition.'
    }
    if ($auth.Contains('accounts require WeChat authentication') -or
        $preflight.Contains('accounts require WeChat authentication')) {
        throw 'PHONE_ONLY accounts must not depend on the WeChat authentication channel.'
    }
    foreach ($required in @(
        "lock_directory='/run/lock/chi-shen-me'",
        'lock_file="$lock_directory/mutation.lock"',
        'flock -n 9',
        '[[ "$#" -eq 0 ]]',
        'candidate release is already current',
        '"$preflight" >/dev/null',
        'candidate_compose up -d --no-deps --force-recreate --pull never --no-build api',
        'old_compose_command up -d --no-deps --force-recreate --pull never --no-build api',
        'candidate runtime readiness verification failed',
        'health_http_200 "$old_port"',
        '"$old_runtime_verifier" >/dev/null',
        'find "$bundle_root" -xdev -type l -print -quit',
        'find "$old_deploy" -xdev -type l -print -quit',
        'if current_target_is "$candidate_release"',
        'mv -Tf -- "$temporary_link" "$current_link"',
        'trap - INT TERM HUP',
        "trap 'exit 129' HUP",
        'ACTIVATION_ROLLBACK=OK',
        'RECOVERY_REQUIRED=true',
        'POSTGRES_CONTAINER_UNCHANGED=true'
    )) {
        if (-not $releaseActivation.Contains($required)) {
            throw "Candidate release activation is missing a required safety gate: $required"
        }
    }
    foreach ($forbidden in @(
        '(?i)nginx',
        '(?i)/www/',
        '(?i)provision-database',
        '(?i)\bmigrate\b',
        '(?im)\bln\s+-s(?:f|T)',
        '(?im)\bln\s+-[A-Za-z]*f[A-Za-z]*s[A-Za-z]*',
        '(?im)\bdocker\s+compose\b[^\r\n]*\b(?:down|run)\b',
        '(?im)^\s*(?:candidate_compose|old_compose_command)\s+up\b[^\r\n]*\bpostgres\b',
        '(?im)^\s*(?:candidate_compose|old_compose_command)\s+(?:down|run)\b'
    )) {
        if ($releaseActivation -match $forbidden) {
            throw 'Candidate release activation must not migrate, recreate PostgreSQL, run ops jobs or touch Nginx.'
        }
    }
}

function Assert-Bundle {
    param(
        [Parameter(Mandatory = $true)][string]$RepoPath,
        [Parameter(Mandatory = $true)][string]$BundleRoot
    )

    Assert-SourceContract -RepoPath $RepoPath

    if (-not (Test-Path -LiteralPath $BundleRoot -PathType Container)) {
        throw "Bundle directory does not exist: $BundleRoot"
    }
    $bundleResolved = (Resolve-Path -LiteralPath $BundleRoot).ProviderPath.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )

    foreach ($item in @(Get-ChildItem -LiteralPath $bundleResolved -Recurse -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Links or reparse points are forbidden in a deployment bundle: $($item.FullName)"
        }
    }

    $payloadPaths = @(Get-OrdinalSortedStrings -Values @(
        $script:RequiredMappings | ForEach-Object { $_.BundleRelative }
    ))
    $expectedFiles = @($payloadPaths) + @($script:ManifestName)
    $actualFiles = @(Get-ChildItem -LiteralPath $bundleResolved -Recurse -File -Force |
        ForEach-Object { Get-RelativeChildPath -Root $bundleResolved -Child $_.FullName })
    Assert-ExactSet -Actual $actualFiles -Expected $expectedFiles `
        -Description 'Bundle file inventory'

    $manifestPath = Join-Path -Path $bundleResolved -ChildPath $script:ManifestName
    $manifestLines = [System.IO.File]::ReadAllLines($manifestPath)
    $expectedManifestHeader = @(
        '# what-to-eat ECS deployment bundle SHA-256 manifest v1',
        '# Hashes cover every payload file; paths are repository-independent.'
    )
    if ($manifestLines.Count -ne ($expectedManifestHeader.Count + $payloadPaths.Count) -or
        $manifestLines[0] -cne $expectedManifestHeader[0] -or
        $manifestLines[1] -cne $expectedManifestHeader[1]) {
        throw 'SHA-256 manifest structure or header is not the deterministic v1 format.'
    }

    $manifestEntries = @{}
    foreach ($line in $manifestLines) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
            continue
        }
        if ($line -notmatch '^(?<hash>[0-9a-f]{64})  (?<path>[^\\\r\n]+)$') {
            throw "Malformed SHA-256 manifest line: $line"
        }
        $relative = $Matches['path']
        if ($relative.StartsWith('/') -or $relative.Contains('../') -or
            $relative.Contains('/..') -or $relative.Contains(':')) {
            throw "Unsafe path in SHA-256 manifest: $relative"
        }
        if ($manifestEntries.ContainsKey($relative)) {
            throw "Duplicate path in SHA-256 manifest: $relative"
        }
        $manifestEntries[$relative] = $Matches['hash']
    }

    Assert-ExactSet -Actual @($manifestEntries.Keys) -Expected $payloadPaths `
        -Description 'SHA-256 manifest path inventory'

    foreach ($relative in $payloadPaths) {
        $bundleFile = Join-Path -Path $bundleResolved -ChildPath (
            ConvertTo-NativeRelativePath -Path $relative
        )
        $actualHash = (Get-FileHash -LiteralPath $bundleFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -cne $manifestEntries[$relative]) {
            throw "SHA-256 verification failed for bundle payload: $relative"
        }

        $mapping = @($script:RequiredMappings | Where-Object {
            $_.BundleRelative -ceq $relative
        })
        if ($mapping.Count -ne 1) {
            throw "Internal bundle mapping is not unique for: $relative"
        }
        $sourceFile = Join-Path -Path $RepoPath -ChildPath (
            ConvertTo-NativeRelativePath -Path $mapping[0].SourceRelative
        )
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceHash -cne $actualHash) {
            throw "Bundle payload is not byte-identical to its reviewed source: $relative"
        }
    }

    Assert-NoSensitiveMaterial -BundleRoot $bundleResolved -PayloadPaths $payloadPaths
    Assert-EcsOperationalGates -BundleRoot $bundleResolved
    return $bundleResolved
}

$repo = Get-NormalizedExistingDirectory -Path $RepositoryRoot -Description 'Repository root'
$output = Get-NormalizedCandidatePath -Path $OutputDirectory -BasePath (Get-Location).ProviderPath
Assert-SafeOutputLocation -OutputPath $output -RepoPath $repo -MustExist:$VerifyOnly.IsPresent

if ($VerifyOnly) {
    $verifiedPath = Assert-Bundle -RepoPath $repo -BundleRoot $output
    Write-Output "ECS deployment bundle verified: $verifiedPath"
    exit 0
}

Assert-SourceContract -RepoPath $repo

$outputParent = Split-Path -Parent $output
$staging = Join-Path -Path $outputParent -ChildPath (
    '.ecs-bundle-stage-' + [System.Guid]::NewGuid().ToString('N')
)
$stagingCreated = $false
$outputCreatedByMove = $false
$outputWasPreExisting = Test-Path -LiteralPath $output -PathType Container
$outputPublicationStarted = $false

try {
    [void](New-Item -ItemType Directory -Path $staging)
    $stagingCreated = $true

    foreach ($mapping in $script:RequiredMappings) {
        $source = Join-Path -Path $repo -ChildPath (
            ConvertTo-NativeRelativePath -Path $mapping.SourceRelative
        )
        $destination = Join-Path -Path $staging -ChildPath (
            ConvertTo-NativeRelativePath -Path $mapping.BundleRelative
        )
        $destinationParent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $destinationParent -Force)
        }
        [System.IO.File]::Copy($source, $destination, $false)
    }

    $payloadPaths = @($script:RequiredMappings | ForEach-Object { $_.BundleRelative })
    Assert-NoSensitiveMaterial -BundleRoot $staging -PayloadPaths $payloadPaths
    Write-HashManifest -BundleRoot $staging -PayloadPaths $payloadPaths
    [void](Assert-Bundle -RepoPath $repo -BundleRoot $staging)

    # Recheck immediately before publishing so a concurrently populated target
    # is never overlaid. A non-existent target can be atomically moved on the
    # same volume; a pre-existing empty target is populated file by file.
    Assert-SafeOutputLocation -OutputPath $output -RepoPath $repo -MustExist:$false
    if (-not (Test-Path -LiteralPath $output)) {
        $outputPublicationStarted = $true
        [System.IO.Directory]::Move($staging, $output)
        $stagingCreated = $false
        $outputCreatedByMove = $true
    }
    else {
        $outputPublicationStarted = $true
        foreach ($file in @(Get-ChildItem -LiteralPath $staging -Recurse -File -Force)) {
            $relative = Get-RelativeChildPath -Root $staging -Child $file.FullName
            $destination = Join-Path -Path $output -ChildPath (
                ConvertTo-NativeRelativePath -Path $relative
            )
            $destinationParent = Split-Path -Parent $destination
            if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
                [void](New-Item -ItemType Directory -Path $destinationParent -Force)
            }
            [System.IO.File]::Copy($file.FullName, $destination, $false)
        }
    }

    $verifiedPath = Assert-Bundle -RepoPath $repo -BundleRoot $output
    Write-Output "ECS deployment bundle created and verified: $verifiedPath"
}
catch {
    if ($outputPublicationStarted -and (Test-Path -LiteralPath $output -PathType Container)) {
        # Remove only the exact files this script is able to create. Never use a
        # broad recursive delete for a caller-selected output directory.
        $knownFiles = @($script:RequiredMappings | ForEach-Object { $_.BundleRelative }) + @($script:ManifestName)
        foreach ($relative in $knownFiles) {
            $knownPath = Join-Path -Path $output -ChildPath (
                ConvertTo-NativeRelativePath -Path $relative
            )
            if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
                Remove-Item -LiteralPath $knownPath -Force
            }
        }
        foreach ($relativeDirectory in @('nginx', 'postgres', 'scripts', 'sql')) {
            $knownDirectory = Join-Path -Path $output -ChildPath $relativeDirectory
            if ((Test-Path -LiteralPath $knownDirectory -PathType Container) -and
                @(Get-ChildItem -LiteralPath $knownDirectory -Force).Count -eq 0) {
                Remove-Item -LiteralPath $knownDirectory -Force
            }
        }
        if ($outputCreatedByMove -and -not $outputWasPreExisting -and
            @(Get-ChildItem -LiteralPath $output -Force).Count -eq 0) {
            Remove-Item -LiteralPath $output -Force
        }
    }
    throw
}
finally {
    if ($stagingCreated -and (Test-Path -LiteralPath $staging -PathType Container)) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
