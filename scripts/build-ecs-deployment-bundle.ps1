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
    if ($Name -ceq 'ALIYUN_FUSION_TOKEN_TTL_SECONDS' -and
        $trimmed -match '^(?:[0-9]{3,5})$') {
        $ttl = [int]$trimmed
        return $ttl -ge 900 -and $ttl -le 43200
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
    if ([System.Text.RegularExpressions.Regex]::Matches(
            $compose,
            '(?m)^\s*pull_policy:\s+never\s*$'
        ).Count -ne 4 -or
        -not $compose.Contains('POSTGRES_VOLUME_NAME') -or
        -not $compose.Contains('external: true') -or
        -not $compose.Contains('cap_drop:')) {
        throw 'ECS Compose is missing offline image, protected volume or capability gates.'
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
            '(?im)^\s*set\s+\+x\s*$',
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
    $releaseActivation = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'scripts/activate-candidate-release.sh')
    )
    if (-not $backup.Contains("backup_root='/opt/chi-shen-me/backups/postgres'") -or
        -not $backup.Contains('--format=custom') -or
        -not $backup.Contains('pg_restore --list') -or
        -not $backup.Contains('sha256sum --check --strict') -or
        -not $backup.Contains('mutation_lock="$lock_directory/mutation.lock"') -or
        -not $backup.Contains('flock -n 8')) {
        throw 'PostgreSQL backup script is missing its exact path, custom dump or integrity gates.'
    }
    if (-not $restore.Contains('chi_shen_me_restore_') -or
        -not $restore.Contains('--single-transaction') -or
        -not $restore.Contains('--role=schema_migrator')) {
        throw 'PostgreSQL restore script is missing its isolated target or transactional role gates.'
    }
    if (-not $rollback.Contains('ROLLBACK_chi_shen_me_FROM_') -or
        -not $rollback.Contains('PRESERVED_PREVIOUS_DATABASE') -or
        $rollback -match '(?im)\bDROP\s+DATABASE\b') {
        throw 'PostgreSQL rollback must require confirmation and preserve the previous database.'
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
        'readonly FUSION_DRAIN_SECONDS=43200',
        'drain_state="$secrets_dir/auth-key-drain.env"',
        'mutation_lock="$lock_directory/mutation.lock"',
        'flock -n 8',
        'updated authentication configuration failed preflight and was rolled back',
        'AUTH_IDENTITY_DEDUP_KEY_VERSION changes require a dedicated audited migration',
        'SELECT count(*) FROM public.fusion_auth_flows WHERE consumed_at IS NULL AND expires_at > clock_timestamp()',
        'active FusionAuth flows still block key removal',
        'authentication keys must drain for at least 12 hours before removal',
        'AUTH_KEY_DRAIN_STATE_RETAINED=true',
        "drain_action='replace-candidate'",
        'build_drain_candidate "$api_candidate" "$drain_timestamp"',
        'API_RECREATE_REQUIRED=true'
    )) {
        if (-not $auth.Contains($required)) {
            throw "Authentication secret updater is missing a safety gate: $required"
        }
    }
    foreach ($required in @(
        '--network none --read-only',
        '--env-file "$secrets_dir/api.env"',
        'loadAuthRuntimeConfig(process.env',
        'production: true',
        'AUTH_CONFIG_VALIDATION=OK',
        '/app/dist/auth/auth-config.js',
        'API image rejected authentication configuration'
    )) {
        if (-not $preflight.Contains($required)) {
            throw "Deployment preflight is missing runtime-equivalent authentication validation: $required"
        }
    }
    foreach ($required in @(
        "lock_directory='/run/lock/chi-shen-me'",
        'lock_file="$lock_directory/mutation.lock"',
        'flock -n 9',
        '[[ "$#" -eq 0 ]]',
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
