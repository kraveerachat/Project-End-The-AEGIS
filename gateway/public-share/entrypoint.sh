#!/bin/sh
# AEGIS PUBLIC-SHARE-3 gateway entrypoint.
#
# The PUBLIC_SHARE_HOST allowlist boundary is validated here, before the stock
# nginx entrypoint renders /etc/nginx/templates/nginx.conf.template with
# envsubst. Gating in this wrapper rather than only in /docker-entrypoint.d
# keeps the refusal independent of the base image's own error handling: an
# invalid value can never reach template rendering, so nginx never starts with
# a generated config that the value could have altered.
#
# PUBLIC-SHARE-7 adds the second gate. The edge trust model — direct peer, or a
# managed tunnel with one pinned connector — is validated and GENERATED into
# /tmp/aegis-edge/http.conf, which the template includes. Both gates run before
# the handover, and `set -eu` means either refusal stops the container before
# nginx exists. The include path is fixed here rather than read from the
# environment, so no operator value selects which trust file nginx loads.
set -eu

/usr/local/bin/aegis-validate-public-share-host.sh
/usr/local/bin/aegis-validate-public-share-edge.sh /tmp/aegis-edge

exec /docker-entrypoint.sh "$@"
