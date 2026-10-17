#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

# This allowlist is specific to verified PostgreSQL 17 / PostGIS 3.5 backups.
# Never turn archive contents into privileged SQL or silently discard data.
prepare_restore_extension_plan() {
  local input="$1" output="$2" expected_owner="$3"
  local line id payload name schema object owner key extension toc_contents csv=''
  local -A ids=() extensions=() schemas=() config=()
  # Read completely before parsing: an I/O error must not look like an early EOF.
  toc_contents="$(cat -- "$input")" || return 1
  : >"$output" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == \;* ]]; then
      printf '%s\n' "$line" >>"$output" || return 1
      continue
    fi
    [[ "$line" =~ ^([0-9]+)\;[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+(.+)$ ]] || {
      printf 'invalid restore TOC record\n' >&2; return 1;
    }
    id="${BASH_REMATCH[1]}"; payload="${BASH_REMATCH[2]}"
    [[ ! -v "ids[$id]" ]] || { printf 'duplicate restore TOC ID\n' >&2; return 1; }
    ids[$id]=1
    if [[ "$payload" =~ ^EXTENSION[[:space:]]+-[[:space:]]+([a-z_]+)[[:space:]]*$ ]]; then
      name="${BASH_REMATCH[1]}"
      case "$name" in pgcrypto|postgis|fuzzystrmatch|postgis_tiger_geocoder|postgis_topology) ;;
        *) printf 'unsupported restore extension: %s\n' "$name" >&2; return 1;; esac
      [[ ! -v "extensions[$name]" ]] || { printf 'duplicate restore extension\n' >&2; return 1; }
      extensions[$name]=1
      continue
    elif [[ "$payload" == EXTENSION* ]]; then
      printf 'unsupported restore extension record\n' >&2; return 1
    fi
    if [[ "$payload" =~ ^SCHEMA[[:space:]]+-[[:space:]]+(tiger|topology)[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then
      name="${BASH_REMATCH[1]}"; owner="${BASH_REMATCH[2]}"
      [[ "$owner" == "$expected_owner" && ! -v "schemas[$name]" ]] || {
        printf 'unexpected extension schema owner or duplicate schema\n' >&2; return 1;
      }
      schemas[$name]=1
      continue
    fi
    if [[ "$payload" =~ ^(TABLE[[:space:]]DATA|SEQUENCE[[:space:]]SET)[[:space:]]+([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then
      key="${BASH_REMATCH[1]}"; schema="${BASH_REMATCH[2]}"; object="${BASH_REMATCH[3]}"; owner="${BASH_REMATCH[4]}"
      case "$key:$schema.$object" in
        'TABLE DATA:public.spatial_ref_sys'|'TABLE DATA:tiger.geocode_settings'|'TABLE DATA:tiger.pagc_gaz'|'TABLE DATA:tiger.pagc_lex'|'TABLE DATA:tiger.pagc_rules'|'TABLE DATA:topology.topology'|'TABLE DATA:topology.layer'|'SEQUENCE SET:topology.topology_id_seq')
          [[ "$owner" == "$expected_owner" && ! -v "config[$schema.$object]" ]] || {
            printf 'unexpected extension configuration owner or duplicate data\n' >&2; return 1;
          }
          config[$schema.$object]=1
          printf '%s\n' "$line" >>"$output" || return 1
          continue;;
      esac
    fi
    # Comments are ignored by --no-comments. All other objects in protected
    # schemas must be the exact extension configuration entries above.
    if [[ "$payload" != COMMENT\ * && ( "$payload" =~ [[:space:]](tiger|topology|tiger_data)[[:space:]] || "$payload" =~ [[:space:]]spatial_ref_sys[[:space:]] ) ]]; then
      printf 'unsupported object in an extension namespace\n' >&2; return 1
    fi
    printf '%s\n' "$line" >>"$output" || return 1
  done <<<"$toc_contents"
  [[ -v extensions[pgcrypto] && -v extensions[postgis] && -v config[public.spatial_ref_sys] ]] || {
    printf 'required restore extensions or configuration data are missing\n' >&2; return 1;
  }
  if [[ -v extensions[postgis_tiger_geocoder] ]]; then
    [[ -v extensions[fuzzystrmatch] && -v schemas[tiger] ]] || return 1
    for object in geocode_settings pagc_gaz pagc_lex pagc_rules; do
      [[ -v "config[tiger.$object]" ]] || { printf 'missing tiger configuration data\n' >&2; return 1; }
    done
  elif [[ -v schemas[tiger] || -v config[tiger.geocode_settings] || -v config[tiger.pagc_gaz] || -v config[tiger.pagc_lex] || -v config[tiger.pagc_rules] ]]; then
    printf 'tiger data has no matching extension\n' >&2; return 1
  fi
  if [[ -v extensions[postgis_topology] ]]; then
    [[ -v schemas[topology] && -v config[topology.topology] && -v config[topology.layer] && -v config[topology.topology_id_seq] ]] || {
      printf 'missing topology configuration data\n' >&2; return 1;
    }
  elif [[ -v schemas[topology] || -v config[topology.topology] || -v config[topology.layer] || -v config[topology.topology_id_seq] ]]; then
    printf 'topology data has no matching extension\n' >&2; return 1
  fi
  for extension in pgcrypto postgis fuzzystrmatch postgis_tiger_geocoder postgis_topology; do
    if [[ -v "extensions[$extension]" ]]; then csv+="${csv:+,}$extension"; fi
  done
  printf '%s\n' "$csv" || return 1
}
