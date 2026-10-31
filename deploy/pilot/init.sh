#!/bin/sh
# Writes hatti.env for the pilot (ADR-989) from hatti.env.example: the platform's domain and the
# email Let's Encrypt writes to filled in, and every password and key generated afresh, so none is
# ever shared between machines or kept in the repository. Refuses to overwrite one that exists.
#
#   ./init.sh example.pk ops@example.pk
set -eu
cd "$(dirname "$0")"

domain=${1:?Give the platform domain, e.g. example.pk}
email=${2:?Give the email the certificate authority may write to}
case "$domain" in
  *[!a-z0-9.-]* | .* | *. ) echo "$domain is not a domain name in lower case" >&2; exit 1 ;;
esac
if [ -e hatti.env ]; then
  echo 'hatti.env exists: move it away first, or edit it' >&2
  exit 1
fi

# Passwords in hex, safe in a URL; keys in base64, as the core reads them.
hex() { openssl rand -hex 24; }
key() { openssl rand -base64 32; }

umask 077
sed -e "s|__DOMAIN__|$domain|g" \
    -e "s|__EMAIL__|$email|g" \
    -e "s|__POSTGRES_PASSWORD__|$(hex)|g" \
    -e "s|__APP_PASSWORD__|$(hex)|g" \
    -e "s|__SYSTEM_PASSWORD__|$(hex)|g" \
    -e "s|__IDENTITY_PASSWORD__|$(hex)|g" \
    -e "s|__ENCRYPTION_KEY__|$(key)|g" \
    -e "s|__STOREFRONT_SERVICE_KEY__|$(hex)|g" \
    hatti.env.example > hatti.env
echo "hatti.env written. Set its S3_* settings (OWN-27), then: docker compose up -d --build"
