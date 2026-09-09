#!/bin/sh
# AEGIS PUBLIC-SHARE-7 — fail-closed managed-proxy edge trust for the gateway.
# Keep this file LF-only: Docker executes it inside Linux at container start.
#
# PUBLIC-SHARE-3 shipped a gateway that is the IMMEDIATE recipient-facing HTTP
# peer: `$remote_addr` IS the recipient, so `X-Forwarded-For`, `X-Real-IP` and
# the `$binary_remote_addr` edge limit are all correct by construction. That
# assumption stops holding the moment a managed HTTP tunnel (G4 Option B) is
# inserted, because then `$remote_addr` is the tunnel connector and every
# recipient collapses onto one address — wrong G3 attribution and the T-05
# rate-limit self-DoS in one step.
#
# This script decides, once at startup and before nginx renders anything, which
# of the two trust models is in force, and GENERATES the small nginx include
# that expresses it. Nothing here is substituted into the template by envsubst:
# `NGINX_ENVSUBST_FILTER=^PUBLIC_SHARE_HOST$` is unchanged, so no new operator
# value can reach nginx directive context through template substitution. The one
# value that does reach directive context — the pinned connector address — is
# validated character by character below and is emitted by this script itself.
#
# Contract:
#
#   PUBLIC_SHARE_EDGE_MODE=direct      (default, and what PUBLIC-SHARE-3 tested)
#       The gateway is the immediate peer. No provider header is trusted from
#       anyone. `$aegis_edge_deny` is defined as a constant 0, so the template's
#       managed-proxy gate is present but inert.
#
#   PUBLIC_SHARE_EDGE_MODE=cloudflare
#       Exactly one pinned tunnel-connector identity must be named in
#       PUBLIC_SHARE_EDGE_PROXY_CIDR as a single IPv4 /32. Only that immediate
#       TCP peer may assert recipient identity, and only through
#       `CF-Connecting-IP`.
#
# ⚠️ MANAGED MODE IS NEVER REACHED BY ACCIDENT. An unset, empty or misspelled
#    mode is either the direct default or a refusal — never "cloudflare".
#    Managed mode without a connector identity is a refusal. A connector
#    identity without managed mode is a refusal, because a value that looks
#    active but is ignored is how a deployment ends up trusting nothing while
#    believing it trusts one peer.
set -eu

# Where the generated include is written. An argument, not an environment
# variable: the entrypoint passes the one real path, and the structural test
# passes a throwaway directory. Nothing operator-influenced selects it.
OUT_DIR=${1:-/tmp/aegis-edge}

# The rejected value is never echoed back. It is operator/attacker-influenced
# input, may itself carry newlines, and the reason alone is enough to fix a typo.
deny() {
    printf '%s\n' "aegis-public-share: refusing to start: $1" >&2
    exit 1
}

mode=${PUBLIC_SHARE_EDGE_MODE-}
[ -n "$mode" ] || mode=direct

case "$mode" in
    direct|cloudflare) ;;
    *) deny 'PUBLIC_SHARE_EDGE_MODE must be exactly "direct" or "cloudflare"' ;;
esac

cidr=${PUBLIC_SHARE_EDGE_PROXY_CIDR-}

if [ "$mode" = direct ]; then
    # Refusing rather than ignoring. A pinned connector that is silently unused
    # reads, in a review or an incident, as a trust boundary that exists.
    [ -z "$cidr" ] || deny \
        'PUBLIC_SHARE_EDGE_PROXY_CIDR is set but PUBLIC_SHARE_EDGE_MODE is direct; a connector identity that is not used must not be configured'

    mkdir -p "$OUT_DIR" || deny 'the generated edge include directory could not be created'
    rm -f "$OUT_DIR/http.conf"
    cat > "$OUT_DIR/http.conf" <<'DIRECT'
# AEGIS Public Share Gateway — edge trust, GENERATED AT STARTUP. Do not edit.
#
# mode: direct — the gateway is the immediate recipient-facing HTTP peer.
#
# $remote_addr, $binary_remote_addr and therefore the authored X-Forwarded-For,
# X-Real-IP and edge rate-limit key are the recipient already. No forwarding or
# provider header is believed from anyone, which is exactly the PUBLIC-SHARE-3
# model this mode preserves unchanged.
map $remote_addr $aegis_edge_deny {
    default 0;
}
DIRECT
    exit 0
fi

# ── cloudflare / managed-proxy mode ──────────────────────────────────────────

[ -n "$cidr" ] || deny \
    'PUBLIC_SHARE_EDGE_PROXY_CIDR is required when PUBLIC_SHARE_EDGE_MODE=cloudflare; managed mode must pin exactly one tunnel-connector identity'

[ "${#cidr}" -le 18 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR is longer than an IPv4 host CIDR can be'

# Strict allowlist, one character at a time. Ranges are avoided so the class
# cannot widen under a different locale. This is what rejects whitespace, ";",
# "{", "}", "$", newline, a second address, a comment, and every other byte that
# could turn a generated `set_real_ip_from` into extra directives.
rest="$cidr"
while [ -n "$rest" ]; do
    char="${rest%"${rest#?}"}"
    case "$char" in
        [0123456789./]) ;;
        *) deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains a character outside [0-9./]' ;;
    esac
    rest="${rest#?}"
done

case "$cidr" in
    */*/*) deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must contain exactly one "/"' ;;
    */*) ;;
    *) deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must be a CIDR ending in /32' ;;
esac

address=${cidr%/*}
prefix=${cidr#*/}

# /32 only. A prefix shorter than /32 is a RANGE, and a range is not an
# identity: it would let any neighbouring address assert recipient identity.
[ "$prefix" = "32" ] || deny \
    'PUBLIC_SHARE_EDGE_PROXY_CIDR must end in /32; the tunnel connector is one host identity, never a range'

# Exactly four non-empty, purely numeric octets. The trailing dot makes the
# loop terminate on a well-formed value and makes "1.2.3." fail as an empty
# fifth label rather than passing as four.
count=0
first=''
rest="$address."
while [ -n "$rest" ]; do
    octet="${rest%%.*}"
    rest="${rest#*.}"
    count=$((count + 1))
    [ "$count" -le 4 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must contain exactly four octets'
    [ -n "$octet" ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains an empty octet'
    [ "${#octet}" -le 3 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains an over-long octet'
    case "$octet" in
        *[!0123456789]*) deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains a non-numeric octet' ;;
    esac
    # "010" is 10 to nginx and 8 to anything that reads it as octal. A pinned
    # identity may not be ambiguous, so it is refused rather than normalised.
    case "$octet" in
        0) ;;
        0*) deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains an octet with a leading zero' ;;
    esac
    [ "$octet" -le 255 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR contains an octet above 255'
    [ "$count" -ne 1 ] || first=$octet
done
[ "$count" -eq 4 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must contain exactly four octets'

# The connector is a real, distinct, unicast peer on the gateway's own ingress
# network. Nothing else can be one.
#
#   0.0.0.0/8      "this network" / the unspecified address — never a peer
#   127.0.0.0/8    loopback: the gateway's OWN health probe and any process
#                  inside the container would inherit connector trust
#   224.0.0.0/4+   multicast and reserved space — never a TCP peer
[ "$first" -ne 0 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must not be in 0.0.0.0/8'
[ "$first" -ne 127 ] || deny \
    'PUBLIC_SHARE_EDGE_PROXY_CIDR must not be a loopback address; a loopback connector would give every process inside the gateway container the connector trust'
[ "$first" -lt 224 ] || deny 'PUBLIC_SHARE_EDGE_PROXY_CIDR must be a unicast address, not multicast or reserved space'

# Everything above passed, so the ONLY operator-influenced text below is
# "$address", which is now provably four dotted decimal numbers and nothing
# else. It cannot carry a semicolon, a brace, a newline or a second directive.
mkdir -p "$OUT_DIR" || deny 'the generated edge include directory could not be created'
rm -f "$OUT_DIR/http.conf"
cat > "$OUT_DIR/http.conf" <<EDGE
# AEGIS Public Share Gateway — edge trust, GENERATED AT STARTUP. Do not edit.
#
# mode: cloudflare — a managed HTTP tunnel terminates the recipient connection
# and re-originates it from the pinned connector below.
#
# pinned tunnel connector: $address/32
#
# ⚠️ The provider's recipient identity is believed ONLY from that one immediate
#    TCP peer. From anyone else — including a direct caller that reaches this
#    listener — CF-Connecting-IP, True-Client-IP, X-Forwarded-For, X-Real-IP and
#    Forwarded are worth nothing, and the request is refused before it can
#    consume a rate-limit token or reach Drive.

# Canonicalisation. nginx's own realip module replaces \$remote_addr and
# \$binary_remote_addr with the provider-asserted recipient, but ONLY for a
# connection whose peer is the pinned connector, and ONLY when the header parses
# as an address. Every downstream directive — the authored X-Forwarded-For and
# X-Real-IP, and the edge limit key — therefore keeps its PUBLIC-SHARE-3 spelling
# and becomes per-recipient with no further change.
#
# ⚠️ If this image ever lacked ngx_http_realip_module, set_real_ip_from would be
#    an unknown directive and the gateway would fail to start. That is the
#    intended direction: no silent fallback to attributing every recipient to
#    the connector.
set_real_ip_from $address/32;
real_ip_header CF-Connecting-IP;
# CF-Connecting-IP carries exactly one address. Recursion is off so a multi-hop
# chain can never be walked back past the connector.
real_ip_recursive off;

# 1 when the immediate TCP peer is not the pinned connector. \$realip_remote_addr
# is the ORIGINAL peer, i.e. the value canonicalisation replaced, so this asks
# about the connection rather than about anything the caller can write.
map \$realip_remote_addr \$aegis_edge_peer_untrusted {
    default 1;
    "$address" 0;
}

# 1 when the connector sent no recipient identity at all. The "x" prefix keeps
# this a comparison against a non-empty key rather than relying on how the map
# module treats a zero-length one. Fail closed: a missing header must refuse the
# request, never silently attribute every recipient to the connector.
map "x\$http_cf_connecting_ip" \$aegis_edge_recipient_absent {
    default 0;
    "x" 1;
}

# 1 when the recipient identity is AMBIGUOUS. \$http_cf_connecting_ip joins
# repeated headers with ", ", so a comma means more than one claim arrived.
#
# ⚠️ MEASURED, NOT ASSUMED. nginx's realip module reads the FIRST matching
#    header and ignores the rest, so without this control a request carrying
#    two CF-Connecting-IP headers is accepted and attributed to whichever one
#    happened to arrive first — a caller-influenced choice. Refusing is the only
#    honest answer to two different claims about who the recipient is.
map \$http_cf_connecting_ip \$aegis_edge_recipient_ambiguous {
    default 0;
    "~," 1;
}

# 1 when canonicalisation did not actually happen — an unparsable address, or a
# realip configuration that did not apply. In either case \$remote_addr is still
# the connector, which is precisely the attribution collapse this mode exists to
# prevent.
map \$remote_addr \$aegis_edge_not_canonical {
    default 0;
    "$address" 1;
}

# The one gate the template consults. All four controls must pass.
map "\$aegis_edge_peer_untrusted\$aegis_edge_recipient_absent\$aegis_edge_recipient_ambiguous\$aegis_edge_not_canonical" \$aegis_edge_deny {
    default 1;
    "0000" 0;
}
EDGE

exit 0
