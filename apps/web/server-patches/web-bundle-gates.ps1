    foreach ($required in @(
        '--web-browser-cutover ROLLBACK_RELEASE',
        'assert_web_browser_cutover_ready',
        '"$script_dir/verify-rollback-release.sh" "$web_browser_rollback_release"',
        '^16\|canteen_public_ratings\|[0-9a-f]{64}$',
        'WEB browser cutover backup does not match the active exact schema 0016 release',
        'WEB release provisioning requires the exact schema 0016 or 0017 baseline',
        'WEB provisioning requires the existing database volume',
        'WEB provisioning requires healthy PostgreSQL without recreation',
        'docker compose --env-file deployment.env --profile ops run --rm --no-deps migrate',
        'PostgreSQL container changed during WEB schema cutover',
        "'17|1|17|web_browser_sessions'",
        'run_bootstrap_psql -qAt <"$bundle_root/sql/verify-web-browser-sessions.sql"',
        'WEB_BROWSER_ACTIVATION_REQUIRES_EXPLICIT_ROLLBACK=true'
    )) {
        if (-not $provision.Contains($required)) {
            throw "Schema 0017 cutover is missing a required safety gate: $required"
        }
    }
    if ($provision.Contains('docker compose --env-file deployment.env up -d postgres') -or
        $provision.Contains('docker volume create')) {
        throw 'WEB schema cutover must preserve the existing PostgreSQL container and volume.'
    }
    foreach ($sql in @($ratingRoleGrants, $ratingAudit, $adminConfigAudit, $auth)) {
        foreach ($required in @(
            'count(*) = 17 AND min(version) = 1 AND max(version) = 17',
            "bool_or(version = 17 AND name = 'web_browser_sessions')"
        )) {
            if (-not $sql.Contains($required)) {
                throw "Schema 0017 exact-ledger compatibility is missing: $required"
            }
        }
    }
    $webAudit = [System.IO.File]::ReadAllText(
        (Join-Path -Path $BundleRoot -ChildPath 'sql/verify-web-browser-sessions.sql')
    )
    foreach ($required in @(
        'BEGIN READ ONLY;',
        'count(*) = 17 AND min(version) = 1 AND max(version) = 17',
        "bool_or(version = 17 AND name = 'web_browser_sessions')",
        'auth_session_families_platform_check',
        'check_constraint.convalidated',
        'pg_catalog.pg_get_constraintdef',
        "'DELETE,TRUNCATE,REFERENCES,TRIGGER'",
        'WEB_BROWSER_SESSIONS_SCHEMA_ACL=OK'
    )) {
        if (-not $webAudit.Contains($required)) {
            throw "Schema 0017 read-only verification is missing a safety gate: $required"
        }
    }
