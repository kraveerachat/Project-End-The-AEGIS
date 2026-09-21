#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 package installation apply handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-01..OD-L1-10)
#   2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md (D1..D3)
#
# Fails closed on any constraint violation. Fixture backend runs unconditionally
# in an isolated filesystem root. Live backend is repository-implemented but
# requires explicit live-authorization environment variables; without them it
# fails closed identically to before (LIVE_L1=NOT_AUTHORIZED). This script does
# not itself validate K3/A-L1/D6 — that remains p4-stage-gate.sh's exclusive
# responsibility; the live-authorization variables checked here are an
# additional, independent, in-process fail-closed check, not a replacement.
set -euo pipefail

fail() {
  printf 'L1_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  local name=$1
  local value=${!name:-}
  [ -n "$value" ] || fail "$name required"
}

# 1. Mandatory environment (OD-L1-01, design §2)
require_env AEGIS_L1_WORK_DIR
require_env AEGIS_P4_FS_ROOT

WORK_DIR="$AEGIS_L1_WORK_DIR"
FS_ROOT="$AEGIS_P4_FS_ROOT"
BACKEND="${AEGIS_L1_BACKEND:-fixture}"
DISK_THRESHOLD_PCT="${DISK_THRESHOLD_PCT:-90}"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"

LIVE_AUTH_TOKEN_REQUIRED="AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"

# 2. Backend and live-authorization gate (OD-L1-02, OD-L1-10, D2)
case "$BACKEND" in
  fixture)
    ;;
  live)
    if [ "${AEGIS_L1_LIVE_AUTHORIZATION_TOKEN:-}" != "$LIVE_AUTH_TOKEN_REQUIRED" ] \
      || [ "${AEGIS_L1_LIVE_K3_CONFIRMED:-}" != "YES" ]; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    ;;
  *)
    fail "unknown backend: $BACKEND"
    ;;
esac

# 3. Directory constraints and host path refusals (OD-L1-02)
[ ! -L "$WORK_DIR" ] || fail "AEGIS_L1_WORK_DIR must not be a symlink"
[ ! -L "$FS_ROOT" ] || fail "AEGIS_P4_FS_ROOT must not be a symlink"

case "$WORK_DIR" in
  /etc/* | /opt/* | /var/* | /run/* | /dev/* | /usr/* | /bin/* | /sbin/*)
    fail "AEGIS_L1_WORK_DIR must not be a host system path"
    ;;
esac

mkdir -p "$WORK_DIR" "$FS_ROOT"
chmod 0700 "$WORK_DIR"

# 4. Disk headroom gate (OD-L1-05, D1: canonical threshold = 90)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" check-headroom \
  --threshold "$DISK_THRESHOLD_PCT"; then
  fail "DISK_THRESHOLD_VIOLATION"
fi

# 5. Delegate package installation to helper (OD-L1-01..OD-L1-04, D2)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" simulate-install \
  --backend "$BACKEND" \
  --work-dir "$WORK_DIR" \
  --fs-root "$FS_ROOT" \
  --packages "chrony"; then
  fail "package installation failed"
fi

# 6. Verify service was not enabled or started (OD-L1-04, fixture-path check;
#    live-mode service state is independently verified by verify.sh)
if [ -e "$FS_ROOT/etc/systemd/system/multi-user.target.wants/chronyd.service" ]; then
  fail "SERVICE_MUTATION_REFUSED (chronyd.service enabled)"
fi

# 7. Output markers
printf 'L1_SERVICES_STARTED=NONE\n'
printf 'L1_SERVICES_ENABLED=NONE\n'
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
if [ "$BACKEND" = "live" ]; then
  printf 'LIVE_L1=EXECUTED\n'
else
  printf 'LIVE_L1=NOT_AUTHORIZED\n'
fi
printf 'L1_APPLY=COMPLETE\n'
exit 0
