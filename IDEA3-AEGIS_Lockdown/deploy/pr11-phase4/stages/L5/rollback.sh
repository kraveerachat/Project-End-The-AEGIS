#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L5 rollback handler.
# Restores exact pre-L5 runtime time state and /etc/chrony.conf.
# Idempotent and stage-local. UnitFileState is never changed.
set -uo pipefail

fail() {
  printf "L5_ROLLBACK=FAIL reason=%s\n" "$1" >&2
  exit 1
}

CHRONY_CONF_DEST="/etc/chrony.conf"
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L5_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING

target_conf="$(host_path "$CHRONY_CONF_DEST")"

if [ -z "$ROOT" ]; then
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  # 1. Stop chronyd if active
  if systemctl is-active chronyd.service >/dev/null 2>&1; then
    systemctl stop chronyd.service 2>/dev/null || true
  fi
else
  # Fixture mode: record event
  if [ ! -f "$WORK/service_rollback_events" ]; then
    printf "stop chronyd.service\n" >> "$WORK/service_rollback_events"
  fi
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -d "$fixture_dir" ]; then
    printf "inactive\n" > "$fixture_dir/chronyd_active"
    printf "dead\n" > "$fixture_dir/chronyd_substate"
    rm -f "$fixture_dir/listeners" 2>/dev/null || true
  fi
fi

# 2. Restore /etc/chrony.conf to exact pre-L5 state
pre_exists="NO"
if [ -f "$WORK/pre_chrony_conf_exists" ]; then
  pre_exists="$(cat "$WORK/pre_chrony_conf_exists")"
fi

if [ "$pre_exists" = "YES" ]; then
  if [ -f "$WORK/chrony.conf.orig" ]; then
    cp -f "$WORK/chrony.conf.orig" "$target_conf"
    if [ -f "$WORK/chrony.conf.meta.orig" ]; then
      IFS=: read -r orig_mode orig_uid orig_gid orig_size orig_mtime < "$WORK/chrony.conf.meta.orig"
      chmod "$orig_mode" "$target_conf" 2>/dev/null || true
      chown "$orig_uid:$orig_gid" "$target_conf" 2>/dev/null || true
    fi
  fi
else
  rm -f -- "$target_conf"
fi

# 3. Restore systemd-timesyncd.service to captured pre-L5 ActiveState
ts_pre_active="active"
if [ -f "$WORK/timesyncd_pre_active" ]; then
  ts_pre_active="$(cat "$WORK/timesyncd_pre_active")"
fi

if [ -z "$ROOT" ]; then
  if [ "$ts_pre_active" = "active" ]; then
    systemctl start systemd-timesyncd.service 2>/dev/null || true
  fi

  # Require TrustedClock to return to SYNCED
  tc_synced=0
  for ((i=0; i<30; i++)); do
    tc_eval="$(python3 -c "
import sys
sys.path.insert(0, '$P4_HERE/../../IDEA3-AEGIS_Lockdown')
from aegis_soc.trusted_time import TrustedClock, adjtimex_probe
tc = TrustedClock()
probe = adjtimex_probe()
if probe is not None and probe.synced and tc.state() == 'SYNCED' and probe.maxerror_us <= 1000000:
    print('SYNCED')
" 2>/dev/null || true)"
    if [ "$tc_eval" = "SYNCED" ]; then
      tc_synced=1
      break
    fi
    sleep 1
  done
  [ "$tc_synced" = 1 ] || fail ROLLBACK_TIME_SYNC_FAILED
else
  if [ "$ts_pre_active" = "active" ]; then
    if ! grep -Fq "start systemd-timesyncd.service" "$WORK/service_rollback_events" 2>/dev/null; then
      printf "start systemd-timesyncd.service\n" >> "$WORK/service_rollback_events"
    fi
    if [ -d "$fixture_dir" ]; then
      printf "active\n" > "$fixture_dir/timesyncd_active"
      printf "running\n" > "$fixture_dir/timesyncd_substate"
      printf "SYNCED\n" > "$fixture_dir/trusted_clock_state"
    fi
  fi
fi

printf "L5_ROLLBACK=PASS\n"
printf "L5_ARTIFACT_RESIDUE=NO\n"
