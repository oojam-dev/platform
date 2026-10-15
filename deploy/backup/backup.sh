#!/usr/bin/env bash
# oojam backups (SPEC §3.3).
#
#   backup.sh loop     default: wait for BACKUP_TIME (UTC) each day, then back up
#   backup.sh now      back up immediately, once (docker compose exec backup backup.sh now)
#   backup.sh health   healthcheck: exit 0 unless the last success is overdue
#
# Each run: `pg_dump -Fc` of `platform` and `site` into
#   $BACKUP_DIR/platform-YYYYMMDD.dump, $BACKUP_DIR/site-YYYYMMDD.dump
# (written to a temp file, then renamed, so a file with that name is always
# complete), keeps the newest BACKUP_KEEP_DAYS of each, prunes the worker's
# site-predeploy-*.dump older than that (always keeping the newest 3), and, when
# BACKUP_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY are all set, copies the new
# dumps off-box with rclone (encrypted with rclone crypt when
# BACKUP_ENCRYPTION_PASSWORD is set).
#
# Monitoring markers in $BACKUP_DIR:
#   .last-success   UTC time and epoch of the last complete run (dumps + upload)
#   .last-upload    the same, for the last off-box copy
#   .last-error     the last failure's time and message (removed on success)
#
# Env:
#   PGHOST (postgres), PGPORT (5432), PGUSER (backup), PGPASSWORD   read-only role (pg_read_all_data)
#   BACKUP_DIR (/opt/oojam/data/backups)  BACKUP_TIME (03:30)  BACKUP_KEEP_DAYS (14)
#   BACKUP_S3_ENDPOINT  BACKUP_S3_BUCKET  BACKUP_S3_ACCESS_KEY  BACKUP_S3_SECRET_KEY
#   BACKUP_S3_REGION (optional)  BACKUP_S3_PREFIX (oojam)  BACKUP_ENCRYPTION_PASSWORD (optional)
set -Eeuo pipefail

export TZ=UTC
export PGHOST=${PGHOST:-postgres} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-backup}
export PGCONNECT_TIMEOUT=10
BACKUP_DIR=${BACKUP_DIR:-/opt/oojam/data/backups}
BACKUP_TIME=${BACKUP_TIME:-03:30}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX:-oojam}
DATABASES=(platform site)
STARTED_FILE=/tmp/backup-started

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

mark() { # name [message]
  local f="$BACKUP_DIR/.$1"
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%s)" "${2:-}" > "$f.tmp"
  mv "$f.tmp" "$f"
}

s3_configured() {
  [[ -n ${BACKUP_S3_ENDPOINT:-} && -n ${BACKUP_S3_BUCKET:-} && -n ${BACKUP_S3_ACCESS_KEY:-} && -n ${BACKUP_S3_SECRET_KEY:-} ]]
}

# rclone remotes from the environment only: nothing is written to disk.
# Sets RCLONE_TARGET (call it directly, not in a subshell: it exports).
rclone_setup() {
  export RCLONE_CONFIG_OOJAMS3_TYPE=s3
  export RCLONE_CONFIG_OOJAMS3_PROVIDER=Other
  export RCLONE_CONFIG_OOJAMS3_ENDPOINT=$BACKUP_S3_ENDPOINT
  export RCLONE_CONFIG_OOJAMS3_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY
  export RCLONE_CONFIG_OOJAMS3_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_KEY
  export RCLONE_CONFIG_OOJAMS3_REGION=${BACKUP_S3_REGION:-}
  export RCLONE_CONFIG_OOJAMS3_NO_CHECK_BUCKET=true
  local base="oojams3:$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX"
  if [[ -n ${BACKUP_ENCRYPTION_PASSWORD:-} ]]; then
    export RCLONE_CONFIG_OOJAMCRYPT_TYPE=crypt
    export RCLONE_CONFIG_OOJAMCRYPT_REMOTE=$base
    RCLONE_CONFIG_OOJAMCRYPT_PASSWORD=$(rclone obscure "$BACKUP_ENCRYPTION_PASSWORD")
    export RCLONE_CONFIG_OOJAMCRYPT_PASSWORD
    RCLONE_TARGET="oojamcrypt:"
  else
    RCLONE_TARGET=$base
  fi
}

prune() {
  local db keep=$BACKUP_KEEP_DAYS
  for db in "${DATABASES[@]}"; do
    # Daily dumps are named <db>-YYYYMMDD.dump, so name order is date order.
    mapfile -t old < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$db-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump" -printf '%f\n' | sort -r | tail -n +"$((keep + 1))")
    for f in "${old[@]}"; do
      log "pruning $f"; rm -f -- "${BACKUP_DIR:?}/$f"
    done
  done
  # Pre-deploy dumps (written by the worker, SPEC §7 step 2): keep the newest 3
  # whatever their age, drop the rest once older than BACKUP_KEEP_DAYS.
  mapfile -t predeploy < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'site-predeploy-*.dump' -printf '%T@ %f\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
  for f in "${predeploy[@]}"; do
    if [[ -n $(find "$BACKUP_DIR/$f" -mtime +"$keep" 2>/dev/null) ]]; then
      log "pruning $f"; rm -f -- "${BACKUP_DIR:?}/$f"
    fi
  done
  # Leftovers from an interrupted run.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '.*.dump.partial' -mmin +360 -delete 2>/dev/null || true
}

run_backup() {
  local day db tmp out files=()
  day=$(date -u +%Y%m%d)
  mkdir -p "$BACKUP_DIR"
  chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
  umask 077
  for db in "${DATABASES[@]}"; do
    out="$BACKUP_DIR/$db-$day.dump"
    tmp="$BACKUP_DIR/.$db-$day.dump.partial"
    log "dumping $db"
    if ! pg_dump --format=custom --compress=6 --no-password --dbname "$db" --file "$tmp"; then
      rm -f -- "$tmp"
      mark last-error "pg_dump $db failed"
      log "pg_dump $db FAILED"
      return 1
    fi
    # A dump that pg_restore can't list is no backup.
    if ! pg_restore --list "$tmp" >/dev/null; then
      rm -f -- "$tmp"
      mark last-error "pg_restore --list $db failed (corrupt dump)"
      log "dump of $db is unreadable"
      return 1
    fi
    mv -f -- "$tmp" "$out"
    files+=("$out")
    log "wrote $out ($(du -h "$out" | cut -f1))"
  done

  prune

  if s3_configured; then
    rclone_setup
    for out in "${files[@]}"; do
      log "uploading $(basename "$out")"
      if ! rclone copyto --s3-upload-cutoff 64M --retries 3 --low-level-retries 3 --contimeout 30s --timeout 5m \
             "$out" "$RCLONE_TARGET/$(basename "$out")"; then
        mark last-error "upload of $(basename "$out") failed"
        log "upload FAILED"
        return 1
      fi
    done
    mark last-upload
  else
    log "BACKUP_S3_* not set: local copies only"
  fi

  mark last-success
  rm -f -- "$BACKUP_DIR/.last-error"
  log "done"
}

seconds_until_next_run() {
  local now target
  now=$(date -u +%s)
  target=$(date -u -d "today $BACKUP_TIME" +%s)
  if (( target <= now )); then
    target=$(date -u -d "tomorrow $BACKUP_TIME" +%s)
  fi
  echo $((target - now))
}

health() {
  # Healthy while the last success is under 26 hours old, or the container
  # started less than 26 hours ago and hasn't had its first nightly run yet.
  local limit=$((26 * 3600)) now last started
  now=$(date -u +%s)
  if [[ -f $BACKUP_DIR/.last-success ]]; then
    last=$(awk '{print $2}' "$BACKUP_DIR/.last-success")
    (( now - last < limit )) && return 0
  fi
  if [[ -f $STARTED_FILE ]]; then
    started=$(cat "$STARTED_FILE")
    (( now - started < limit )) && return 0
  fi
  return 1
}

case ${1:-loop} in
  now)
    run_backup
    ;;
  health)
    health
    ;;
  loop)
    if ! date -u -d "today $BACKUP_TIME" >/dev/null 2>&1; then
      log "BACKUP_TIME must be HH:MM (UTC), got '$BACKUP_TIME'"; exit 1
    fi
    date -u +%s > "$STARTED_FILE"
    log "nightly backups at $BACKUP_TIME UTC; keeping $BACKUP_KEEP_DAYS days in $BACKUP_DIR"
    s3_configured && log "off-box copies to $BACKUP_S3_ENDPOINT bucket $BACKUP_S3_BUCKET${BACKUP_ENCRYPTION_PASSWORD:+ (encrypted)}"
    trap 'log "stopping"; exit 0' TERM INT
    while true; do
      wait_s=$(seconds_until_next_run)
      log "next run in $((wait_s / 3600))h$(((wait_s % 3600) / 60))m"
      # Sleep in the background so TERM is handled immediately.
      sleep "$wait_s" & wait $!
      run_backup || log "backup failed; will try again at the next scheduled time"
      sleep 61 & wait $!
    done
    ;;
  *)
    echo "usage: backup.sh [loop|now|health]" >&2; exit 2
    ;;
esac
