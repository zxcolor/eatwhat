#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

printf 'LEGACY_MAIN_VHOST_ACTIVATION_DISABLED=true\n' >&2
printf 'This retired command can never modify www.unfinished-era.com. Use activate-api-subdomain-nginx.sh after dedicated API TLS is ready.\n' >&2
exit 64
