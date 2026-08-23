#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi
[[ "$#" -eq 0 ]] || die 'activate-candidate-release.sh does not accept arguments'

for required_command in curl docker find flock grep install ln mv readlink realpath rm seq sha256sum sleep stat; do
  command -v "$required_command" >/dev/null || die "required command is unavailable: $required_command"
done

script_source="${BASH_SOURCE[0]}"
[[ -f "$script_source" && ! -L "$script_source" ]] || die 'activation script must be a regular file, not a link'
script_path="$(realpath -e -- "$script_source")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
candidate_release="$(dirname -- "$bundle_root")"
candidate_id="${candidate_release##*/}"
current_link='/opt/chi-shen-me/current'
lock_directory='/run/lock/chi-shen-me'
lock_file="$lock_directory/mutation.lock"

[[ "$candidate_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'invalid candidate release ID'
[[ "$bundle_root" == "/opt/chi-shen-me/releases/$candidate_id/deploy" ]] ||
  die "unexpected deployment directory: $bundle_root"
[[ "$candidate_release" == "/opt/chi-shen-me/releases/$candidate_id" ]] || die 'unexpected candidate release path'
[[ "$(realpath -e -- "$candidate_release")" == "$candidate_release" && ! -L "$candidate_release" ]] ||
  die 'candidate release must not be a link'
[[ "$(stat -c '%a:%u:%g' "$candidate_release")" == '700:0:0' ]] ||
  die 'candidate release must be root:root mode 0700'
[[ "$script_path" == "$script_dir/activate-candidate-release.sh" ]] || die 'unexpected activation script path'

if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || die 'release activation lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] ||
  die 'release activation lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'release activation lock directory must be root:root mode 0700'

if [[ -e "$lock_file" || -L "$lock_file" ]]; then
  [[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'release activation lock is not a regular file'
else
  ( set -o noclobber; : >"$lock_file" ) 2>/dev/null || true
fi
[[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'release activation lock could not be created safely'
[[ "$(stat -c '%a:%u:%g' "$lock_file")" == '600:0:0' ]] ||
  die 'release activation lock must be root:root mode 0600'
exec 9<>"$lock_file"
flock -n 9 || die 'another deployment mutation, backup or AMap update is running'

preflight="$script_dir/preflight-deployment.sh"
runtime_verifier="$script_dir/verify-runtime.sh"
manifest="$bundle_root/SHA256SUMS"
[[ -x "$preflight" && ! -L "$preflight" ]] || die 'deployment preflight is unavailable'
[[ -x "$runtime_verifier" && ! -L "$runtime_verifier" ]] || die 'runtime verifier is unavailable'
[[ -f "$manifest" && ! -L "$manifest" ]] || die 'deployment manifest is unavailable'
if find "$bundle_root" -xdev -type l -print -quit | grep -q .; then
  die 'candidate deployment must not contain links'
fi

(
  cd "$bundle_root"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
"$preflight" >/dev/null

read_env_value() {
  local path="$1"
  local name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 && -n "${matches[0]#*=}" ]] ||
    die "missing, duplicate or empty deployment setting: $name"
  printf '%s' "${matches[0]#*=}"
}

assert_direct_release() {
  local release="$1"
  local release_id="${release##*/}"
  [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || return 1
  [[ "$release" == "/opt/chi-shen-me/releases/$release_id" ]] || return 1
  [[ -d "$release" && ! -L "$release" ]] || return 1
  [[ "$(realpath -e -- "$release")" == "$release" ]] || return 1
  [[ "$(stat -c '%a:%u:%g' "$release")" == '700:0:0' ]] || return 1
}

assert_regular_root_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(stat -c '%u:%g' "$path")" == '0:0' ]] || return 1
}

[[ -L "$current_link" ]] || die 'current must be a direct release symlink'
[[ "$(stat -c '%u:%g' "$current_link")" == '0:0' ]] || die 'current symlink must be owned by root'
old_release="$(readlink -- "$current_link")"
assert_direct_release "$old_release" || die 'current does not target a valid direct release'
[[ "$(realpath -e -- "$current_link")" == "$old_release" ]] || die 'current resolves through an unexpected path'
[[ "$old_release" != "$candidate_release" ]] || die 'candidate release is already current'
old_id="${old_release##*/}"
old_deploy="$old_release/deploy"
old_compose="$old_deploy/compose.yml"
old_deployment_env="$old_deploy/deployment.env"
old_manifest="$old_deploy/SHA256SUMS"
old_runtime_verifier="$old_deploy/scripts/verify-runtime.sh"

[[ -d "$old_deploy" && ! -L "$old_deploy" ]] || die 'current deploy directory is unavailable or is a link'
[[ "$(realpath -e -- "$old_deploy")" == "$old_deploy" ]] || die 'current deploy directory resolves unexpectedly'
if find "$old_deploy" -xdev -type l -print -quit | grep -q .; then
  die 'current deployment must not contain links'
fi
assert_regular_root_file "$old_compose" || die 'current compose.yml is unavailable or unsafe'
assert_regular_root_file "$old_deployment_env" || die 'current deployment.env is unavailable or unsafe'
[[ "$(stat -c '%a:%u:%g' "$old_deployment_env")" == '600:0:0' ]] ||
  die 'current deployment.env must be root:root mode 0600'
assert_regular_root_file "$old_manifest" || die 'current deployment manifest is unavailable or unsafe'
assert_regular_root_file "$old_runtime_verifier" || die 'current runtime verifier is unavailable or unsafe'
[[ -x "$old_runtime_verifier" ]] || die 'current runtime verifier is not executable'
(
  cd "$old_deploy"
  sha256sum --check --strict SHA256SUMS >/dev/null
)

candidate_deployment_env="$bundle_root/deployment.env"
candidate_project="$(read_env_value "$candidate_deployment_env" COMPOSE_PROJECT_NAME)"
candidate_port="$(read_env_value "$candidate_deployment_env" API_LOOPBACK_PORT)"
candidate_image_id="$(read_env_value "$candidate_deployment_env" API_IMAGE_ID)"
old_project="$(read_env_value "$old_deployment_env" COMPOSE_PROJECT_NAME)"
old_port="$(read_env_value "$old_deployment_env" API_LOOPBACK_PORT)"
old_image="$(read_env_value "$old_deployment_env" API_IMAGE)"

[[ "$candidate_project" == 'chi-shen-me-alpha' && "$old_project" == "$candidate_project" ]] ||
  die 'candidate and current releases do not share the expected Compose project'
[[ "$old_port" == "$candidate_port" ]] || die 'candidate and current releases use different API loopback ports'
[[ "$old_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'current API image reference is invalid'
old_image_id="$(docker image inspect --format '{{.Id}}' "$old_image")"
[[ "$old_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'current API image ID is invalid'

candidate_compose() {
  ( cd "$bundle_root" && docker compose --env-file deployment.env "$@" )
}

old_compose_command() {
  ( cd "$old_deploy" && docker compose --env-file deployment.env "$@" )
}

container_state() {
  docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1"
}

wait_for_healthy_container() {
  local container="$1"
  local state=''
  local attempt
  for attempt in $(seq 1 31); do
    state="$(container_state "$container" 2>/dev/null || true)"
    if [[ "$state" == 'running/healthy' ]]; then
      return 0
    fi
    if [[ "$attempt" -lt 31 ]]; then
      sleep 2
    fi
  done
  return 1
}

health_http_200() {
  local port="$1"
  local status=''
  if ! status="$(curl --silent --show-error --max-time 5 --noproxy '*' \
    --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/health")"; then
    return 1
  fi
  [[ "$status" == '200' ]]
}

current_target_is() {
  local expected="$1"
  [[ -L "$current_link" ]] || return 1
  [[ "$(readlink -- "$current_link")" == "$expected" ]] || return 1
  [[ "$(realpath -e -- "$current_link")" == "$expected" ]]
}

atomic_replace_current() {
  local target="$1"
  local purpose="$2"
  local attempt
  temporary_link=''
  for attempt in $(seq 1 10); do
    temporary_link="/opt/chi-shen-me/.current.${purpose}.${candidate_id}.$$.$RANDOM"
    if ln -s -- "$target" "$temporary_link" 2>/dev/null; then
      break
    fi
    temporary_link=''
  done
  [[ -n "$temporary_link" && -L "$temporary_link" ]] || return 1
  [[ "$(readlink -- "$temporary_link")" == "$target" ]] || return 1
  mv -Tf -- "$temporary_link" "$current_link"
  temporary_link=''
}

assert_postgres_unchanged() {
  local observed
  observed="$(candidate_compose ps -q postgres)"
  [[ -n "$observed" && "$observed" == "$old_postgres_container" ]] || return 1
  [[ "$(container_state "$observed")" == 'running/healthy' ]]
}

rollback_current() {
  if current_target_is "$old_release"; then
    current_switched='false'
    return 0
  fi
  if current_target_is "$candidate_release"; then
    atomic_replace_current "$old_release" rollback || return 1
    current_switched='false'
    current_target_is "$old_release"
    return
  fi
  return 1
}

rollback_old_api() {
  local restored_api
  local restored_image_id
  old_compose_command up -d --no-deps --force-recreate --pull never --no-build api >/dev/null || return 1
  restored_api="$(old_compose_command ps -q api)"
  [[ -n "$restored_api" ]] || return 1
  wait_for_healthy_container "$restored_api" || return 1
  restored_image_id="$(docker inspect --format '{{.Image}}' "$restored_api")"
  [[ "$restored_image_id" == "$old_image_id" ]] || return 1
  health_http_200 "$old_port" || return 1
  assert_postgres_unchanged || return 1
  "$old_runtime_verifier" >/dev/null
}

old_compose_command config --quiet
old_api_container="$(old_compose_command ps -q api)"
old_postgres_container="$(old_compose_command ps -q postgres)"
[[ -n "$old_api_container" && -n "$old_postgres_container" ]] || die 'current API or PostgreSQL container is missing'
[[ "$(container_state "$old_api_container")" == 'running/healthy' ]] || die 'current API container is not healthy'
[[ "$(container_state "$old_postgres_container")" == 'running/healthy' ]] || die 'current PostgreSQL container is not healthy'
[[ "$(docker inspect --format '{{.Image}}' "$old_api_container")" == "$old_image_id" ]] ||
  die 'current API container does not use the current release image'
health_http_200 "$old_port" || die 'current API /health baseline is not HTTP 200'
"$old_runtime_verifier" >/dev/null || die 'current release runtime verifier failed'

candidate_started='false'
current_switched='false'
completed='false'
temporary_link=''

activation_cleanup() {
  local status="$?"
  local rollback_failed='false'
  trap - INT TERM HUP
  set +e
  if [[ -n "${temporary_link:-}" && -L "$temporary_link" ]]; then
    rm -f -- "$temporary_link" || rollback_failed='true'
    temporary_link=''
  fi
  if [[ "$completed" != 'true' && "$candidate_started" == 'true' ]]; then
    rollback_current || rollback_failed='true'
    rollback_old_api || rollback_failed='true'
    if [[ "$rollback_failed" == 'true' ]]; then
      printf 'ACTIVATION_ROLLBACK=FAILED\n' >&2
      printf 'RECOVERY_REQUIRED=true\n' >&2
      exit 70
    fi
    printf 'ACTIVATION_ROLLBACK=OK\n' >&2
  fi
  return "$status"
}
trap activation_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

candidate_started='true'
if ! candidate_compose up -d --no-deps --force-recreate --pull never --no-build api >/dev/null; then
  die 'candidate API recreate failed' 20
fi
assert_postgres_unchanged || die 'candidate activation changed or degraded PostgreSQL' 21
if ! "$runtime_verifier" >/dev/null; then
  die 'candidate runtime readiness verification failed' 22
fi

candidate_api_container="$(candidate_compose ps -q api)"
[[ -n "$candidate_api_container" ]] || die 'candidate API container is missing' 23
[[ "$(docker inspect --format '{{.Image}}' "$candidate_api_container")" == "$candidate_image_id" ]] ||
  die 'candidate API container image does not match deployment.env' 23

current_target_is "$old_release" || die 'current changed during candidate verification' 24
atomic_replace_current "$candidate_release" activate || die 'could not atomically switch current' 25
current_switched='true'
current_target_is "$candidate_release" || die 'current does not resolve to the candidate release' 26
assert_postgres_unchanged || die 'PostgreSQL changed after current switch' 27
if ! "$runtime_verifier" >/dev/null; then
  die 'runtime verification failed after current switch' 28
fi
[[ "$(docker inspect --format '{{.Image}}' "$(candidate_compose ps -q api)")" == "$candidate_image_id" ]] ||
  die 'active API image changed after current switch' 29

completed='true'
trap - EXIT INT TERM HUP
printf 'CANDIDATE_RELEASE_ACTIVATION=OK\n'
printf 'PREVIOUS_RELEASE=%s\n' "$old_id"
printf 'CURRENT_RELEASE=%s\n' "$candidate_id"
printf 'POSTGRES_CONTAINER_UNCHANGED=true\n'
