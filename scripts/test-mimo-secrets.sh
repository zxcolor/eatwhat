#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Run only in a disposable Linux container, never against an installed service.
[[ -f /.dockerenv && "$(id -u)" -eq 0 ]] || { printf 'requires a disposable root container\n' >&2; exit 2; }
[[ ! -e /opt/chi-shen-me && ! -e /run/lock/chi-shen-me ]] || { printf 'fixture paths already exist; refusing to modify them\n' >&2; exit 2; }
[[ "$#" -eq 1 && -f "$1" ]] || exit 2
root='/opt/chi-shen-me'
deploy="$root/releases/mimo-fixture/deploy"
secret="$root/shared/secrets/api.env"
install -d -m 700 "$root" "$root/releases" "$root/releases/old" "$root/releases/mimo-fixture" "$deploy" "$root/shared" "$root/releases/old/deploy" "$deploy/scripts" "$root/shared/secrets" /root/private
ln -s "$root/releases/old" "$root/current"
install -m 700 "$1" "$deploy/scripts/update-mimo-secrets.sh"
printf 'DATABASE_URL=synthetic-fixture\nOTHER_SETTING=preserved\n' >"$secret"
printf 'MIMO_ENABLED=false\nAPI_IMAGE=synthetic-fixture\n' >"$deploy/deployment.env"
printf 'synthetic-mimo-key\n' >/root/private/mimo-input
chmod 600 "$secret" "$deploy/deployment.env" /root/private/mimo-input
cat >"$deploy/scripts/preflight-deployment.sh" <<'PREFLIGHT'
#!/usr/bin/env bash
set -Eeuo pipefail
root='/opt/chi-shen-me'
[[ ! -e /root/private/reject-preflight ]] || exit 3
grep -qx 'DATABASE_URL=synthetic-fixture' "$root/shared/secrets/api.env"
grep -qx 'OTHER_SETTING=preserved' "$root/shared/secrets/api.env"
[[ "$(stat -c '%a:%u:%g' "$root/shared/secrets/api.env")" == '600:0:0' ]]
PREFLIGHT
chmod 700 "$deploy/scripts/preflight-deployment.sh"
(cd "$deploy"; sha256sum scripts/*.sh >SHA256SUMS)
updater="$deploy/scripts/update-mimo-secrets.sh"
"$updater" --enable --key-file /root/private/mimo-input >/root/private/result
grep -qx 'MIMO_ENABLED=true' "$deploy/deployment.env"
grep -qx 'MIMO_API_KEY=synthetic-mimo-key' "$secret"
grep -qx 'MIMO_CONFIGURATION_UPDATED=enable' /root/private/result
! grep -q 'synthetic-mimo-key' /root/private/result
"$updater" --disable >/root/private/result
grep -qx 'MIMO_ENABLED=false' "$deploy/deployment.env"
grep -qx 'MIMO_API_KEY=synthetic-mimo-key' "$secret"
before="$(sha256sum "$secret" "$deploy/deployment.env")"
assert_rejected() {
  local expected="$1" status=0
  shift
  "$@" >/root/private/result 2>&1 || status="$?"
  [[ "$status" -ne 0 ]] || { printf 'unexpected fixture success\n' >&2; exit 1; }
  grep -Fq -- "$expected" /root/private/result
  [[ "$(sha256sum "$secret" "$deploy/deployment.env")" == "$before" ]]
  ! grep -q 'synthetic-mimo-key' /root/private/result
}
chmod 640 /root/private/mimo-input
assert_rejected 'key input must be' "$updater" --enable --key-file /root/private/mimo-input
chmod 600 /root/private/mimo-input
printf '1234567\n' >/root/private/mimo-invalid
chmod 600 /root/private/mimo-invalid
assert_rejected 'invalid MiMo key shape' "$updater" --enable --key-file /root/private/mimo-invalid
printf '%0513d\n' 0 >/root/private/mimo-invalid
assert_rejected 'invalid MiMo key shape' "$updater" --enable --key-file /root/private/mimo-invalid
ln -s /root/private/mimo-input /root/private/mimo-link
assert_rejected 'key input must be' "$updater" --enable --key-file /root/private/mimo-link
touch /root/private/reject-preflight
assert_rejected 'restoring prior files' "$updater" --enable --key-file /root/private/mimo-input
rm /root/private/reject-preflight
exec 8<>/run/lock/chi-shen-me/mutation.lock
flock -n 8
assert_rejected 'another deployment mutation' "$updater" --enable --key-file /root/private/mimo-input
flock -u 8
ln -sfn "$root/releases/mimo-fixture" "$root/current"
assert_rejected 'inactive candidate' "$updater" --enable --key-file /root/private/mimo-input
printf 'MIMO_UPDATER_ISOLATED_FIXTURE=PASS\n'
