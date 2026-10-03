#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION rollback handler (failure/abort path only).
# Restores the exact PRE RUNTIME state, nothing else: stop chronyd, make sure systemd-timesyncd is active again, require TrustedClock acceptable again.
# It NEVER enables/disables a unit, NEVER writes /etc/chrony.conf (it only PROVES the file and both UnitFileStates are unchanged) and issues no command against
# the network, AP, dnsmasq, broker or Core. Idempotent; a failure before the first mutation changes nothing.
set -uo pipefail
export LC_ALL=C

fail() { printf 'NTPREACT_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-ntp-reactivation-lib.sh
. "$P4_HERE/p4-ntp-reactivation-lib.sh"

WORK="${AEGIS_NTPREACT_WORK_DIR:-}"
[ "${AEGIS_NTPREACT_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ -f "$WORK/pre_snapshot" ] && [ -f "$WORK/pre_snapshot_complete" ] || fail ROLLBACK_PRE_STATE_UNKNOWN
pre() { sed -n "s/^$1=//p" "$WORK/pre_snapshot" | head -n 1; }
[ "$(pre timesyncd_pre_active)" = active ] && [ "$(pre chronyd_pre_active)" = inactive ] || fail ROLLBACK_PRE_STATE_UNKNOWN

# 1. stop chronyd (only if it is active/activating), and require it to be gone
case "$(ntpreact_unit_prop chronyd.service ActiveState)" in
  inactive|failed) ;;
  *) systemctl stop chronyd.service || true ;;
esac
case "$(ntpreact_unit_prop chronyd.service ActiveState)" in inactive|failed) ;; *) fail ROLLBACK_CHRONYD_STILL_ACTIVE ;; esac

# 2. systemd-timesyncd back to its PRE runtime state (active). `start` on an already-active unit is a no-op; nothing is restarted.
[ "$(ntpreact_unit_prop systemd-timesyncd.service ActiveState)" = active ] || systemctl start systemd-timesyncd.service || fail ROLLBACK_TIMESYNCD_START_FAILED
[ "$(ntpreact_unit_prop systemd-timesyncd.service ActiveState)" = active ] || fail ROLLBACK_TIMESYNCD_NOT_ACTIVE

# 3. TrustedClock acceptable again (bounded; the same L5 predicate)
ok=0
for ((i = 0; i < "${AEGIS_NTPREACT_ROLLBACK_CLOCK_TRIES:-30}"; i++)); do
  if ntpreact_clock_gate 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || fail ROLLBACK_TIME_SYNC_FAILED

# 4. prove (never repair) that nothing persistent moved
[ "$(ntpreact_unit_prop chronyd.service UnitFileState)" = "$(pre chronyd_unitfilestate)" ] || fail ROLLBACK_CHRONYD_UNITFILESTATE_CHANGED_ESCALATE
[ "$(ntpreact_unit_prop systemd-timesyncd.service UnitFileState)" = "$(pre timesyncd_unitfilestate)" ] || fail ROLLBACK_TIMESYNCD_UNITFILESTATE_CHANGED_ESCALATE
[ "$(sha256sum "$NTPREACT_CHRONY_CONF" | awk '{ print $1 }')" = "$(pre chrony_conf_sha256)" ] || fail ROLLBACK_CHRONY_CONF_CHANGED_ESCALATE
gate_out=$(ntpreact_no_ntp_listener_gate 2>&1) || fail "ROLLBACK_NTP_LISTENER_STILL_PRESENT:${gate_out}"

printf 'NTPREACT_ROLLBACK=PASS\n'
printf 'RUNTIME_BASELINE_RESTORED=YES\n'
printf 'UNITFILESTATE_MUTATION=NO\n'
printf 'CHRONY_CONFIG_MUTATION=NO\n'
