#!/bin/sh
# Restores the pilot's database from a dump backup.sh made (ADR-989), after asking. The API, the
# worker and the storefront are stopped while it runs, and started again after; the storefront's
# pages are then republished by the worker from the database.
#
#   ./restore.sh backups/hatti-20270215T060000Z.dump
set -eu
cd "$(dirname "$0")"
dump=${1:?Give the dump to restore, e.g. backups/hatti-20270215T060000Z.dump}
test -f "$dump" || { echo "$dump is not a file" >&2; exit 1; }

printf 'This replaces everything in the database with %s. Type restore to go on: ' "$dump"
read -r answer
test "$answer" = restore || { echo 'Nothing changed.'; exit 1; }

docker compose stop api worker storefront
docker compose exec -T postgres pg_restore -U postgres --clean --if-exists --no-owner \
  --role=postgres -d hatti < "$dump"
# Logins and migrations as hatti.env and the code say, then everything started again.
docker compose run --rm setup
docker compose up -d
echo "Restored $dump"
