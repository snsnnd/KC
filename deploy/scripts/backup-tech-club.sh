#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 0077

readonly SERVICE_NAME="tech-club-cms.service"
readonly DATA_DIR="/var/lib/tech-club"
readonly ENV_FILE="/etc/tech-club-cms.env"
readonly BACKUP_DIR="/var/backups/tech-club"
readonly RETENTION_DAYS=30

raw_tmp=""
compressed_tmp=""
service_was_active=0

fail() {
    printf 'backup-tech-club: %s\n' "$*" >&2
    exit 1
}

restart_service() {
    if ((service_was_active)); then
        /usr/bin/systemctl start "$SERVICE_NAME"
        /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"
        service_was_active=0
    fi
}

cleanup() {
    local status=$?
    local cleanup_status
    local active_status
    trap - EXIT
    trap '' INT TERM
    set +e

    # Restore availability first. Temporary-file cleanup must never prevent restart.
    if ((service_was_active)); then
        /usr/bin/systemctl start "$SERVICE_NAME"
        cleanup_status=$?
        /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"
        active_status=$?
        if ((cleanup_status != 0 || active_status != 0)); then
            printf 'backup-tech-club: failed to restore active state for %s\n' "$SERVICE_NAME" >&2
            status=1
        else
            service_was_active=0
        fi
    fi

    if [[ -n "$raw_tmp" ]] && ! rm -f -- "$raw_tmp"; then
        printf 'backup-tech-club: failed to remove temporary file %s\n' "$raw_tmp" >&2
        status=1
    fi
    if [[ -n "$compressed_tmp" ]] && ! rm -f -- "$compressed_tmp"; then
        printf 'backup-tech-club: failed to remove temporary file %s\n' "$compressed_tmp" >&2
        status=1
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $EUID -eq 0 ]] || fail "must run as root"
[[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail "data directory must be a directory, not a symlink: $DATA_DIR"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "environment file must be a regular, non-symlink file: $ENV_FILE"
[[ $(/usr/bin/stat -c '%u:%g' "$ENV_FILE") == "0:0" ]] || fail "environment file must be owned by root:root: $ENV_FILE"
[[ $(/usr/bin/stat -c '%a' "$ENV_FILE") == "600" ]] || fail "environment file mode must be 0600: $ENV_FILE"
[[ ! -L "$BACKUP_DIR" ]] || fail "backup directory must not be a symlink: $BACKUP_DIR"
[[ $(/usr/bin/systemctl show --property=LoadState --value "$SERVICE_NAME") == "loaded" ]] || fail "systemd service is not loaded: $SERVICE_NAME"

case "$BACKUP_DIR" in
    /var/www|/var/www/*) fail "backup directory must not be under the web root" ;;
esac

/usr/bin/install -d -o root -g root -m 0700 "$BACKUP_DIR"
/usr/bin/install -d -o root -g root -m 0700 "/run/tech-club-backup"
exec 9>"/run/tech-club-backup/backup.lock"
/usr/bin/flock -n 9 || fail "another backup is already running"

timestamp=$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)
archive="$BACKUP_DIR/tech-club-${timestamp}.tar.gz"
[[ ! -e "$archive" ]] || fail "backup already exists: $archive"

raw_tmp=$(/usr/bin/mktemp "$BACKUP_DIR/.tech-club-${timestamp}.XXXXXX.tar")
compressed_tmp=$(/usr/bin/mktemp "$BACKUP_DIR/.tech-club-${timestamp}.XXXXXX.tar.gz")
/usr/bin/chmod 0600 "$raw_tmp" "$compressed_tmp"

if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
    service_was_active=1
    if ! /usr/bin/systemctl stop "$SERVICE_NAME"; then
        fail "failed to stop $SERVICE_NAME; no archive was created"
    fi
    if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
        fail "$SERVICE_NAME is still active after stop; no archive was created"
    fi
    stop_result=$(/usr/bin/systemctl show --property=Result --value "$SERVICE_NAME")
    [[ "$stop_result" == "success" ]] || fail "$SERVICE_NAME did not stop cleanly (Result=$stop_result); no archive was created"
fi

# Stop only while copying mutable files; compression and verification happen after restart.
/usr/bin/tar -C / -cf "$raw_tmp" "${DATA_DIR#/}" "${ENV_FILE#/}"
restart_service

/usr/bin/gzip -c "$raw_tmp" > "$compressed_tmp"
rm -f -- "$raw_tmp"
raw_tmp=""
/usr/bin/tar -tzf "$compressed_tmp" >/dev/null
/usr/bin/chmod 0600 "$compressed_tmp"
/usr/bin/mv -- "$compressed_tmp" "$archive"
compressed_tmp=""

/usr/bin/find "$BACKUP_DIR" -maxdepth 1 -type f -name 'tech-club-*.tar.gz' -mmin "+$((RETENTION_DAYS * 24 * 60))" -delete
printf 'backup-tech-club: created %s\n' "$archive"
