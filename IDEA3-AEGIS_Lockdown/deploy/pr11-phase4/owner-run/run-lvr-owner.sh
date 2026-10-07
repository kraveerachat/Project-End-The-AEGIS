#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — LVR (post-Recovery acceptance) READ-ONLY owner-run stage. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed.
# The owner freeze workflow derives ONE root-owned frozen runner from this exact template
# (the EXPECTED_MAIN Git object, replacement objects disabled) plus ONLY the approved pin substitutions.
# Usage (the FROZEN operator user/uid, NOT root): bash run-lvr-owner.sh <AUTH_DIR>
#   AUTH_DIR holds authorization-LVR.txt and k3-LVR.txt (FRESH same-day, stage=LVR).
# Stage order: ... -> Recovery R2-R8 -> LVR -> L8 -> L9.
# LVR is a NON-MUTATING post-Recovery acceptance stage.
# It creates NO attempt marker, mutates NO incident/audit row, connects to NO mutation socket,
# restarts NO service, alters NO table, and touches NO hardware.
set -Eeuo pipefail
umask 077
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# ---- frozen pins: the committed template refuses while ANY of these is unpinned -------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
RECOVERY_EXECUTION_MAIN=PIN_RECOVERY_EXECUTION_MAIN
CONTROL_SNAPSHOT_DIR=PIN_CONTROL_SNAPSHOT_DIR
CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
AUDIT_DB=PIN_AUDIT_DB_PATH
STATUS_PATH=PIN_STATUS_PATH
RECOVERY_MARKER=PIN_RECOVERY_MARKER_PATH
EVIDENCE_ROOT=PIN_EVIDENCE_ROOT
REPO=PIN_PINNED_WORKTREE
PY=PIN_PYTHON_BIN

for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RECOVERY_EXECUTION_MAIN CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 AUDIT_DB STATUS_PATH RECOVERY_MARKER EVIDENCE_ROOT REPO PY; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first." >&2; exit 2 ;; esac
done

[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA." >&2; exit 2; }
[[ "$RECOVERY_EXECUTION_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: RECOVERY_EXECUTION_MAIN is not a 40-hex SHA." >&2; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier." >&2; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid." >&2; exit 2; }
[[ "$CONTROL_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: CONTROL_MANIFEST_SHA256 is not a 64-hex SHA-256." >&2; exit 2; }
for pin in CONTROL_SNAPSHOT_DIR AUDIT_DB STATUS_PATH RECOVERY_MARKER EVIDENCE_ROOT REPO PY; do
  [[ "${!pin}" == /* ]] && [[ "${!pin}" != *..* ]] || { echo "STOP: $pin must be an absolute path without .." >&2; exit 2; }
done

[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root." >&2; exit 2; }
[ "$(id -u)" = "$OPERATOR_UID" ] && [ "$(id -un)" = "$OPERATOR_USER" ] || { echo "STOP: frozen operator identity mismatch." >&2; exit 2; }

# Environment hygiene: refuse any redirecting environment overrides
for var in PYTHONPATH PYTHONHOME PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV AEGIS_P4_REPO AEGIS_P4_EXPECTED_MAIN AEGIS_LVR_WORK_DIR AEGIS_LVR_EVIDENCE_DIR AEGIS_LVR_LIVE_AUTHORIZED AEGIS_LVR_RUNTIME_VERIFY AEGIS_LVR_STATUS_PATH AEGIS_LVR_AUDIT_DB AEGIS_LVR_RECOVERY_MARKER; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set; refusing a live run." >&2; exit 2; }
done

AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] && [ "$(readlink -f -- "$AUTH_DIR")" = "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-LVR.txt and k3-LVR.txt>" >&2; exit 2; }

# Snapshot trust constants
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/

CTRL=$CONTROL_SNAPSHOT_DIR
GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)

die() { echo "STOP: $*" >&2; exit 1; }
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }

# Control snapshot integrity gate
control_gate() {
  local m="$CTRL/LVR-CONTROL-SHA256SUMS" d
  [ -d "$CTRL" ] && [ ! -L "$CTRL" ] && [ -f "$m" ] && [ ! -L "$m" ] || { echo "GATE_FAIL: CONTROL_SNAPSHOT_INVALID" >&2; return 1; }
  [[ "$CTRL" == /* ]] && [ "$(readlink -f "$CTRL")" = "$CTRL" ] || { echo "GATE_FAIL: CONTROL_PATH_NOT_CANONICAL" >&2; return 1; }
  [ -z "$(find "$CTRL" ! -uid "$SNAPSHOT_OWNER_UID" -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SNAPSHOT_NOT_TRUSTED_OWNER" >&2; return 1; }
  d=$CTRL
  while :; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$SNAPSHOT_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || { echo "GATE_FAIL: CONTROL_ANCESTOR_NOT_TRUSTED:$d" >&2; return 1; }
    [ "$d" = "$SNAPSHOT_TRUST_ROOT" ] && break
    [ "$d" != / ] || { echo "GATE_FAIL: CONTROL_TRUST_ROOT_NOT_AN_ANCESTOR" >&2; return 1; }
    d=$(dirname "$d")
  done
  [ "$(sha256sum "$m" | cut -d' ' -f1)" = "$CONTROL_MANIFEST_SHA256" ] || { echo "GATE_FAIL: CONTROL_MANIFEST_DRIFT" >&2; return 1; }
  ( cd "$CTRL" && sha256sum -c --quiet --strict LVR-CONTROL-SHA256SUMS ) >/dev/null 2>&1 || { echo "GATE_FAIL: CONTROL_FILE_DRIFT" >&2; return 1; }
  [ -z "$(find "$CTRL" -type l -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SYMLINK_PRESENT" >&2; return 1; }
  [ -z "$(find "$CTRL" -perm /222 -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SOURCE_WRITABLE" >&2; return 1; }
  [ "$(find "$CTRL" -type f ! -name LVR-CONTROL-SHA256SUMS -printf '%P\n' | LC_ALL=C sort)" = "$(cut -c67- "$m" | LC_ALL=C sort)" ] || { echo "GATE_FAIL: CONTROL_FILE_SET_DRIFT" >&2; return 1; }
}

# Control git gate
control_git_gate() {
  local sha rel got
  [ "$(git -C "$REPO" rev-parse --verify "$EXPECTED_MAIN^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_PINNED_COMMIT_NOT_A_COMMIT_OBJECT" >&2; return 1; }
  [ "$(git -C "$REPO" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_REPO_HEAD_NOT_PINNED_MAIN" >&2; return 1; }
  while read -r sha rel; do
    got=$(git -C "$REPO" show "$EXPECTED_MAIN:$GIT_P4_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { echo "GATE_FAIL: CONTROL_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel" >&2; return 1; }
  done < "$CTRL/LVR-CONTROL-SHA256SUMS"
}

control_gate || die "the control snapshot is not the frozen immutable authority; nothing was executed"
control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was executed"

# Source the frozen LVR run library from the control snapshot
# shellcheck source=/dev/null
. "$CTRL/p4-lvr-run-lib.sh"

RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
lvr_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen LVR operator"

# Pre-gates
lvr_recovery_closeout_gate "$REPO" "$EXPECTED_MAIN" || die "Recovery closeout predecessor gate failed"
lvr_recovery_marker_gate "$RECOVERY_MARKER" || die "Recovery canonical marker gate failed"

for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do
  [ -f "$CTRL/stages/LVR/$f" ] || die "handler file $f missing from control snapshot"
done

# Stage gate confirmation
gate_out=$(TZ=Asia/Bangkok bash "$CTRL/p4-stage-gate.sh" --stage LVR --mode live --authorization "$AUTH_DIR/authorization-LVR.txt" --k3 "$AUTH_DIR/k3-LVR.txt") || die "stage gate failed: $gate_out"
printf '%s\n' "$gate_out" | grep -qx 'AUTHORIZATION_RECORD=VALID' || die "stage gate did not report AUTHORIZATION_RECORD=VALID"
printf '%s\n' "$gate_out" | grep -qx 'K3_CONFIRMATION=VALID' || die "stage gate did not report K3_CONFIRMATION=VALID"
printf '%s\n' "$gate_out" | grep -qx 'STAGE_MUTATES_PRODUCTION=NO' || die "stage gate did not report STAGE_MUTATES_PRODUCTION=NO"
printf '%s\n' "$gate_out" | grep -qx 'READ_ONLY_CAPTURE_ALLOWED=YES' || die "stage gate did not report READ_ONLY_CAPTURE_ALLOWED=YES"
printf '%s\n' "$gate_out" | grep -qx 'STAGE_GATE=PASS_READ_ONLY' || die "stage gate did not report STAGE_GATE=PASS_READ_ONLY"

# Explicit Authorization field bindings
grep -qx "expected_main=$EXPECTED_MAIN" "$AUTH_DIR/authorization-LVR.txt" || die "Authorization does not bind EXPECTED_MAIN"
grep -qx "frozen_runner_sha256=$RUNNER_SHA256" "$AUTH_DIR/authorization-LVR.txt" || die "Authorization does not bind frozen runner SHA-256"
grep -qx "operator_user=$OPERATOR_USER" "$AUTH_DIR/authorization-LVR.txt" || die "Authorization does not bind operator_user"
grep -qx "operator_uid=$OPERATOR_UID" "$AUTH_DIR/authorization-LVR.txt" || die "Authorization does not bind operator_uid"
grep -qx "recovery_execution_main=$RECOVERY_EXECUTION_MAIN" "$AUTH_DIR/authorization-LVR.txt" || die "Authorization does not bind recovery_execution_main"

EVID="$EVIDENCE_ROOT/$TODAY-lvr-$STAMP"
WORK="$EVID/work"
PRE="$EVID/pre-root"
POST="$EVID/post-root"
mkdir -m 700 -p "$EVID" "$WORK"

JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() {
  sudo -n env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$CTRL/p4-l0-capture.sh"
}

# PRE capture
capture "$PRE" lvr-pre

# Handler apply (contract NO-OP)
bash "$CTRL/stages/LVR/apply.sh"

# Handler verify (runtime acceptance verification)
env AEGIS_LVR_LIVE_AUTHORIZED=YES \
    AEGIS_LVR_RUNTIME_VERIFY="$CTRL/p4-lvr-runtime-verify.py" \
    AEGIS_LVR_STATUS_PATH="$STATUS_PATH" \
    AEGIS_LVR_AUDIT_DB="$AUDIT_DB" \
    AEGIS_LVR_RECOVERY_MARKER="$RECOVERY_MARKER" \
    AEGIS_LVR_MAX_AGE_SECONDS=300 \
    bash "$CTRL/stages/LVR/verify.sh"

# POST capture
capture "$POST" lvr-post

# Preservation comparison (PRE vs POST)
sudo -n env DISK_THRESHOLD_PCT=90 \
    ALLOW_KEYS_FILE="$CTRL/stages/LVR/allow-keys.txt" \
    ALLOW_LISTENERS_FILE="$CTRL/stages/LVR/allow-listeners.txt" \
    bash "$CTRL/p4-compare.sh" "$PRE" "$POST" > "$EVID/compare-pre-post.txt"

grep -qx 'PRESERVATION_S10=PASS' "$EVID/compare-pre-post.txt" || die "LVR preservation S10 failed"
grep -qx 'COMPARE_RESULT=PASS' "$EVID/compare-pre-post.txt" || die "LVR compare failed"

# Evidence secret scan
/usr/bin/python3 -I - "$EVID" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
patterns = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(?:password|passwd|secret|token|credential)\s*="),
    re.compile(r"(?i)authorization:\s*bearer\s+"),
)
files = hits = 0
for path in root.rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    files += 1
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeError):
        print("STOP: evidence secret scan unreadable file", file=sys.stderr)
        raise SystemExit(1)
    hits += sum(len(pattern.findall(text)) for pattern in patterns)
if hits:
    print(f"STOP: LVR evidence secret scan found {hits} hit(s)", file=sys.stderr)
    raise SystemExit(1)
print(f"LVR_SECRET_SCAN_FILES={files}")
print("LVR_SECRET_SCAN_HITS=0")
PY

printf 'LVR_LIVE_EXECUTED=YES\nLVR_RESULT=PASS\nLVR_ATTEMPT_CONSUMED=YES\nLVR_RERUN_ALLOWED=NO\nLVR_PRE_POST_PRESERVATION=PASS\nLVR_S10=PASS\nLVR_PRODUCTION_MUTATION=NO\nLVR_FAILURE_RESULT=NONE\nLVR_CLAIM_BOUNDARY=READ_ONLY_ACCEPTANCE_ONLY\n'
