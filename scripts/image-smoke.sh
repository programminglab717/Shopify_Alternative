#!/bin/sh
# Runs the container images as a cell runs them (ADR-724), against the Postgres and Valkey that
# .env.example names on this machine, as CI's services are: the core's image sets up and migrates
# an empty database and seeds a shop, then serves the API and runs the worker, and the storefront's
# image, in production, serves the seeded shop's home page. Build the images first:
#
#   docker build --target core -t hatti-core:ci .
#   docker build --target storefront -t hatti-storefront:ci .
#   scripts/image-smoke.sh
set -eu

core=${CORE_IMAGE:-hatti-core:ci}
storefront=${STOREFRONT_IMAGE:-hatti-storefront:ci}
# Docker's --env-file takes KEY=value lines alone. The core runs as in development, whose files
# are kept in a directory, here one its unprivileged user may write; production keeps them in R2.
settings=$(mktemp)
grep -v -e '^#' -e '^$' -e '^STORAGE_DIRECTORY=' .env.example > "$settings"
echo STORAGE_DIRECTORY=/tmp/storage >> "$settings"
setting() { grep "^$1=" "$settings" | cut -d= -f2-; }

run() { docker run --rm --network host --env-file "$settings" "$@"; }
start() {
  name=$1
  shift
  docker run -d --name "$name" --network host --env-file "$settings" "$@" > /dev/null
}
ready() {
  for _ in $(seq 60); do
    if curl -fsS "$1" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$1 never answered" >&2
  return 1
}
cleanup() {
  status=$?
  for name in hatti-api hatti-worker hatti-storefront; do
    if [ "$status" -ne 0 ]; then docker logs "$name" 2>&1 | tail -n 40; fi
    docker rm -f "$name" > /dev/null 2>&1 || true
  done
  rm -f "$settings"
}
trap cleanup EXIT

run "$core" node /app/packages/platform/db/dist/cli/setup.js
run "$core" node /app/packages/platform/db/dist/cli/migrate.js
handle=$(run "$core" node dist/seed.js | grep -o 'hatti-demo-bazaar-[0-9a-f]*' | head -n 1)
test -n "$handle"

start hatti-api "$core"
start hatti-worker "$core" node --import ./dist/instrumentation.js dist/worker.js
# The storefront as in production, its image's NODE_ENV, with only what it reads.
docker run -d --name hatti-storefront --network host \
  -e STOREFRONT_URL=http://localhost:4100 -e CORE_API_URL=http://localhost:4000 \
  -e REDIS_URL="$(setting REDIS_URL)" -e STOREFRONT_SERVICE_KEY="$(setting STOREFRONT_SERVICE_KEY)" \
  "$storefront" > /dev/null

ready http://localhost:4000/readyz
ready http://localhost:4100/readyz
curl -fsS -o /dev/null -H "Host: $handle.localhost:4100" http://localhost:4100/
curl -fsS -o /dev/null -H "Host: $handle.localhost:4100" http://localhost:4100/ur/
test "$(docker inspect -f '{{.State.Running}}' hatti-worker)" = true
echo "The images serve $handle"
