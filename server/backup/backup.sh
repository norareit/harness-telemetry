#!/usr/bin/env bash
# Nightly dump of the harness telemetry database (plans/019). Runs on the server,
# from harness-db-backup.timer or by hand before a manual fix.
#
# Writes harness-telemetry-<UTC timestamp>.dump (pg_dump custom format) to
# $HARNESS_BACKUP_DIR, checks that pg_restore can read it, and keeps the newest
# $HARNESS_BACKUP_KEEP. Clients pull the finished files with
# `harness-usage pull-backup`; a dump in progress is a .tmp file they ignore.

set -euo pipefail

DEST="${HARNESS_BACKUP_DIR:-$HOME/backups/harness-telemetry}"
KEEP="${HARNESS_BACKUP_KEEP:-14}"
COMPOSE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"

compose() { docker compose -f "$COMPOSE" "$@"; }

mkdir -p "$DEST"
name="harness-telemetry-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$DEST/$name.tmp"
trap 'rm -f "$tmp"' EXIT

# Single quotes on purpose: the variables expand inside the container.
# shellcheck disable=SC2016
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$tmp"

# pg_restore --list reads the whole table of contents: a truncated or garbled
# dump fails here instead of on the day it is needed.
# Under set -e a failing pg_restore ends the script here, and the trap removes
# the .tmp file. Entry lines start with their dump ID; comments with ';'.
listing=$(compose exec -T postgres pg_restore --list < "$tmp")
entries=$(grep -c '^[0-9]' <<< "$listing" || true)
if [ "$entries" -eq 0 ]; then
  echo "backup.sh: $name has no entries; not kept" >&2
  exit 1
fi

mv "$tmp" "$DEST/$name"

# Names sort by time, so everything before the last $KEEP is older.
mapfile -t dumps < <(find "$DEST" -maxdepth 1 -name 'harness-telemetry-*.dump' -printf '%f\n' | sort)
for ((i = 0; i < ${#dumps[@]} - KEEP; i++)); do
  rm -f "$DEST/${dumps[i]}"
done

echo "$name $(du -h "$DEST/$name" | cut -f1) ($entries entries)"
