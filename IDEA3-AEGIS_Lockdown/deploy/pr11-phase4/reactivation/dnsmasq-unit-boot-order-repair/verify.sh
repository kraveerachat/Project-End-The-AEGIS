#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq UNIT boot-order REPAIR verification handler. Read-only.
# Proves the installed unit is byte-identical to the canonical template rendered with the fixed approved values (the corrected L34 authority accepts it) and
# systemd has loaded it, dnsmasq is active/running with its exact listeners and no start-limit hit, the AP (mode, SSID, channel, IPv4/prefix) is exactly the
# approved one, and nothing else moved: persistent files, L2 nft table, forwarding, default route, Core/broker/Twingate/IDEA2/legacy identities.
# It does NOT claim K12 reboot persistence (a separate, later orderly-reboot verification) and never prints the PSK.
set -uo pipefail
export LC_ALL=C

fail() { printf 'DNSMASQ_REPAIR_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-dnsmasq-repair-lib.sh
. "$P4_HERE/p4-dnsmasq-repair-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_DNSREPAIR_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
STABLE_INTERVAL=5
[ -z "$ROOT" ] || STABLE_INTERVAL="${AEGIS_DNSREPAIR_STABLE_INTERVAL:-5}"
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT
TEMPLATE="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt identities-pre.txt core-tuple-pre.txt broker-tuple-pre.txt baseline.txt journal.tsv default-route-pre.txt; do
  [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"
done
if [ -n "$ROOT" ]; then
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl systemd-analyze; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# the repair was applied exactly once, in order
[ "$(dnsrepair_journal_count "$WORK/journal.tsv" UNIT_INSTALL)" = 1 ] || fail DNSREPAIR_JOURNAL_UNIT_INSTALL_NOT_EXACTLY_ONE
[ "$(dnsrepair_journal_count "$WORK/journal.tsv" DAEMON_RELOAD)" = 1 ] || fail DNSREPAIR_JOURNAL_DAEMON_RELOAD_NOT_EXACTLY_ONE

# persistent accepted artifacts untouched (this package never writes them)
dnsrepair_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(reason_of dnsrepair_persistent_verify "$WORK/persistent-pre.tsv")"
l34_profile_gate "$(host_path "$L34_PROFILE")" || fail "$(reason_of l34_profile_gate "$(host_path "$L34_PROFILE")")"
l34_dnsmasq_conf_gate "$(host_path "$L34_DNSMASQ_CONF")" || fail L34_DNSMASQ_CONF_CHANGED
l34_v7_broker_conf_gate "$(host_path "$L34_V7_BROKER_CONF")" || fail "$(reason_of l34_v7_broker_conf_gate "$(host_path "$L34_V7_BROKER_CONF")")"

# the unit: the corrected L34 authority accepts it, and systemd has loaded exactly that file
dnsrepair_canonical_unit_gate "$(host_path "$L34_DNSMASQ_UNIT")" "$TEMPLATE" || fail "$(reason_of dnsrepair_canonical_unit_gate "$(host_path "$L34_DNSMASQ_UNIT")" "$TEMPLATE")"
dnsrepair_need_reload_gate || fail "$(reason_of dnsrepair_need_reload_gate)"

# dnsmasq: active/running, no start-limit hit, exact listeners
unit_props "$DNSMASQ_UNIT" | l34_service_active_gate || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
! unit_props "$DNSMASQ_UNIT" | grep -qx 'Result=start-limit-hit' || fail DNSREPAIR_DNSMASQ_START_LIMIT_HIT
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# the AP is exactly the approved one
dnsrepair_ap_unchanged_gate "$AP_IF" || fail "$(reason_of dnsrepair_ap_unchanged_gate "$AP_IF")"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail DNSREPAIR_DEFAULT_ROUTE_CHANGED

# Core healthy and exactly the PRE tuple; broker active with its exact pair and exactly the PRE tuple, and it stays stable over a bounded sample
unit_props "$CORE_UNIT" | l34_v7_core_gate || fail "$(unit_props "$CORE_UNIT" | l34_v7_core_gate 2>&1 | head -n 1)"
l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(reason_of l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt")"
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR")"
l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-verify.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL" \
  || fail "$(reason_of l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-verify.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL")"
cmp -s "$WORK/broker-tuple-pre.txt" "$WORK/broker-tuple-verify.txt" || fail L34_V6_BROKER_TUPLE_CHANGED

# L2 and forwarding policy unchanged
nft list table inet aegis_idea3 > "$WORK/nft-table-post.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-post.txt" || fail L2_NFT_TABLE_CHANGED
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"

# legacy mosquitto / Twingate / IDEA2 identities unchanged
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-post.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-post.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'DNSMASQ_REPAIR_VERIFY=PASS\n'
printf 'DNSMASQ_REPAIR_BASELINE=%s\n' "$(cat "$WORK/baseline.txt")"
printf 'DNSMASQ_REPAIR_APPLIED=YES\n'
printf 'DNSMASQ_UNIT_AUTHORITY=PASS\n'
printf 'DNSMASQ_ACTIVE=YES\n'
printf 'DNSMASQ_RUNNING=YES\n'
printf 'DNSMASQ_START_LIMIT_HIT=NO\n'
printf 'AP_MODE=PASS\n'
printf 'AP_SSID=PASS\n'
printf 'AP_CHANNEL=PASS\n'
printf 'AP_IPV4_PREFIX=PASS\n'
printf 'CORE_HEALTH=PASS\n'
printf 'BROKER_UNCHANGED=PASS\n'
printf 'FORWARDING_POLICY=PASS\n'
printf 'ESP32_TOUCHED=NO\n'
printf 'K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
