#!/bin/sh
# Checks the pilot's deployment (ADR-989) as CI builds it: the proxy's image holds the admin's
# page and the headers its build writes for Caddy, Caddy reads the Caddyfile with the pilot's
# hosts, and Compose reads deploy/pilot/compose.yml with settings init.sh wrote. Build the image
# first:
#
#   docker build --target edge -t hatti-edge:ci .
#   scripts/pilot-check.sh
set -eu

edge=${EDGE_IMAGE:-hatti-edge:ci}
hosts="-e ADMIN_HOST=admin.pilot.example.pk -e API_HOST=api.pilot.example.pk \
  -e STOREFRONT_HOST=pilot.example.pk -e ACME_EMAIL=ops@example.pk"

# shellcheck disable=SC2086
docker run --rm $hosts "$edge" sh -c '
  test -s /srv/admin/index.html
  test -s /srv/admin/_headers.caddy
  grep -q "Content-Security-Policy" /srv/admin/_headers.caddy
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'

# Settings init.sh writes, made for the check and removed after it; never over a real hatti.env.
cd deploy/pilot
if [ -e hatti.env ]; then
  echo 'deploy/pilot/hatti.env exists: this check makes its own, so run it where there is none' >&2
  exit 1
fi
trap 'rm -f hatti.env' EXIT
./init.sh pilot.example.pk ops@example.pk > /dev/null
docker compose config -q
echo "The pilot's proxy and compose file check out"
