#!/bin/sh
set -eu

SOURCE_DIR=${1:?usage: deploy-frontend.sh SOURCE_DIR [RELEASE_ID]}
RELEASE_ID=${2:-$(date -u +%Y%m%dT%H%M%SZ)}
DOMAIN=${DOMAIN:-www.jtkczx.xyz}
WEB_ROOT=${WEB_ROOT:-/var/www/tech-club}
RELEASES_DIR="$WEB_ROOT/releases"
CURRENT_LINK="$WEB_ROOT/current"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
TEMP_DIR="$RELEASES_DIR/.${RELEASE_ID}.tmp"
NEXT_LINK="$WEB_ROOT/.current-${RELEASE_ID}"

case "$RELEASE_ID" in (*[!A-Za-z0-9._-]*|'') echo "invalid release id" >&2; exit 1;; esac
test "$(id -u)" -eq 0 || { echo "must run as root" >&2; exit 1; }
test -d "$SOURCE_DIR" || { echo "source directory not found: $SOURCE_DIR" >&2; exit 1; }
test ! -e "$RELEASE_DIR" || { echo "release already exists: $RELEASE_DIR" >&2; exit 1; }

install -d -o root -g root -m 0755 "$WEB_ROOT" "$RELEASES_DIR" /var/www/tech-club-acme
rm -rf -- "$TEMP_DIR" "$NEXT_LINK"
trap 'rm -rf -- "$TEMP_DIR" "$NEXT_LINK"' EXIT INT TERM
install -d -o root -g root -m 0755 "$TEMP_DIR"
cp -a "$SOURCE_DIR"/. "$TEMP_DIR"/

for required in index.html portal.html admin.html join.html member.html resources.html bug-report.html assets/js/admin.js assets/css/admin.css; do
    test -f "$TEMP_DIR/$required" || { echo "missing frontend file: $required" >&2; exit 1; }
done

mv -- "$TEMP_DIR" "$RELEASE_DIR"
previous_target=""
if test -L "$CURRENT_LINK"; then previous_target=$(readlink -f "$CURRENT_LINK"); fi
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf -- "$NEXT_LINK" "$CURRENT_LINK"

if ! curl --fail --silent --show-error --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" >/dev/null \
    || ! curl --fail --silent --show-error --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null; then
    if test -n "$previous_target"; then
        ln -s "$previous_target" "$NEXT_LINK"
        mv -Tf -- "$NEXT_LINK" "$CURRENT_LINK"
    fi
    echo "frontend smoke check failed; previous release restored" >&2
    exit 1
fi

trap - EXIT INT TERM
echo "frontend release active: $RELEASE_DIR"
