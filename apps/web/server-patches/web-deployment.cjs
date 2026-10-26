'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cutover = fs.readFileSync(path.join(__dirname, 'web-cutover-function.sh'), 'utf8');
const bundleGates = fs.readFileSync(path.join(__dirname, 'web-bundle-gates.ps1'), 'utf8');
const schema17 = `count(*) = 17 AND min(version) = 1 AND max(version) = 17
        AND bool_and(checksum ~ '^[0-9a-f]{64}$')
        AND bool_or(version = 12 AND name = 'wechat_union_aliases')
        AND bool_or(version = 13 AND name = 'admin_config_control')
        AND bool_or(version = 14 AND name = 'wechat_miniprogram_login')
        AND bool_or(version = 15 AND name = 'place_image_display_rights')
        AND bool_or(version = 16 AND name = 'canteen_public_ratings')
        AND bool_or(version = 17 AND name = 'web_browser_sessions')`;
const patches = {
  'infra/postgres/role-grants.sql': [
    [') AS canteen_ratings_schema_0016,\n(', `) AS canteen_ratings_schema_0016,\n(\n  ${schema17}\n) AS web_browser_schema_0017,\n(`, 1],
    ["  OR :'canteen_ratings_schema_0016'::boolean", "  OR :'canteen_ratings_schema_0016'::boolean\n  OR :'web_browser_schema_0017'::boolean", 5],
    [') AS supported_auth_schema \\gset', `) AS supported_auth_schema,\n(\n  :'canteen_ratings_schema_0016'::boolean OR :'web_browser_schema_0017'::boolean\n) AS canteen_ratings_schema \\gset`, 1],
    ['\\if :canteen_ratings_schema_0016', '\\if :canteen_ratings_schema', 2],
    ['0013, 0014, 0015 or 0016 schema', '0013, 0014, 0015, 0016 or 0017 schema', 1],
  ],
  'infra/postgres/verify-admin-config-control.sql': [
    ["        AND bool_or(version = 16 AND name = 'canteen_public_ratings'))", `        AND bool_or(version = 16 AND name = 'canteen_public_ratings'))\n      OR (${schema17})`, 1],
    ['0013, 0014, 0015 or 0016 ledger', '0013, 0014, 0015, 0016 or 0017 ledger', 1],
  ],
  'infra/postgres/verify-wechat-miniprogram-login.sql': [
    ["        AND bool_or(version = 16 AND name = 'canteen_public_ratings'))", `        AND bool_or(version = 16 AND name = 'canteen_public_ratings'))\n      OR (${schema17})`, 1],
    ['0014, 0015 or 0016 ledger', '0014, 0015, 0016 or 0017 ledger', 1],
  ],
  'infra/postgres/verify-canteen-public-ratings.sql': [
    ['IF NOT (SELECT count(*) = 16 AND min(version) = 1 AND max(version) = 16', `IF NOT (SELECT ((count(*) = 16 AND min(version) = 1 AND max(version) = 16)\n      OR (${schema17}))`, 1],
    ['exact schema 0016 ledger', 'exact schema 0016 or 0017 ledger', 1],
  ],
  'infra/ecs/scripts/update-auth-secrets.sh': [
    ["         AND bool_or(version = 16 AND name = 'canteen_public_ratings')))", `         AND bool_or(version = 16 AND name = 'canteen_public_ratings'))\n       OR (${schema17}))`, 1],
    ['0013, 0014, 0015 or 0016', '0013, 0014, 0015, 0016 or 0017', 2],
    ['exact schema 0014, 0015 or 0016 and Mini Program resolver', 'exact schema 0014, 0015, 0016 or 0017 and Mini Program resolver', 1],
  ],
  'infra/ecs/scripts/preflight-deployment.sh': [
    ["test -r /app/migrations/0016_canteen_public_ratings.sql'", "test -r /app/migrations/0016_canteen_public_ratings.sql && test -r /app/migrations/0017_web_browser_sessions.sql'", 1],
  ],
  'infra/ecs/scripts/provision-database.sh': [
    ["wechat_miniprogram_cutover_started='false'", "wechat_miniprogram_cutover_started='false'\nweb_browser_rollback_release=''\nweb_browser_cutover_started='false'", 1],
    ['else\n  die \'usage: provision-database.sh', 'elif [[ "$#" -eq 2 && "$1" == \'--web-browser-cutover\' ]]; then\n  web_browser_rollback_release="$2"\nelse\n  die \'usage: provision-database.sh', 1],
    ['usage: provision-database.sh [--wechat-miniprogram-cutover ROLLBACK_RELEASE]', 'usage: provision-database.sh [--web-browser-cutover ROLLBACK_RELEASE] [--wechat-miniprogram-cutover ROLLBACK_RELEASE]', 1],
    ['  return "$status"\n}\ntrap cleanup EXIT', `  if [[ "$status" -ne 0 && "$web_browser_cutover_started" == 'true' ]]; then\n    printf 'WEB_BROWSER_RECOVERY_RELEASE=%s\\n' "$web_browser_rollback_release" >&2\n    printf 'DATABASE_SCHEMA_READBACK_REQUIRED=true\\nDATABASE_AUTOMATIC_DOWNGRADE=false\\n' >&2\n  fi\n  return "$status"\n}\ntrap cleanup EXIT`, 1],
    ['schema_table="$(run_bootstrap_psql', `${cutover}\nschema_table="$(run_bootstrap_psql`, 1],
    ['if ! docker volume inspect "$postgres_volume_name" >/dev/null 2>&1; then\n  docker volume create \\\n    --driver local \\\n    --label com.chi-shen-me.purpose=postgres-data \\\n    --label com.chi-shen-me.protected=true \\\n    "$postgres_volume_name" >/dev/null\nfi', 'docker volume inspect "$postgres_volume_name" >/dev/null 2>&1 ||\n  die \'WEB provisioning requires the existing database volume\'', 1],
    ['docker compose --env-file deployment.env up -d postgres', 'web_existing_postgres_id="$(docker compose --env-file deployment.env ps -q postgres)"\n[[ -n "$web_existing_postgres_id" ]] || die \'WEB provisioning requires the existing PostgreSQL container\'\n[[ "$(docker inspect --format \'{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}\' "$web_existing_postgres_id")" == \'running/healthy\' ]] ||\n  die \'WEB provisioning requires healthy PostgreSQL without recreation\'', 1],
    ['     -z "$admin_config_rollback_release" && -z "$wechat_miniprogram_rollback_release" ]] ||\n    die \'cutover flags require an exact supported existing schema\'', '     -z "$admin_config_rollback_release" && -z "$wechat_miniprogram_rollback_release" && -z "$web_browser_rollback_release" ]] ||\n    die \'cutover flags require an exact supported existing schema\'', 1],
    ["    '16|1|16|canteen_public_ratings')\n", "    '16|1|16|canteen_public_ratings')\n      assert_web_browser_cutover_ready\n      ;;\n    '17|1|17|web_browser_sessions')\n", 1],
    ['  case "$schema_head" in', `  [[ "$schema_head" == '16|1|16|canteen_public_ratings' || "$schema_head" == '17|1|17|web_browser_sessions' ]] ||\n    die 'WEB release provisioning requires the exact schema 0016 or 0017 baseline'\n  case "$schema_head" in`, 1],
    ['docker compose --env-file deployment.env --profile ops run --rm migrate', `if [[ -n "$web_browser_rollback_release" ]]; then\n  web_browser_cutover_started='true'\nfi\ndocker compose --env-file deployment.env --profile ops run --rm migrate`, 1],
    ['docker compose --env-file deployment.env --profile ops run --rm migrate', 'docker compose --env-file deployment.env --profile ops run --rm --no-deps migrate', 1],
    ['run_bootstrap_psql -qAt <"$bundle_root/sql/verify-canteen-public-ratings.sql"', `run_bootstrap_psql -qAt <"$bundle_root/sql/verify-canteen-public-ratings.sql"\nrun_bootstrap_psql -qAt <"$bundle_root/sql/verify-web-browser-sessions.sql"\nif [[ -n "$web_browser_rollback_release" ]]; then\n  "$script_dir/verify-rollback-release.sh" "$web_browser_rollback_release" >/dev/null\nfi`, 1],
    ["printf 'DATABASE_PROVISIONING=OK\\n'", `[[ "$(docker compose --env-file deployment.env ps -q postgres)" == "$web_existing_postgres_id" ]] ||\n  die 'PostgreSQL container changed during WEB schema cutover'\nprintf 'POSTGRES_CONTAINER_UNCHANGED=true\\nDATABASE_PROVISIONING=OK\\n'\nif [[ -n "\${web_browser_cutover_backup:-}" ]]; then\n  printf 'WEB_BROWSER_CUTOVER_BACKUP=%s\\n' "$web_browser_cutover_backup"\n  printf 'WEB_BROWSER_RECOVERY_RELEASE=%s\\n' "$web_browser_rollback_release"\n  printf 'WEB_BROWSER_ACTIVATION_REQUIRES_EXPLICIT_ROLLBACK=true\\n'\nfi`, 1],
  ],
  'scripts/build-ecs-deployment-bundle.ps1': [
    ["        SourceRelative = 'infra/postgres/verify-canteen-public-ratings.sql'\n        BundleRelative = 'sql/verify-canteen-public-ratings.sql'\n    }", "        SourceRelative = 'infra/postgres/verify-canteen-public-ratings.sql'\n        BundleRelative = 'sql/verify-canteen-public-ratings.sql'\n    },\n    [pscustomobject]@{\n        SourceRelative = 'infra/postgres/verify-web-browser-sessions.sql'\n        BundleRelative = 'sql/verify-web-browser-sessions.sql'\n    }", 1],
    ['0013, 0014, 0015 or 0016', '0013, 0014, 0015, 0016 or 0017', 2],
    ['exact schema 0014, 0015 or 0016 and Mini Program resolver', 'exact schema 0014, 0015, 0016 or 0017 and Mini Program resolver', 1],
    ["        '\\if :canteen_ratings_schema_0016',", "        '\\if :canteen_ratings_schema',\n        'AS web_browser_schema_0017',", 1],
    ["        '/app/migrations/0016_canteen_public_ratings.sql',", "        '/app/migrations/0016_canteen_public_ratings.sql',\n        '/app/migrations/0017_web_browser_sessions.sql',", 1],
    ["$provisionDatabaseStart = 'docker compose --env-file deployment.env up -d postgres'", "$provisionDatabaseStart = 'web_existing_postgres_id=\"$(docker compose --env-file deployment.env ps -q postgres)\"'", 1],
    ['    $miniAudit = [System.IO.File]::ReadAllText(', `${bundleGates}\n    $miniAudit = [System.IO.File]::ReadAllText(`, 1],
  ],
};

function apply(relativePath, source, reverse = false) {
  let output = source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const operations = reverse ? [...(patches[relativePath] || [])].reverse() : patches[relativePath] || [];
  for (const [before, after, expected] of operations) {
    const from = (reverse ? after : before).replaceAll('\n', newline);
    const to = (reverse ? before : after).replaceAll('\n', newline);
    const actual = output.split(from).length - 1;
    if (actual !== expected) throw new Error(`Deployment patch does not match ${relativePath}: expected ${expected}, got ${actual}`);
    output = output.split(from).join(to);
  }
  return output;
}

module.exports = { applyDeployPatch: (relative, source) => apply(relative, source), reverseDeployPatch: (relative, source) => apply(relative, source, true), deployPatchedPaths: Object.freeze(Object.keys(patches)) };
