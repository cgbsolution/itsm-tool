#!/usr/bin/env sh
# Backup of a docker compose install: database (pg_dump custom format) + uploaded files.
#   ./scripts/backup.sh [backup-dir]
# Restore: see docs/OPERATIONS.md. Keep APP_SECRET with the backup (it decrypts stored secrets).
set -eu
DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$DIR"
docker compose exec -T db pg_dump -U itsm -d itsm -Fc > "$DIR/itsm-db-$STAMP.dump"
docker compose exec -T app tar -C /data -czf - files > "$DIR/itsm-files-$STAMP.tar.gz"
echo "Wrote $DIR/itsm-db-$STAMP.dump and $DIR/itsm-files-$STAMP.tar.gz"
# keep 14 days
find "$DIR" -name 'itsm-*' -mtime +14 -delete 2>/dev/null || true
