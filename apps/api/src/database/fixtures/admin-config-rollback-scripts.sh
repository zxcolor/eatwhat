#!/usr/bin/env bash

# Exercise the actual release script functions using in-memory state and a
# temporary fake verifier. No Docker daemon, real release or database is used.
set -Eeuo pipefail
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$fixture_dir/../../../../.." && pwd -P)"
activation="$repo_root/infra/ecs/scripts/activate-candidate-release.sh"
verifier="$repo_root/infra/ecs/scripts/verify-rollback-release.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -f -- "$temporary_directory/verify-rollback-release.sh" "$temporary_directory/mutated" "$temporary_directory/docker-args" "$temporary_directory/docker-code"; rmdir -- "$temporary_directory"' EXIT

fail() { printf 'rollback script fixture failed: %s\n' "$1" >&2; exit 1; }
extract_function() { sed -n "/^$2() {/,/^}/p" "$1"; }
eval "$(extract_function "$verifier" read_image_plan)"
eval "$(extract_function "$activation" rollback_current)"
eval "$(extract_function "$activation" rollback_old_api)"

image_id="sha256:$(printf 'a%.0s' {1..64})"
docker() {
  if [[ "$1" == run ]]; then
    local last_argument
    for last_argument in "$@"; do :; done
    printf '%s\n' "$@" >"$temporary_directory/docker-args"
    printf '%s' "$last_argument" >"$temporary_directory/docker-code"
    printf '1|initial|%s\n13|admin_config_control|%s\n' "${image_id#sha256:}" "${image_id#sha256:}"
  elif [[ "$1" == inspect ]]; then
    printf '%s\n' "$observed_image"
  else
    fail 'unexpected Docker command'
  fi
}
plan="$(read_image_plan "$image_id")"
[[ "$plan" == *'13|admin_config_control|'* ]] || fail 'image plan output was lost'
for required_argument in --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges --entrypoint node; do
  grep -Fxq -- "$required_argument" "$temporary_directory/docker-args" || fail 'offline image isolation argument was lost'
done
grep -Fq 'loadMigrationPlan' "$temporary_directory/docker-code" || fail 'image migration validation was bypassed'
if grep -Eq -- '^(-v|--volume|--env|--env-file)$' "$temporary_directory/docker-args"; then
  fail 'image inspection received a volume or runtime environment'
fi
if read_image_plan 'mutable:latest' >/dev/null; then
  fail 'mutable image was accepted'
fi

cat >"$temporary_directory/verify-rollback-release.sh" <<'SH'
#!/usr/bin/env bash
exit 9
SH
chmod 700 "$temporary_directory/verify-rollback-release.sh"
precheck="$(sed -n '/^rollback_release="${requested_rollback_release:-\$old_release}"/,/^rollback_runtime_verifier=/p' "$activation")"
[[ -n "$precheck" ]] || fail 'activation rollback precheck was not found'
if (
  die() { exit 2; }
  script_dir="$temporary_directory"
  old_release='/fixture/old'
  candidate_release='/fixture/candidate'
  requested_rollback_release='/fixture/compatible'
  eval "$precheck"
  : >"$temporary_directory/mutated"
); then
  fail 'incompatible rollback precheck did not fail'
fi
[[ ! -e "$temporary_directory/mutated" ]] || fail 'activation continued after incompatible rollback'

old_release='/fixture/old-schema12'
candidate_release='/fixture/candidate-schema13'
rollback_release='/fixture/recovery-schema13'
current_switched='true'
current_target_is() { [[ "$observed_target" == "$1" ]]; }
atomic_replace_current() { observed_target="$1"; }
for initial_target in "$old_release" "$candidate_release" "$rollback_release"; do
  observed_target="$initial_target"
  rollback_current || fail 'compatible recovery pointer was not selected'
  [[ "$observed_target" == "$rollback_release" ]] || fail 'rollback retained incompatible old release'
done
observed_target='/fixture/concurrent-change'
if rollback_current; then fail 'unexpected current pointer was overwritten'; fi
[[ "$observed_target" == '/fixture/concurrent-change' ]] || fail 'foreign pointer changed'

rollback_image_id="$image_id"
observed_image="$image_id"
old_port=39001
rollback_runtime_verifier="$temporary_directory/verify-rollback-release.sh"
cat >"$rollback_runtime_verifier" <<'SH'
#!/usr/bin/env bash
exit 0
SH
rollback_compose_command() {
  if [[ "$*" == 'up -d --no-deps --force-recreate --pull never --no-build api' ]]; then
    return 0
  elif [[ "$*" == 'ps -q api' ]]; then
    printf 'fixture-recovery-api\n'
  else
    fail 'rollback changed more than the API service'
  fi
}
wait_for_healthy_container() { [[ "$1" == 'fixture-recovery-api' ]]; }
health_http_200() { [[ "$1" == "$old_port" ]]; }
assert_postgres_unchanged() { return 0; }
rollback_old_api || fail 'compatible API rollback failed'
observed_image="sha256:$(printf 'b%.0s' {1..64})"
if rollback_old_api; then fail 'wrong rollback image was accepted'; fi
observed_image="$image_id"
assert_postgres_unchanged() { return 1; }
if rollback_old_api; then fail 'rollback ignored PostgreSQL change'; fi

printf 'ADMIN_CONFIG_ROLLBACK_SCRIPT_FIXTURE=OK\n'
