#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

[[ "$(id -u)" -eq 0 ]] || die 'run as root'
[[ "$#" -eq 1 || ( "$#" -eq 3 && "$2" == '--target-image' ) ]] ||
  die 'usage: verify-rollback-release.sh ROLLBACK_RELEASE [--target-image IMAGE_ID]'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
rollback_release="$1"
rollback_id="${rollback_release##*/}"
rollback_deploy="$rollback_release/deploy"
target_image="${3:-}"

[[ "$rollback_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ &&
   "$rollback_release" == "/opt/chi-shen-me/releases/$rollback_id" ]] ||
  die 'rollback release must be a direct immutable release directory'
[[ -d "$rollback_release" && ! -L "$rollback_release" &&
   "$(realpath -e -- "$rollback_release")" == "$rollback_release" &&
   "$(stat -c '%a:%u:%g' "$rollback_release")" == '700:0:0' ]] ||
  die 'rollback release directory is unavailable or unsafe'
[[ -d "$rollback_deploy" && ! -L "$rollback_deploy" &&
   "$(realpath -e -- "$rollback_deploy")" == "$rollback_deploy" ]] ||
  die 'rollback deployment directory is unavailable or unsafe'
if find "$rollback_deploy" -xdev -type l -print -quit | grep -q .; then
  die 'rollback deployment must not contain links'
fi
for required_file in deployment.env SHA256SUMS compose.yml scripts/preflight-deployment.sh scripts/verify-runtime.sh; do
  [[ -f "$rollback_deploy/$required_file" && ! -L "$rollback_deploy/$required_file" &&
     "$(stat -c '%u:%g' "$rollback_deploy/$required_file")" == '0:0' ]] ||
    die 'rollback deployment is missing a root-owned regular file'
done
[[ "$(stat -c '%a' "$rollback_deploy/deployment.env")" == '600' &&
   -x "$rollback_deploy/scripts/preflight-deployment.sh" &&
   -x "$rollback_deploy/scripts/verify-runtime.sh" ]] ||
  die 'rollback deployment permissions are invalid'
(
  cd "$rollback_deploy"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
"$rollback_deploy/scripts/preflight-deployment.sh" >/dev/null

read_release_value() {
  local path="$1" name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 && -n "${matches[0]#*=}" ]] ||
    die "missing, duplicate or empty rollback deployment setting: $name"
  printf '%s' "${matches[0]#*=}"
}

# A rollback may change API code, never the database, public listener, shared
# identity realm or the deployment-level minimum-version safety floor.
for setting in COMPOSE_PROJECT_NAME API_LOOPBACK_PORT SHARED_STATE_DIRECTORY POSTGRES_DB \
  POSTGRES_BOOTSTRAP_USER POSTGRES_VOLUME_NAME POSTGIS_IMAGE_ID \
  WECHAT_OPEN_PLATFORM_REALM_ID QQ_OPEN_PLATFORM_REALM_ID MINIMUM_SUPPORTED_VERSION; do
  [[ "$(read_release_value "$rollback_deploy/deployment.env" "$setting")" == \
     "$(read_release_value "$bundle_root/deployment.env" "$setting")" ]] ||
    die "rollback deployment boundary differs from candidate: $setting"
done
rollback_image="$(read_release_value "$rollback_deploy/deployment.env" API_IMAGE_ID)"
[[ "$rollback_image" =~ ^sha256:[0-9a-f]{64}$ &&
   "$(docker image inspect --format '{{.Id}}' "$rollback_image")" == "$rollback_image" ]] ||
  die 'rollback image is not the validated immutable image'

read_image_plan() {
  local image_id="$1"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  # The image is inspected offline. No runtime Secret, volume or network is
  # given to this process; only immutable migration names and hashes leave it.
  docker run --rm --read-only --network none --cap-drop ALL \
    --security-opt no-new-privileges --workdir /app --entrypoint node \
    "$image_id" --input-type=module -e '
      import { loadMigrationPlan } from "./dist/database/migration-plan.js";
      try {
        const plan = await loadMigrationPlan();
        process.stdout.write(plan.map(({version, name, checksum}) =>
          `${version}|${name}|${checksum}`).join("\n") + "\n");
      } catch {
        process.stderr.write("image migration plan validation failed\n");
        process.exitCode = 1;
      }
    '
}

rollback_plan="$(read_image_plan "$rollback_image")" ||
  die 'rollback image migration plan could not be verified'
[[ -n "$rollback_plan" && "${#rollback_plan}" -le 16384 ]] ||
  die 'rollback image migration plan has an invalid size'
if [[ -n "$target_image" ]]; then
  [[ "$target_image" =~ ^sha256:[0-9a-f]{64}$ &&
     "$(docker image inspect --format '{{.Id}}' "$target_image")" == "$target_image" ]] ||
    die 'target image is not an immutable local image'
  expected_plan="$(read_image_plan "$target_image")" ||
    die 'target image migration plan could not be verified'
else
  cd "$bundle_root"
  expected_plan="$(docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT version::text || '|' || name || '|' || checksum
FROM public.schema_migrations ORDER BY version;
SQL
  )" ||
    die 'database migration ledger could not be read for rollback verification'
fi
[[ "$rollback_plan" == "$expected_plan" ]] ||
  die 'rollback image cannot accept the target database schema; keep the active API and prepare a compatible rollback release'

printf 'ROLLBACK_SCHEMA_COMPATIBILITY=OK\n'
