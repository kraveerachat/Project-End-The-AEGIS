#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 package installation apply handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-01..OD-L1-10)
#   2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md (D1..D3)
#
# Fails closed on any constraint violation. Fixture backend runs unconditionally
# in an isolated filesystem root (AEGIS_P4_FS_ROOT, a TEST-ONLY prefix per
# p4-lib.sh — a real live run leaves it unset). Live backend is
# repository-implemented but requires the CANONICAL p4-stage-gate.sh to
# accept a real, same-day, stage=L1 authorization record
# (AEGIS_L1_LIVE_AUTHORIZATION_FILE) and K3 confirmation record
# (AEGIS_L1_LIVE_K3_FILE) — this script re-invokes that exact gate script
# itself rather than trusting a boolean flag or a static token, so there is
# exactly one record parser in the repository. Missing, malformed, stale,
# wrong-stage, or wrong-field records all fail closed here exactly as they
# would fail the gate directly (LIVE_L1=NOT_AUTHORIZED). Live mode never
# touches AEGIS_P4_FS_ROOT and fails closed if it is set.
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

WORK_DIR="$AEGIS_L1_WORK_DIR"
BACKEND="${AEGIS_L1_BACKEND:-fixture}"
DISK_THRESHOLD_PCT="${DISK_THRESHOLD_PCT:-90}"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
FS_ROOT=""

# 2. Backend gate (OD-L1-02, OD-L1-10, D2).
case "$BACKEND" in
  fixture)
    require_env AEGIS_P4_FS_ROOT
    FS_ROOT="$AEGIS_P4_FS_ROOT"
    ;;
  live)
    # AEGIS_P4_FS_ROOT is a TEST-ONLY fixture prefix (p4-lib.sh); a real live
    # run must never set it. Fail closed rather than silently ignoring it.
    if [ -n "${AEGIS_P4_FS_ROOT:-}" ]; then
      fail "LIVE_MODE_FS_ROOT_REFUSED (AEGIS_P4_FS_ROOT is TEST-ONLY and must be unset in live mode)"
    fi
    # Re-invokes the canonical p4-stage-gate.sh with the real record files.
    # No boolean flag or static token is accepted in place of valid records.
    AUTH_FILE="${AEGIS_L1_LIVE_AUTHORIZATION_FILE:-}"
    K3_FILE="${AEGIS_L1_LIVE_K3_FILE:-}"
    if [ -z "$AUTH_FILE" ] || [ -z "$K3_FILE" ] || [ ! -f "$AUTH_FILE" ] || [ ! -f "$K3_FILE" ]; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    set +e
    GATE_OUT=$(bash "$P4_HERE/p4-stage-gate.sh" --stage L1 --mode live \
      --authorization "$AUTH_FILE" --k3 "$K3_FILE" 2>&1)
    GATE_RC=$?
    set -e
    if [ "$GATE_RC" -ne 0 ] \
      || ! printf '%s\n' "$GATE_OUT" | grep -q '^AUTHORIZATION_RECORD=VALID$' \
      || ! printf '%s\n' "$GATE_OUT" | grep -q '^K3_CONFIRMATION=VALID$'; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    ;;
  *)
    fail "unknown backend: $BACKEND"
    ;;
esac

# 3. Directory constraints and host path refusals (OD-L1-02). AEGIS_L1_WORK_DIR
#    is stage-local evidence storage and applies to both backends; FS_ROOT
#    handling below is fixture-only.
[ ! -L "$WORK_DIR" ] || fail "AEGIS_L1_WORK_DIR must not be a symlink"

case "$WORK_DIR" in
  /etc/* | /opt/* | /var/* | /run/* | /dev/* | /usr/* | /bin/* | /sbin/*)
    fail "AEGIS_L1_WORK_DIR must not be a host system path"
    ;;
esac

mkdir -p "$WORK_DIR"
chmod 0700 "$WORK_DIR"

if [ "$BACKEND" = "fixture" ]; then
  [ ! -L "$FS_ROOT" ] || fail "AEGIS_P4_FS_ROOT must not be a symlink"
  mkdir -p "$FS_ROOT"
fi

# 4. Disk headroom gate (OD-L1-05, D1: canonical threshold = 90)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" check-headroom \
  --threshold "$DISK_THRESHOLD_PCT"; then
  fail "DISK_THRESHOLD_VIOLATION"
fi

# 5. Delegate package installation to helper (OD-L1-01..OD-L1-04, D2). Live
#    mode passes no --fs-root: it never touches the TEST-ONLY fixture prefix.
if [ "$BACKEND" = "fixture" ]; then
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" simulate-install \
    --backend "$BACKEND" \
    --work-dir "$WORK_DIR" \
    --fs-root "$FS_ROOT" \
    --packages "chrony"; then
    fail "package installation failed"
  fi
else
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" simulate-install \
    --backend "$BACKEND" \
    --work-dir "$WORK_DIR" \
    --packages "chrony"; then
    fail "package installation failed"
  fi
fi

# 6. Verify service was not enabled or started (OD-L1-04). Fixture mode
#    checks the fixture path directly (nothing else can prove fixture state).
#    Live mode performs the actual read-only post-install service
#    verification (package installed, ActiveState=inactive,
#    UnitFileState=disabled/static) BEFORE this script is allowed to claim
#    "no service was started/enabled" — it never asserts that without having
#    checked it. A verification failure here fails the whole apply; the
#    normal stage-runner rollback path is required afterward.
if [ "$BACKEND" = "fixture" ]; then
  if [ -e "$FS_ROOT/etc/systemd/system/multi-user.target.wants/chronyd.service" ]; then
    fail "SERVICE_MUTATION_REFUSED (chronyd.service enabled)"
  fi
else
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" verify --backend "$BACKEND"; then
    fail "POST_INSTALL_SERVICE_VERIFICATION_FAILED"
  fi
fi

# 7. Output markers. A PRE-to-RB zero-drift claim is NOT made here: that
#    proof belongs exclusively to the stage runner's own PRE/RB capture and
#    p4-compare.sh step (p4-lib.sh rollback-handler contract), never to an
#    individual apply/verify/rollback handler asserting it by construction.
printf 'L1_SERVICES_STARTED=NONE\n'
printf 'L1_SERVICES_ENABLED=NONE\n'
printf 'HOST_PRE_TO_RB_COMPARE=REQUIRED\n'
if [ "$BACKEND" = "live" ]; then
  printf 'LIVE_L1=EXECUTED\n'
else
  printf 'LIVE_L1=NOT_AUTHORIZED\n'
fi
printf 'L1_APPLY=COMPLETE\n'
exit 0
