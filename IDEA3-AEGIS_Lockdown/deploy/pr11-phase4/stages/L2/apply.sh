#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L2 firewall / forwarding persistence apply.
# MUTATING only when AEGIS_P4_FS_ROOT is unset and explicit live authorization
# is present. Fixture mode writes only below AEGIS_P4_FS_ROOT.
set -uo pipefail

fail() {
  printf 'L2_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

UNIT="aegis-idea3-nftables-load.service"
NFT_DEST="/etc/aegis-idea3/aegis-idea3.nft"
SYSCTL_DEST="/etc/sysctl.d/90-aegis-idea3-forwarding.conf"
UNIT_DEST="/etc/systemd/system/aegis-idea3-nftables-load.service"

ROOT="${AEGIS_P4_FS_ROOT:-}"
RENDER="${AEGIS_L2_RENDER_DIR:-}"
WORK="${AEGIS_L2_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

[ -n "$RENDER" ] || fail AEGIS_L2_RENDER_DIR_REQUIRED
[ -d "$RENDER" ] || fail RENDER_DIR_INVALID
[ -n "$WORK" ] || fail AEGIS_L2_WORK_DIR_REQUIRED
[ -n "$AP_IF" ] || fail AEGIS_AP_INTERFACE_REQUIRED
[[ "$AP_IF" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail AEGIS_AP_INTERFACE_INVALID

NFT_SOURCE="$RENDER/aegis-idea3-nftables.conf"
SYSCTL_SOURCE="$RENDER/aegis-idea3-sysctl.conf"
UNIT_SOURCE="$RENDER/aegis-idea3-nftables-load.service"

for f in "$NFT_SOURCE" "$SYSCTL_SOURCE" "$UNIT_SOURCE"; do
  [ -f "$f" ] && [ ! -L "$f" ] || fail "RENDERED_FILE_INVALID:${f}"
done

! grep -Rq '<AEGIS_' \
  "$NFT_SOURCE" "$SYSCTL_SOURCE" "$UNIT_SOURCE" \
  || fail UNRESOLVED_PLACEHOLDER

grep -Eq '^[[:space:]]*table[[:space:]]+inet[[:space:]]+aegis_idea3[[:space:]]*\{' \
  "$NFT_SOURCE" || fail IDEA3_TABLE_MISSING

[ "$(grep -Ec '^[[:space:]]*table[[:space:]]+' "$NFT_SOURCE")" = 1 ] \
  || fail NFT_TABLE_COUNT_INVALID

grep -Fqx "net.ipv4.ip_forward = 0" "$SYSCTL_SOURCE" \
  || fail IPV4_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv4.conf.all.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV4_ALL_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv4.conf.default.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV4_DEFAULT_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv4.conf.$AP_IF.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV4_AP_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv6.conf.all.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV6_ALL_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv6.conf.default.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV6_DEFAULT_FORWARD_POLICY_INVALID

grep -Fqx "net.ipv6.conf.$AP_IF.forwarding = 0" "$SYSCTL_SOURCE" \
  || fail IPV6_AP_FORWARD_POLICY_INVALID

grep -Fqx "ExecStart=/usr/bin/nft -f $NFT_DEST" "$UNIT_SOURCE" \
  || fail UNIT_EXECSTART_INVALID

grep -Fqx "ExecStop=/usr/bin/nft delete table inet aegis_idea3" "$UNIT_SOURCE" \
  || fail UNIT_EXECSTOP_INVALID

if [ -z "$ROOT" ]; then
  [ "${AEGIS_L2_LIVE_AUTHORIZED:-NO}" = YES ] \
    || fail LIVE_AUTHORIZATION_FLAG_REQUIRED

  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  [ -d "/etc/aegis-idea3" ] && [ ! -L "/etc/aegis-idea3" ] \
    || fail IDEA3_PARENT_DIR_REQUIRED

  nft list table inet aegis_idea3 >/dev/null 2>&1 \
    && fail IDEA3_TABLE_ALREADY_EXISTS

  for dest in "$NFT_DEST" "$SYSCTL_DEST" "$UNIT_DEST"; do
    [ ! -e "$dest" ] || fail "DESTINATION_ALREADY_EXISTS:${dest}"
  done
fi

[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

umask 077
mkdir -p "$WORK"
chmod 700 "$WORK"

nft_dest="$(host_path "$NFT_DEST")"
sysctl_dest="$(host_path "$SYSCTL_DEST")"
unit_dest="$(host_path "$UNIT_DEST")"

install -D -m 0644 "$NFT_SOURCE" "$nft_dest" \
  || fail NFT_INSTALL_FAILED

install -D -m 0644 "$SYSCTL_SOURCE" "$sysctl_dest" \
  || fail SYSCTL_INSTALL_FAILED

install -D -m 0644 "$UNIT_SOURCE" "$unit_dest" \
  || fail UNIT_INSTALL_FAILED

if [ -z "$ROOT" ]; then
  while IFS='=' read -r raw_key raw_value; do
    key="$(printf '%s' "$raw_key" | xargs)"
    value="$(printf '%s' "$raw_value" | xargs)"

    [ -n "$key" ] || continue
    [ "$value" = 0 ] || fail SYSCTL_NONZERO_VALUE

    case "$key" in
      net.ipv4.ip_forward|\
      net.ipv4.conf.all.forwarding|\
      net.ipv4.conf.default.forwarding|\
      net.ipv4.conf."$AP_IF".forwarding|\
      net.ipv6.conf.all.forwarding|\
      net.ipv6.conf.default.forwarding|\
      net.ipv6.conf."$AP_IF".forwarding)
        sysctl -w "$key=0" >/dev/null \
          || fail "SYSCTL_APPLY_FAILED:${key}"
        ;;
      *)
        fail "SYSCTL_KEY_OUT_OF_SCOPE:${key}"
        ;;
    esac
  done < <(
    grep -E '^[[:space:]]*net\..*forward.*=' "$SYSCTL_SOURCE"
  )

  systemctl daemon-reload \
    || fail DAEMON_RELOAD_FAILED

  systemctl enable --now "$UNIT" \
    || fail FIREWALL_UNIT_START_FAILED
else
  printf 'FIXTURE_ONLY\n' > "$WORK/mode"
fi

printf 'L2_APPLY=PASS\n'
printf 'L2_TABLE=inet/aegis_idea3\n'
printf 'FORWARDING_TARGET=DISABLED\n'

if [ -z "$ROOT" ]; then
  printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
else
  printf 'PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY\n'
fi
