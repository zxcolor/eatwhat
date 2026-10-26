assert_web_browser_cutover_ready() {
  [[ -n "$web_browser_rollback_release" ]] ||
    die 'schema 0016 requires explicit --web-browser-cutover with a schema 0017 compatible rollback release'
  [[ "$(read_deployment_value AUTH_SCHEMA_TRANSITION_MODE)" == 'none' ]] ||
    die 'WEB browser cutover requires final authentication mode'
  local active_release candidate_image_id backup_output recorded_release recorded_database_facts
  candidate_image_id="$(read_deployment_value API_IMAGE_ID)"
  [[ "$web_browser_rollback_release/deploy" != "$bundle_root" ]] ||
    die 'candidate release cannot also be its rollback release'
  "$script_dir/verify-rollback-release.sh" "$web_browser_rollback_release" \
    --target-image "$candidate_image_id" >/dev/null
  [[ -L /opt/chi-shen-me/current &&
     "$(stat -c '%u:%g' /opt/chi-shen-me/current)" == '0:0' ]] ||
    die 'WEB browser cutover requires a root-owned active release link'
  active_release="$(realpath -e -- /opt/chi-shen-me/current)"
  "$script_dir/verify-rollback-release.sh" "$active_release" >/dev/null
  "$active_release/deploy/scripts/verify-runtime.sh" >/dev/null

  # The existing mutation lock remains held through backup, migration and ACLs.
  backup_output="$("$active_release/deploy/scripts/backup-database.sh" --mutation-lock-held)"
  web_browser_cutover_backup="$(sed -n 's/^BACKUP_DIRECTORY=//p' <<<"$backup_output")"
  [[ "$web_browser_cutover_backup" == /opt/chi-shen-me/backups/postgres/* ]] ||
    die 'WEB browser cutover backup did not complete'
  "$script_dir/verify-database-backup.sh" "$web_browser_cutover_backup" >/dev/null
  recorded_release="$(sed -n 's/^release_path=//p' "$web_browser_cutover_backup/METADATA.txt")"
  recorded_database_facts="$(sed -n 's/^database_facts=//p' "$web_browser_cutover_backup/METADATA.txt")"
  [[ "$recorded_release" == "$active_release" &&
     "$recorded_database_facts" =~ ^chi_shen_me\|[0-9]+\|16$ &&
     "$(wc -l <"$web_browser_cutover_backup/SCHEMA_MIGRATIONS.txt")" -eq 16 &&
     "$(tail -n 1 "$web_browser_cutover_backup/SCHEMA_MIGRATIONS.txt")" =~ ^16\|canteen_public_ratings\|[0-9a-f]{64}$ ]] ||
    die 'WEB browser cutover backup does not match the active exact schema 0016 release'
  [[ "$(realpath -e -- /opt/chi-shen-me/current)" == "$active_release" ]] ||
    die 'active release changed during WEB browser cutover preparation'
}
