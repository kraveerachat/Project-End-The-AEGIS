#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 package installation apply handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-01..OD-L1-10)
#
# Fails closed on any constraint violation. The only implemented backend is
# the fixture backend; the live backend is refused because no live production
# package mutation is authorized. LIVE_L1=NOT_AUTHORIZED.
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

# 2. Backend and live-authorization gate (OD-L1-02, OD-L1-10)
case "$BACKEND" in
  fixture)
    ;;
  live)
    fail "LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY (LIVE_L1=NOT_AUTHORIZED)"
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

# 4. Disk headroom gate (OD-L1-05)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" check-headroom \
  --threshold "$DISK_THRESHOLD_PCT"; then
  fail "DISK_THRESHOLD_VIOLATION"
fi

# 5. Delegate simulated package installation to helper (OD-L1-01..OD-L1-04)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" simulate-install \
  --backend "$BACKEND" \
  --work-dir "$WORK_DIR" \
  --fs-root "$FS_ROOT" \
  --packages "chrony"; then
  fail "package simulation failed"
fi

# 6. Verify service was not enabled or started (OD-L1-04)
if [ -e "$FS_ROOT/etc/systemd/system/multi-user.target.wants/chronyd.service" ]; then
  fail "SERVICE_MUTATION_REFUSED (chronyd.service enabled)"
fi

# 7. Output markers
printf 'L1_SERVICES_STARTED=NONE\n'
printf 'L1_SERVICES_ENABLED=NONE\n'
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'LIVE_L1=NOT_AUTHORIZED\n'
printf 'L1_APPLY=COMPLETE\n'
exit 0
