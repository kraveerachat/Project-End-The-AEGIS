#!/bin/sh
# AEGIS PUBLIC-SHARE-3 — fail-closed PUBLIC_SHARE_HOST validation.
#
# PUBLIC_SHARE_HOST is substituted into nginx *directive context*
# (server_name, proxy_set_header Host, proxy_set_header X-Forwarded-Host).
# The value is not a secret, but it is an allowlist boundary: a malformed
# value could widen the accepted Host set, alter nginx parsing, inject an
# extra directive or location, or turn this single-host gateway into
# virtual-host multiplexing. This runs before the template is rendered and
# refuses to start rather than silently sanitizing a bad value.
#
# Contract: PUBLIC_SHARE_HOST is a hostname only. No scheme, port, path,
# query, fragment, credential, wildcard, nginx regex prefix, or list. It must
# equal the hostname component of the backend's validated
# PUBLIC_SHARE_BASE_URL.
set -eu

# The rejected value is never echoed back. It is operator/attacker-influenced
# input and could itself carry newlines; the reason is enough to fix a typo.
deny() {
    printf '%s\n' "aegis-public-share: refusing to start: PUBLIC_SHARE_HOST $1" >&2
    exit 1
}

host="${PUBLIC_SHARE_HOST-}"

[ -n "$host" ] || deny 'is unset or empty; one DNS hostname is required'

# RFC 1035 presentation limit.
[ "${#host}" -le 253 ] || deny 'is longer than the 253-character hostname limit'

# Strict allowlist, one character at a time. Ranges are avoided so the class
# cannot widen under a different locale. This single loop is what rejects
# space, tab, CR, LF, ";", "{", "}", "$", "/", "\", "*", "~", ":", "@", "?",
# "#", "%", quotes, and every other byte outside the hostname alphabet, so
# lists, schemes, ports, paths, queries, fragments, credentials, wildcards,
# nginx regex prefixes, and directive injection all fail here.
rest="$host"
while [ -n "$rest" ]; do
    char="${rest%"${rest#?}"}"
    case "$char" in
        [0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-]) ;;
        *) deny 'contains a character outside the hostname alphabet [A-Za-z0-9.-]' ;;
    esac
    rest="${rest#?}"
done

case "$host" in
    .*) deny 'must not begin with a dot' ;;
    *.) deny 'must not end with a dot' ;;
    *..*) deny 'contains an empty label' ;;
esac

# Every label is now non-empty. Check RFC 1123 label shape and length.
label=''
rest="$host."
while [ -n "$rest" ]; do
    label="${rest%%.*}"
    rest="${rest#*.}"
    [ "${#label}" -le 63 ] || deny 'has a label longer than 63 characters'
    case "$label" in
        -*) deny 'has a label beginning with a hyphen' ;;
        *-) deny 'has a label ending with a hyphen' ;;
    esac
done

# An RFC 1123 host name cannot end in an all-numeric label. This also keeps a
# bare IPv4 literal out of the hostname-only contract. "$label" is the last
# label because the loop above walked every label in order.
case "$label" in
    *[!0123456789]*) ;;
    *) deny 'ends in an all-numeric label; a DNS hostname is required, not an IP literal' ;;
esac

exit 0
