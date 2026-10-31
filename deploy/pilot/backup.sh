#!/bin/sh
# Backs up the pilot's database (ADR-989): a compressed dump of it, in backups/, named by the time
# it was made, those older than KEEP_DAYS (14) removed. Run it from cron, e.g. every six hours:
#
#   0 */6 * * * cd /srv/hatti/deploy/pilot && ./backup.sh >> backups/backup.log 2>&1
#
# Then copy backups/ off the machine (rclone, open source, to the S3 bucket or another), as a dump
# kept on the machine it backs up is lost with it. Files shops upload are in S3, not here; queues
# in Valkey are kept on its volume and their jobs come again from the outbox if lost.
set -eu
cd "$(dirname "$0")"
keep=${KEEP_DAYS:-14}
mkdir -p backups
file="backups/hatti-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U postgres --format=custom --compress=9 hatti > "$file.part"
mv "$file.part" "$file"
find backups -name 'hatti-*.dump' -mtime +"$keep" -delete
echo "Backed up to $file ($(du -h "$file" | cut -f1))"
