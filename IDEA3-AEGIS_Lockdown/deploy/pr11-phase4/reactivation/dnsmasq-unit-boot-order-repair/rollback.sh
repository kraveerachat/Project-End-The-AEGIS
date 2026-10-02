#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq UNIT boot-order REPAIR rollback handler (failure/abort path only).
# MUTATING in live mode. It undoes ONLY what apply.sh journaled, idempotently, in this order:
#   UNIT_INSTALL      -> restore the digest-checked backup of the OLD unit byte-for-byte (atomic rename), then `systemctl daemon-reload` so systemd's loaded definition
#                        and the file on disk agree again (a rename always changes the fragment mtime, so a reload is required even if the old bytes are back)
#   DNSMASQ_RESET_FAILED / DNSMASQ_START (baseline FAILED)  -> `systemctl stop aegis-idea3-dnsmasq.service` (exact unit): safe, stopped; the stale start-limit-hit
#                        artifact is never recreated and nothing is started
#   DNSMASQ_START (baseline SAFE_STOPPED)  -> the same exact `systemctl stop`: back to the exact SAFE_STOPPED state (inactive/dead/success/MainPID 0). Only a journaled
#                        start of THIS run is undone; there was never a reset-failed, and no start-limit-hit is manufactured.
#   DNSMASQ_RESTART (baseline RUNNING) -> only if dnsmasq is not active/running: `reset-failed` (if failed) + one `restart` of the exact unit under the restored old
#                        unit, so the pre-repair DHCP/DNS service is back; a running dnsmasq is left alone (no second blip)
# Failure BEFORE the unit replacement (no UNIT_INSTALL journaled): nothing is restored, reloaded, reset or stopped; it only proves nothing moved.
# It NEVER issues any command against the AP / NetworkManager / nftables / forwarding / broker / Twingate / Core / ESP32. Ownership that cannot be proven from the
# journal fails closed and escalates. After rollback every persistent file, the AP, L2, forwarding and every Core/broker/legacy identity is proven unchanged.
set -uo pipefail
export LC_ALL=C

fail() { printf 'DNSMASQ_REPAIR_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

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
DNS_TRIES=20
DNS_INTERVAL=0.5
if [ -n "$ROOT" ]; then
  STABLE_INTERVAL="${AEGIS_DNSREPAIR_STABLE_INTERVAL:-5}"
  DNS_TRIES="${AEGIS_DNSREPAIR_TRIES:-20}"; DNS_INTERVAL="${AEGIS_DNSREPAIR_INTERVAL:-0.5}"
fi
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt identities-pre.txt baseline.txt core-tuple-pre.txt broker-tuple-pre.txt; do [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"; done
if [ -z "$ROOT" ]; then
  [ "${AEGIS_DNSREPAIR_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
else
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl systemd-analyze; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi
baseline=$(cat "$WORK/baseline.txt")
[[ "$baseline" =~ ^(FAILED|RUNNING|SAFE_STOPPED)$ ]] || fail BASELINE_UNRECOGNIZED
unit_file=$(host_path "$L34_DNSMASQ_UNIT")

# ── journal: only fixed, known entries are acted on — exactly this run's owned mutations, nothing else ────────────────
j_backup=0 j_backup_sha="" j_install=0 j_reload=0 j_reset=0 j_start=0 j_restart=0
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    UNIT_BACKUP) [[ "$value" =~ ^[0-9a-f]{64}$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_backup=1; j_backup_sha=$value ;;
    UNIT_INSTALL) [[ "$value" =~ ^[0-9a-f]{64}$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_install=1 ;;
    DAEMON_RELOAD) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_reload=1 ;;
    DNSMASQ_RESET_FAILED) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_reset=1 ;;
    DNSMASQ_START) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_start=1 ;;
    DNSMASQ_RESTART) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_restart=1 ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

# the backup must be proven intact BEFORE anything is changed
if [ "$j_install" = 1 ]; then
  [ "$j_backup" = 1 ] && [ -f "$WORK/unit.old" ] && [ ! -L "$WORK/unit.old" ] || fail UNIT_BACKUP_MISSING
  [ "$(dnsrepair_sha256 "$WORK/unit.old")" = "$j_backup_sha" ] && [ "$j_backup_sha" = "$DNSREPAIR_OLD_UNIT_SHA256" ] || fail UNIT_BACKUP_CORRUPT
fi

# 1. unit: restore the exact old bytes (only if this run replaced it), then make systemd's loaded definition agree with the file on disk
if [ "$j_install" = 1 ]; then
  if [ "$(dnsrepair_sha256 "$unit_file")" != "$j_backup_sha" ]; then
    dnsrepair_install_unit "$WORK/unit.old" "$unit_file" || fail "$(reason_of dnsrepair_install_unit "$WORK/unit.old" "$unit_file")"
  fi
  systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
fi

# 2. dnsmasq: only the exact dedicated unit, only what this run owns
if [ "$baseline" = FAILED ] || [ "$baseline" = SAFE_STOPPED ]; then
  if [ "$j_reset" = 1 ] || [ "$j_start" = 1 ]; then
    systemctl stop "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_STOP_FAILED
  fi
elif [ "$j_restart" = 1 ]; then
  if ! unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then
    if unit_props "$DNSMASQ_UNIT" | grep -qx 'ActiveState=failed'; then
      systemctl reset-failed "$DNSMASQ_UNIT" || fail DNSMASQ_RESET_FAILED_FAILED
    fi
    systemctl restart "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_RESTART_FAILED
    dns_ok=1
    for ((i = 1; i <= DNS_TRIES; i++)); do
      if unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then dns_ok=0; break; fi
      [ "$i" -lt "$DNS_TRIES" ] && sleep "$DNS_INTERVAL"
    done
    [ "$dns_ok" = 0 ] || fail DNSMASQ_NOT_RECOVERED
  fi
fi

# ── proofs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$j_install" = 1 ]; then
  [ "$(dnsrepair_sha256 "$unit_file")" = "$j_backup_sha" ] || fail UNIT_NOT_RESTORED
else
  [ "$(dnsrepair_sha256 "$unit_file")" = "$DNSREPAIR_OLD_UNIT_SHA256" ] || fail UNIT_CHANGED_WITHOUT_JOURNAL_OWNERSHIP
fi
[ "$(stat -c '%a' -- "$unit_file")" = 644 ] || fail UNIT_MODE_NOT_RESTORED
dnsrepair_need_reload_gate || fail "$(reason_of dnsrepair_need_reload_gate)"
if [ "$baseline" = FAILED ] || [ "$baseline" = SAFE_STOPPED ]; then
  if [ "$j_reset" = 1 ] || [ "$j_start" = 1 ]; then
    ! unit_props "$DNSMASQ_UNIT" | grep -qx 'ActiveState=active' || fail DNSMASQ_STILL_RUNNING
    # SAFE_STOPPED must return to EXACTLY the safe stopped service state (never a manufactured start-limit-hit, never a leftover process)
    [ "$baseline" != SAFE_STOPPED ] || [ "$(unit_props "$DNSMASQ_UNIT" | dnsrepair_baseline_classify 2>/dev/null)" = SAFE_STOPPED ] || fail DNSMASQ_NOT_RETURNED_TO_SAFE_STOPPED
  else
    unit_props "$DNSMASQ_UNIT" | dnsrepair_baseline_classify >/dev/null || fail DNSMASQ_PRE_STATE_NOT_PRESERVED
  fi
else
  unit_props "$DNSMASQ_UNIT" | l34_service_active_gate || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
fi
dnsrepair_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(reason_of dnsrepair_persistent_verify "$WORK/persistent-pre.tsv")"
dnsrepair_ap_unchanged_gate "$AP_IF" || fail "$(reason_of dnsrepair_ap_unchanged_gate "$AP_IF")"
nft list table inet aegis_idea3 > "$WORK/nft-table-rollback.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-rollback.txt" || fail L2_NFT_TABLE_CHANGED
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(reason_of l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt")"
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR")"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-rollback.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-rollback.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'DNSMASQ_REPAIR_ROLLBACK=PASS\n'
printf 'SAFE_STATE_RESTORED=YES\n'
printf 'UNIT_RESTORED=%s\n' "$([ "$j_install" = 1 ] && echo 'YES (old unit, byte-identical)' || echo NOT_CHANGED)"
printf 'DNSMASQ_BASELINE=%s\n' "$baseline"
printf 'AP_CHANGED=NO\n'
printf 'BROKER_TOUCHED=NO\n'
printf 'CORE_TOUCHED=NO\n'
printf 'STALE_START_LIMIT_HIT_RECREATED=NO\n'
printf 'ESP32_TOUCHED=NO\n'
