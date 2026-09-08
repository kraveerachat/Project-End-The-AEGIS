#!/bin/sh
# AEGIS PUBLIC-SHARE-3 gateway entrypoint.
#
# The PUBLIC_SHARE_HOST allowlist boundary is validated here, before the stock
# nginx entrypoint renders /etc/nginx/templates/nginx.conf.template with
# envsubst. Gating in this wrapper rather than only in /docker-entrypoint.d
# keeps the refusal independent of the base image's own error handling: an
# invalid value can never reach template rendering, so nginx never starts with
# a generated config that the value could have altered.
set -eu

/usr/local/bin/aegis-validate-public-share-host.sh

exec /docker-entrypoint.sh "$@"
