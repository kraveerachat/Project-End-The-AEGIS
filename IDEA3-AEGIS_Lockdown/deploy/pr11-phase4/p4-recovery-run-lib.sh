#!/usr/bin/env bash
# AEGIS IDEA3 Phase 4 — the one governed Recovery R2-R8 owner-run library + attempt state machine. Sourced by the FROZEN owner runner AFTER the control snapshot was re-proved (control_gate) and byte-checked
# against the pinned main (control_git_gate); nothing here runs on its own. Every gate returns 0 on PASS; on FAIL it prints one reason line to stderr and returns 1.
#
# Authority split (fixed): the Core owns every Recovery mutation and every piece of Recovery evidence. The OPERATOR account (the only uid the Core Recovery socket accepts) drives the Core operations and the
# owner's interactive D4 command. ROOT only captures, compares and runs the read-only verifiers, from a root-owned work directory under the canonical governance directory. This library never receives a RESTORE
# secret, never calls SQLite/MQTT/nft with a mutation, never accepts an attacker IP and never uses break-glass. The privilege prefix is `$SUDO` ("sudo -n" in the frozen runner after ONE `sudo -v`).
#
# Functions the FROZEN RUNNER must define before calling recovery_run_attempt (a missing one is a fail-closed refusal, never a default):
#   recovery_control_gate        re-proves the immutable control snapshot (run immediately before EVERY root execution)
#   recovery_pregates            every read-only pre-attempt gate (authorization, K3, stage gate, predecessor, host/service gates, live authority)
#   recovery_authority_gates     the complete live authority (re-run before the marker and before FINAL)
#   recovery_handler STEP [SCRIPT]   the root stage handler (apply.sh / verify.sh / rollback.sh from the control snapshot)
#   recovery_prepare_evidence    creates the operator-side evidence directory EVID and the run log (after every pre-gate passed)
# Globals the runner sets: PY VERIFIER_SNAPSHOT_DIR CTRL STG EVID STEPS WORK RELEASE_PATH RUNTIME_DIR RECOVERY_REASON JOURNAL_SINCE AP_IF AP_ADDR CORE_UNIT DETECTOR_UNIT CORE_PRE DETECTOR_PRE
#   (and RECOVERY_D4_OUT_FD / RECOVERY_D4_ERR_FD: the terminal descriptors the D4 command writes to, never the run log).

: "${SUDO=sudo}"
_RECOVERY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1u-run-lib.sh
. "$_RECOVERY_LIB_DIR/p4-f1u-run-lib.sh"
# Reuse the existing, reviewed predecessor gate; do not duplicate it here.
# shellcheck source=p4-r1bv-run-lib.sh
. "$_RECOVERY_LIB_DIR/p4-r1bv-run-lib.sh"

# Every Git read that feeds a Recovery trust decision runs with replacement objects DISABLED (a real `git replace GOOD EVIL` keeps the apparent SHA while changing the bytes Git returns). A shell function, so it
# also covers the sourced libraries; a caller's environment cannot re-enable replacement.
git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }

RECOVERY_SAFE_PATH=/usr/sbin:/usr/bin:/sbin:/bin
RECOVERY_R1I_TABLE="inet aegis_idea3_r1i"
RECOVERY_D4_WAIT_SECONDS=120
# Bounded `sudo -n -v` keepalive (one per owner-run process; refreshed while the owner types D4 and the Core settles). Plain assignments: only a caller AFTER sourcing can change them (tests); the environment cannot.
RECOVERY_KEEPALIVE_INTERVAL_SEC=30
RECOVERY_KEEPALIVE_MAX_SEC=14400
RECOVERY_KEEPALIVE_PID=""
RECOVERY_KEEPALIVE_FAILED=0
RECOVERY_D4_LOG=""
RECOVERY_OPERATOR_LOG=""
RECOVERY_CLOSE_SUMMARY='Recovery completed through the Core normal-path closure.'

recovery_reason() { printf '%s\n' "$1" >&2; return 1; }

# ---- the ONE canonical stage-global attempt authority -----------------------------------------------------------------------------------------------------------------------
# The location is fixed by THIS stage contract (readonly; no environment override), root-owned 0700, never removed, rewritten or relocated by any code. It is the same governance directory the earlier one-attempt
# stages use. The assignment OVERRIDES any environment value; the frozen runner additionally refuses every override variable at start.
if ! readonly -p 2>/dev/null | grep -q 'RECOVERY_CANONICAL_DIR='; then
  RECOVERY_CANONICAL_DIR=/var/lib/aegis-idea3-governance
  readonly RECOVERY_CANONICAL_DIR
fi
RECOVERY_GLOBAL_MARKER_NAME="RECOVERY-GLOBAL-ATTEMPT-CONSUMED"

# recovery_canonical_dir — TEST-ONLY seam (same precedent as the earlier stages): honoured only when BOTH test variables are set; the frozen runner refuses to start if either is set.
recovery_canonical_dir() {
  if [ "${RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${RECOVERY_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$RECOVERY_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$RECOVERY_CANONICAL_DIR"; fi
}
# recovery_trusted_dir_chain DIR — DIR and EVERY ancestor to `/` are real directories owned by root (the current user when no privilege prefix is used, i.e. in tests) and not group/world writable.
# TEST-ONLY seam RECOVERY_TEST_ONLY_TRUST_ROOT (honoured only with the canonical-dir seam): the climb stops at that directory instead of `/`.
recovery_trusted_dir_chain() {
  local d=${1:-} want=0 stop=/
  [ -n "$SUDO" ] || want=$(id -u)
  if [ "${RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${RECOVERY_TEST_ONLY_TRUST_ROOT:-}" ]; then stop=$RECOVERY_TEST_ONLY_TRUST_ROOT; fi
  [[ "$d" == /* ]] && [[ "$d" != *..* ]] || return 1
  while :; do
    $SUDO test -d "$d" && ! $SUDO test -L "$d" || return 1
    [ "$($SUDO stat -c %u "$d" 2>/dev/null)" = "$want" ] && [ -z "$($SUDO find "$d" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    [ "$d" = "$stop" ] && return 0
    [ "$d" != / ] || return 1
    d=$(dirname "$d")
  done
}
# recovery_canonical_dir_valid — when the canonical directory exists it must be a real, root-owned directory (never a symlink), not group/world writable, with a trusted ancestor chain. A directory that does not
# exist yet is valid: it is created once, before the marker. Its PARENT must then be a trusted real directory.
recovery_canonical_dir_valid() {
  local dir
  dir=$(recovery_canonical_dir)
  [[ "$dir" == /* ]] && [[ "$dir" != *..* ]] || { recovery_reason "RECOVERY_CANONICAL_DIR_INVALID"; return 1; }
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then
    recovery_trusted_dir_chain "$dir" || { recovery_reason "RECOVERY_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED"; return 1; }
  else
    recovery_trusted_dir_chain "$(dirname "$dir")" || { recovery_reason "RECOVERY_CANONICAL_DIR_PARENT_NOT_TRUSTED"; return 1; }
  fi
}
# recovery_fsync PATH — an explicit, fail-closed durability barrier for ONE path (a file or a directory): `sync PATH` is coreutils' fsync(2)-on-that-path. A failed sync is a FAILURE. Tests intercept `sync` through PATH.
recovery_fsync() {
  local path=${1:-}
  [ -n "$path" ] && $SUDO sync -- "$path" 2>/dev/null || { recovery_reason "RECOVERY_DURABILITY_BARRIER_FAILED:$(basename "$path")"; return 1; }
}
# recovery_durable FILE DIR — the file's data and metadata are forced durable FIRST, then the containing directory entry. Both must succeed.
recovery_durable() { recovery_fsync "${1:-}" && recovery_fsync "${2:-}"; }
# recovery_attempt_unconsumed — read-only pre-gate: the ONE canonical stage-global marker does not exist (not even as a dangling symlink) and the canonical directory is valid.
recovery_attempt_unconsumed() {
  local canon marker
  recovery_canonical_dir_valid || return 1
  canon=$(recovery_canonical_dir); marker="$canon/$RECOVERY_GLOBAL_MARKER_NAME"
  if $SUDO test -e "$marker" || $SUDO test -L "$marker"; then
    recovery_reason "RECOVERY_ATTEMPT_ALREADY_CONSUMED (Recovery is ONE live attempt TOTAL; a replacement AUTH_DIR, fresh Authorization/K3, a successor runner or main cannot enable another; there is NO retry)"; return 1
  fi
}
# recovery_consume_attempt WORK — fixed ordering: (1) the marker is proven absent; (2) the canonical directory exists and its ENTRY IN ITS PARENT is forced durable on EVERY invocation, before any marker can exist;
# (3) the marker is created EXCLUSIVELY (noclobber) — from this instant the attempt is irreversibly consumed; (4) the marker FILE, then its DIRECTORY, are forced durable; (5) only then best-effort `chattr +i`.
# This is the ONLY marker implementation. Nothing is ever deleted, rewritten or reconstructed. It is called IMMEDIATELY BEFORE the first Recovery mutation (Core ISOLATE).
recovery_consume_attempt() {
  local work=${1:-} canon marker
  [[ "$work" == /* ]] && [[ "$work" != *..* ]] || { recovery_reason "RECOVERY_WORK_DIR_INVALID"; return 1; }
  recovery_attempt_unconsumed || return 1
  canon=$(recovery_canonical_dir); marker="$canon/$RECOVERY_GLOBAL_MARKER_NAME"
  if ! $SUDO test -d "$canon"; then
    $SUDO mkdir -m 0700 "$canon" 2>/dev/null || { recovery_reason "RECOVERY_CANONICAL_DIR_NOT_CREATABLE (nothing was consumed)"; return 1; }
  fi
  recovery_fsync "$(dirname "$canon")" || { recovery_reason "RECOVERY_CANONICAL_DIR_ENTRY_NOT_DURABLE (nothing was consumed: no marker exists yet)"; return 1; }
  if ! $SUDO bash -c 'set -o noclobber; printf "RECOVERY_ATTEMPT_CONSUMED=YES\nRECOVERY_RERUN_ALLOWED=NO\nconsumed_at=%s\nwork=%s\n" "$(date -u +%FT%TZ)" "$2" > "$1"' _ "$marker" "$work" 2>/dev/null; then
    recovery_reason "RECOVERY_ATTEMPT_ALREADY_CONSUMED (the canonical stage-global marker exists or could not be created exclusively)"; return 1
  fi
  # The marker now EXISTS: from here the attempt is consumed whatever happens. A failed durability barrier is a consumed FAIL; the marker is never removed or rewritten.
  recovery_durable "$marker" "$canon" || { recovery_reason "RECOVERY_MARKER_NOT_DURABLE (the attempt IS consumed: the canonical marker exists; no retry is permitted)"; return 1; }
  $SUDO chattr +i "$marker" 2>/dev/null || true      # best-effort immutability of the consumption record (after durability)
}

# ---- predecessor + host gates ------------------------------------------------------------------------------------------------------------------------------------------
recovery_commit_gate() { r1bv_commit_gate "$@"; }
recovery_predecessor_gate() { r1bv_recovery_predecessor_gate "$@"; }   # the existing, reviewed R1B-failure + R1Bv-PASS predecessor gate (reused, never copied)
recovery_ctu_successor_gate() {
  local repo main ctu_main execution_main runner_sha evidence_manifest device detector_mode canon closeout host_sha host_sum receipt receipt_sha rel receipt_rel want=0 count keys installed_unit installed_sha ctu_unit_sha
  if [ $# -ge 2 ]; then
    repo=$1; main=$2
  elif [ -n "${REPO:-}" ]; then
    repo=$REPO; main=$1
  else
    repo=""; main=$1
  fi
  [ -n "$SUDO" ] || want=$(id -u)
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || { recovery_reason RECOVERY_CTU_MAIN_INVALID; return 1; }
  canon=$(recovery_canonical_dir); closeout="$canon/CTU-GLOBAL-CLOSEOUT-PASS"
  recovery_canonical_dir_valid || { recovery_reason RECOVERY_CTU_CANONICAL_DIR_INVALID; return 1; }
  if $SUDO test -e "$canon/$RECOVERY_GLOBAL_MARKER_NAME" || $SUDO test -L "$canon/$RECOVERY_GLOBAL_MARKER_NAME"; then
    recovery_reason RECOVERY_ALREADY_CONSUMED; return 1
  fi
  count=$($SUDO find "$canon" -maxdepth 1 -type f \( -name 'CTU-GLOBAL-CLOSEOUT-PASS' -o -name 'CTU-GLOBAL-CLOSEOUT-FAIL' \) -printf '%f\n' 2>/dev/null | wc -l)
  [ "$count" = 1 ] || { recovery_reason RECOVERY_CTU_CLOSEOUT_NOT_UNIQUE; return 1; }
  [ -f "$closeout" ] && [ ! -L "$closeout" ] || { recovery_reason RECOVERY_CTU_PASS_CLOSEOUT_MISSING; return 1; }
  [ "$(stat -c %u -- "$closeout" 2>/dev/null)" = "$want" ] || { recovery_reason RECOVERY_CTU_PASS_CLOSEOUT_OWNER_INVALID; return 1; }
  host_sum="$closeout.sha256"
  [ -f "$host_sum" ] && [ ! -L "$host_sum" ] && [ "$(stat -c %u:%a "$host_sum" 2>/dev/null)" = "$want:600" ] || { recovery_reason RECOVERY_CTU_HOST_CLOSEOUT_DIGEST_MISSING; return 1; }
  ( cd "$canon" && sha256sum -c --quiet --strict "$(basename "$host_sum")" ) || { recovery_reason RECOVERY_CTU_HOST_CLOSEOUT_DIGEST_INVALID; return 1; }
  host_sha=$($SUDO awk 'NF >= 1 {print $1}' "$host_sum")
  keys=$($SUDO awk -F= 'NF >= 2 {print $1}' "$closeout" | sort | uniq -d)
  [ -z "$keys" ] || { recovery_reason RECOVERY_CTU_CLOSEOUT_DUPLICATE_KEYS; return 1; }
  [ "$($SUDO awk -F= 'NF >= 2 {print $1}' "$closeout" | sort | tr '\n' ' ')" = "CTU_ATTEMPT_CONSUMED CTU_AUTHENTICATED_STATUS_PROOF CTU_DETECTOR_BASELINE_MODE CTU_DETECTOR_LIFECYCLE_PROOF CTU_DEVICE_ID CTU_EVIDENCE_MANIFEST_SHA256 CTU_EVIDENCE_ROOT CTU_EXECUTION_MAIN CTU_EXPECTED_MAIN CTU_FAILURE_RESULT CTU_LIVE CTU_LIVE_EXECUTED CTU_PRE_POST_PRESERVATION CTU_RERUN_ALLOWED CTU_RESULT CTU_RUNNER_SHA256 CTU_RUNTIME_PROOF CTU_STAGE CTU_UNIT_SHA256 RECOVERY_ATTEMPT_CONSUMED RECOVERY_LIVE_EXECUTED " ] || { recovery_reason RECOVERY_CTU_CLOSEOUT_FIELDS_INVALID; return 1; }
  grep -qx "CTU_LIVE=$(printf 'CLOSED_%s' PASS)" "$closeout" || { recovery_reason RECOVERY_CTU_LIVE_NOT_CLOSED_RESULT; return 1; }
  grep -qx 'CTU_LIVE_EXECUTED=YES' "$closeout" || { recovery_reason RECOVERY_CTU_LIVE_NOT_EXECUTED; return 1; }
  grep -qx 'CTU_RESULT=PASS' "$closeout" || { recovery_reason RECOVERY_CTU_PASS_RESULT_INVALID; return 1; }
  grep -qx 'CTU_ATTEMPT_CONSUMED=YES' "$closeout" || { recovery_reason RECOVERY_CTU_ATTEMPT_NOT_CONSUMED; return 1; }
  grep -qx 'CTU_RERUN_ALLOWED=NO' "$closeout" || { recovery_reason RECOVERY_CTU_RERUN_ALLOWED; return 1; }
  ctu_main=$($SUDO awk -F= '$1 == "CTU_EXPECTED_MAIN" {print $2}' "$closeout")
  [[ "$ctu_main" =~ ^[0-9a-f]{40}$ ]] || { recovery_reason RECOVERY_CTU_MAIN_INVALID; return 1; }
  if [ -n "$repo" ] && [ -d "$repo/.git" ]; then
    if [ "$ctu_main" != "$main" ]; then
      GIT_NO_REPLACE_OBJECTS=1 git -C "$repo" merge-base --is-ancestor "$ctu_main" "$main" 2>/dev/null || { recovery_reason RECOVERY_CTU_MAIN_NOT_ANCESTOR; return 1; }
    fi
  else
    [ "$ctu_main" = "$main" ] || { recovery_reason RECOVERY_CTU_MAIN_MISMATCH; return 1; }
  fi
  grep -qx 'CTU_STAGE=CTu' "$closeout" || { recovery_reason RECOVERY_CTU_SUCCESSOR_INVALID; return 1; }
  grep -qx 'CTU_RUNTIME_PROOF=PASS' "$closeout" || { recovery_reason RECOVERY_CTU_RUNTIME_PROOF_INVALID; return 1; }
  grep -qx 'CTU_AUTHENTICATED_STATUS_PROOF=PASS' "$closeout" || { recovery_reason RECOVERY_CTU_AUTH_PROOF_INVALID; return 1; }
  grep -qx 'CTU_DETECTOR_LIFECYCLE_PROOF=PASS' "$closeout" || { recovery_reason RECOVERY_CTU_DETECTOR_PROOF_INVALID; return 1; }
  grep -qE '^CTU_DETECTOR_BASELINE_MODE=(ACTIVE|INACTIVE)$' "$closeout" || { recovery_reason RECOVERY_CTU_DETECTOR_MODE_INVALID; return 1; }
  grep -qE '^CTU_DEVICE_ID=[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' "$closeout" || { recovery_reason RECOVERY_CTU_DEVICE_ID_INVALID; return 1; }
  execution_main=$($SUDO awk -F= '$1 == "CTU_EXECUTION_MAIN" {print $2}' "$closeout")
  [ "$execution_main" = "$ctu_main" ] || { recovery_reason RECOVERY_CTU_EXECUTION_MAIN_INVALID; return 1; }
  runner_sha=$($SUDO awk -F= '$1 == "CTU_RUNNER_SHA256" {print $2}' "$closeout")
  [[ "$runner_sha" =~ ^[0-9a-f]{64}$ ]] || { recovery_reason RECOVERY_CTU_RUNNER_SHA_INVALID; return 1; }
  evidence_manifest=$($SUDO awk -F= '$1 == "CTU_EVIDENCE_MANIFEST_SHA256" {print $2}' "$closeout")
  [[ "$evidence_manifest" =~ ^[0-9a-f]{64}$ ]] || { recovery_reason RECOVERY_CTU_EVIDENCE_MANIFEST_INVALID; return 1; }
  device=$($SUDO awk -F= '$1 == "CTU_DEVICE_ID" {print $2}' "$closeout")
  detector_mode=$($SUDO awk -F= '$1 == "CTU_DETECTOR_BASELINE_MODE" {print $2}' "$closeout")
  ctu_unit_sha=$($SUDO awk -F= '$1 == "CTU_UNIT_SHA256" {print $2}' "$closeout")
  grep -qx 'CTU_PRE_POST_PRESERVATION=PASS' "$closeout" || { recovery_reason RECOVERY_CTU_PRESERVATION_PROOF_INVALID; return 1; }
  grep -qx 'RECOVERY_LIVE_EXECUTED=NO' "$closeout" || { recovery_reason RECOVERY_CTU_RECOVERY_ALREADY_EXECUTED; return 1; }
  grep -qx 'RECOVERY_ATTEMPT_CONSUMED=NO' "$closeout" || { recovery_reason RECOVERY_CTU_RECOVERY_ALREADY_CONSUMED; return 1; }
  grep -qx 'CTU_FAILURE_RESULT=NONE' "$closeout" || { recovery_reason RECOVERY_CTU_CONTRADICTORY_FAILURE; return 1; }
  grep -qE '^CTU_UNIT_SHA256=[0-9a-f]{64}$' "$closeout" || { recovery_reason RECOVERY_CTU_UNIT_BINDING_INVALID; return 1; }
  grep -qE '^CTU_EVIDENCE_ROOT=/[^.]*$' "$closeout" || { recovery_reason RECOVERY_CTU_EVIDENCE_ROOT_INVALID; return 1; }
  if [ "${RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT:-}" ]; then
    receipt="$RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT"
  else
    receipt_rel=${CTU_LIVE_RECEIPT_RELATIVE:-}
    [[ "$receipt_rel" == /* && "$receipt_rel" != *..* ]] || { recovery_reason RECOVERY_CTU_LIVE_RECEIPT_PIN_INVALID; return 1; }
    receipt="$repo$receipt_rel"
  fi
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || { recovery_reason RECOVERY_CTU_LIVE_RECEIPT_MISSING; return 1; }
  receipt_sha=$($SUDO sha256sum "$receipt" | cut -d' ' -f1)
  if [ "${RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" != YES ] || [ -z "${RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT:-}" ]; then
    [ "$receipt_sha" = "${CTU_REPO_RECEIPT_SHA256:-}" ] || { recovery_reason RECOVERY_CTU_LIVE_RECEIPT_DIGEST_INVALID; return 1; }
    rel=${receipt#"$repo/"}
    [ "$rel" != "$receipt" ] && [ "$(git -C "$repo" hash-object -- "$rel")" = "$receipt_sha" ] && [ "$(git -C "$repo" rev-parse "$main:$rel" 2>/dev/null)" = "$receipt_sha" ] || { recovery_reason RECOVERY_CTU_LIVE_RECEIPT_NOT_IN_EXACT_MAIN; return 1; }
  fi
  local live_pass; live_pass="CLOSED_"'PASS'
  grep -qx "CTU_LIVE=$live_pass" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_NOT_LIVE_PASS; return 1; }
  grep -qx 'CTU_LIVE_EXECUTED=YES' "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_NOT_EXECUTED; return 1; }
  grep -qx 'CTU_ATTEMPT_CONSUMED=YES' "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_NOT_CONSUMED; return 1; }
  grep -qx "CTU_EXPECTED_MAIN=$ctu_main" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_MAIN_INVALID; return 1; }
  grep -qx "CTU_EXECUTION_MAIN=$execution_main" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_EXECUTION_MAIN_INVALID; return 1; }
  grep -qx "CTU_RUNNER_SHA256=$runner_sha" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_RUNNER_INVALID; return 1; }
  grep -qx "CTU_UNIT_SHA256=$ctu_unit_sha" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_UNIT_INVALID; return 1; }
  grep -qx "CTU_DEVICE_ID=$device" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_DEVICE_INVALID; return 1; }
  grep -qx "CTU_DETECTOR_BASELINE_MODE=$detector_mode" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_MODE_INVALID; return 1; }
  grep -qx "CTU_EVIDENCE_MANIFEST_SHA256=$evidence_manifest" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_EVIDENCE_INVALID; return 1; }
  grep -qx "CTU_HOST_CLOSEOUT_SHA256=$host_sha" "$receipt" || { recovery_reason RECOVERY_CTU_REPOSITORY_RECEIPT_HOST_BINDING_INVALID; return 1; }
  installed_unit="${AEGIS_CORE_UNIT_FILE:-/etc/systemd/system/aegis-idea3-core.service}"
  if [ -n "${AEGIS_CORE_UNIT_FILE:-}" ] || [ "${RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" != YES ]; then
    if [ -f "$installed_unit" ] && [ ! -L "$installed_unit" ]; then
      installed_sha=$($SUDO sha256sum "$installed_unit" 2>/dev/null | cut -d' ' -f1)
      [ "$installed_sha" = "$ctu_unit_sha" ] || { recovery_reason RECOVERY_CTU_INSTALLED_UNIT_MISMATCH; return 1; }
      grep -qE '^[[:space:]]*ProtectClock[[:space:]]*=[[:space:]]*(false|no)[[:space:]]*$' "$installed_unit" || { recovery_reason RECOVERY_CTU_PROTECTCLOCK_INVALID; return 1; }
      grep -qE '^[[:space:]]*User[[:space:]]*=[[:space:]]*aegis-idea3[[:space:]]*$' "$installed_unit" || { recovery_reason RECOVERY_CTU_SECURITY_HARDENING_INVALID; return 1; }
      grep -qE '^[[:space:]]*NoNewPrivileges[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$installed_unit" || { recovery_reason RECOVERY_CTU_SECURITY_HARDENING_INVALID; return 1; }
      grep -qE '^[[:space:]]*CapabilityBoundingSet[[:space:]]*=[[:space:]]*$' "$installed_unit" || { recovery_reason RECOVERY_CTU_SECURITY_HARDENING_INVALID; return 1; }
      grep -qE '^[[:space:]]*AmbientCapabilities[[:space:]]*=[[:space:]]*$' "$installed_unit" || { recovery_reason RECOVERY_CTU_SECURITY_HARDENING_INVALID; return 1; }
    fi
  fi
}

# This is a separate Recovery predecessor path.  CTu FAIL is never promoted to
# PASS: this path requires a distinct, reviewed CTv CLOSED_PASS closeout and
# the CTv repository receipt bound to the same exact main.
recovery_ctv_successor_gate() {
  local repo=${1:-} main=${2:-} canon closeout receipt_rel receipt receipt_sha want=0
  [ -n "$repo" ] && [ -d "$repo/.git" ] && [[ "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ -z "$SUDO" ] || want=0
  [ -n "$SUDO" ] || want=$(id -u)
  canon=$(recovery_canonical_dir)
  recovery_canonical_dir_valid || { recovery_reason RECOVERY_CTV_CANONICAL_DIR_INVALID; return 1; }
  [ ! -e "$canon/$RECOVERY_GLOBAL_MARKER_NAME" ] || { recovery_reason RECOVERY_ALREADY_CONSUMED; return 1; }
  [ -f "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -L "$canon/CTU-GLOBAL-ATTEMPT-CONSUMED" ] || { recovery_reason RECOVERY_CTV_CTU_ATTEMPT_MARKER_MISSING; return 1; }
  [ -f "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" ] && [ ! -L "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" ] || { recovery_reason RECOVERY_CTV_CTU_FAIL_CLOSEOUT_MISSING; return 1; }
  [ ! -e "$canon/CTU-GLOBAL-CLOSEOUT-PASS" ] && [ ! -L "$canon/CTU-GLOBAL-CLOSEOUT-PASS" ] || { recovery_reason RECOVERY_CTV_CTU_PASS_MUST_BE_ABSENT; return 1; }
  grep -qx 'CTU_RESULT=FAIL_IMMUTABLE' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || { recovery_reason RECOVERY_CTV_CTU_RESULT_INVALID; return 1; }
  grep -qx 'CTU_FAILURE_REASON=APPLY' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || { recovery_reason RECOVERY_CTV_CTU_FAILURE_REASON_INVALID; return 1; }
  grep -qx 'CTU_ATTEMPT_CONSUMED=YES' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || { recovery_reason RECOVERY_CTV_CTU_ATTEMPT_INVALID; return 1; }
  grep -qx 'CTU_RERUN_ALLOWED=NO' "$canon/CTU-GLOBAL-CLOSEOUT-FAIL" || { recovery_reason RECOVERY_CTV_CTU_RERUN_INVALID; return 1; }
  [ -f "$canon/CTV-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -L "$canon/CTV-GLOBAL-ATTEMPT-CONSUMED" ] || { recovery_reason RECOVERY_CTV_ATTEMPT_MARKER_MISSING; return 1; }
  grep -qx 'CTV_ATTEMPT_CONSUMED=YES' "$canon/CTV-GLOBAL-ATTEMPT-CONSUMED" || { recovery_reason RECOVERY_CTV_ATTEMPT_MARKER_INVALID; return 1; }
  [ ! -e "$canon/CTV-GLOBAL-CLOSEOUT-FAIL" ] && [ ! -L "$canon/CTV-GLOBAL-CLOSEOUT-FAIL" ] || { recovery_reason RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT; return 1; }
  closeout="$canon/CTV-GLOBAL-CLOSEOUT-PASS"
  [ -f "$closeout" ] && [ ! -L "$closeout" ] && [ "$(stat -c %u:%a "$closeout" 2>/dev/null)" = "$want:600" ] || { recovery_reason RECOVERY_CTV_PASS_CLOSEOUT_UNTRUSTED; return 1; }
  grep -qx 'CTV_RESULT=CLOSED_PASS' "$closeout" || { recovery_reason RECOVERY_CTV_RESULT_INVALID; return 1; }
  grep -qx 'CTV_IS_CTU_RETRY=NO' "$closeout" || { recovery_reason RECOVERY_CTV_RETRY_FLAG_INVALID; return 1; }
  grep -qx 'CTV_ATTEMPT_CONSUMED=YES' "$closeout" || { recovery_reason RECOVERY_CTV_ATTEMPT_NOT_CONSUMED; return 1; }
  grep -qx 'CTV_RERUN_ALLOWED=NO' "$closeout" || { recovery_reason RECOVERY_CTV_RERUN_ALLOWED; return 1; }
  grep -qx "CTV_EXPECTED_MAIN=$main" "$closeout" || { recovery_reason RECOVERY_CTV_MAIN_MISMATCH; return 1; }
  receipt_rel=${CTV_LIVE_RECEIPT_RELATIVE:-}; receipt_sha=${CTV_REPO_RECEIPT_SHA256:-}
  [[ -n "$receipt_rel" && "$receipt_rel" != /* && "$receipt_rel" != *..* && "$receipt_sha" =~ ^[0-9a-f]{64}$ ]] || { recovery_reason RECOVERY_CTV_RECEIPT_PIN_INVALID; return 1; }
  receipt="$repo/$receipt_rel"
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || { recovery_reason RECOVERY_CTV_RECEIPT_MISSING; return 1; }
  [ "$(sha256sum "$receipt" | cut -d' ' -f1)" = "$receipt_sha" ] || { recovery_reason RECOVERY_CTV_RECEIPT_DIGEST_INVALID; return 1; }
  [[ "$receipt_rel" != /* && "$receipt_rel" != *..* && "$receipt_rel" != *//* ]] || { recovery_reason RECOVERY_CTV_RECEIPT_PATH_INVALID; return 1; }
  [ "$(git -C "$repo" cat-file -e "$main:$receipt_rel" 2>/dev/null; git -C "$repo" show "$main:$receipt_rel" 2>/dev/null | sha256sum | cut -d' ' -f1)" = "$receipt_sha" ] || { recovery_reason RECOVERY_CTV_RECEIPT_NOT_EXACT_MAIN; return 1; }
  [ -f "$closeout.sha256" ] && [ ! -L "$closeout.sha256" ] && [ "$(stat -c %u:%a "$closeout.sha256" 2>/dev/null)" = "$want:444" ] && (cd "$canon" && sha256sum --strict --check "$(basename "$closeout.sha256")" >/dev/null 2>&1) || { recovery_reason RECOVERY_CTV_CLOSEOUT_DIGEST_INVALID; return 1; }
  grep -qx 'CTV_LIVE=CLOSED_PASS' "$receipt" || { recovery_reason RECOVERY_CTV_RECEIPT_NOT_PASS; return 1; }
  grep -qx 'CTV_IS_CTU_RETRY=NO' "$receipt" || { recovery_reason RECOVERY_CTV_RECEIPT_RETRY_INVALID; return 1; }
  grep -qx 'CTV_LIVE_EXECUTED=YES' "$closeout" || { recovery_reason RECOVERY_CTV_NOT_EXECUTED; return 1; }
  grep -Eq '^CTV_DETECTOR_BASELINE_MODE=(ACTIVE|INACTIVE)$' "$closeout" || { recovery_reason RECOVERY_CTV_DETECTOR_MODE_INVALID; return 1; }
  grep -Eq '^CTV_DEVICE_ID=[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' "$closeout" || { recovery_reason RECOVERY_CTV_DEVICE_ID_INVALID; return 1; }
  grep -Eq '^CTV_EVIDENCE_MANIFEST_SHA256=[0-9a-f]{64}$' "$closeout" || { recovery_reason RECOVERY_CTV_EVIDENCE_INVALID; return 1; }
  for field in CTV_FROZEN_RUNNER_SHA256 CTV_RUNNER_TEMPLATE_SHA256 CTV_BUNDLE_MANIFEST_SHA256 CTV_CONTROL_MANIFEST_SHA256 CTV_UNIT_SHA256 CTV_EVIDENCE_MANIFEST_SHA256; do
    grep -Eq "^${field}=[0-9a-f]{64}$" "$closeout" || { recovery_reason "RECOVERY_CTV_${field}_MISSING_OR_INVALID"; return 1; }
  done
  grep -qx 'CTV_RUNTIME_PROOF=PASS' "$closeout" || { recovery_reason RECOVERY_CTV_RUNTIME_PROOF_INVALID; return 1; }
  grep -qx 'CTV_PRE_POST_PRESERVATION=PASS' "$closeout" || { recovery_reason RECOVERY_CTV_PRESERVATION_INVALID; return 1; }
  installed_unit=${AEGIS_CORE_UNIT_FILE:-/etc/systemd/system/aegis-idea3-core.service}
  [ -f "$installed_unit" ] && [ ! -L "$installed_unit" ] || { recovery_reason RECOVERY_CTV_INSTALLED_UNIT_MISSING; return 1; }
  [ "$(sha256sum "$installed_unit" | cut -d' ' -f1)" = "$(awk -F= '$1 == "CTV_UNIT_SHA256" {print $2}' "$closeout")" ] || { recovery_reason RECOVERY_CTV_INSTALLED_UNIT_MISMATCH; return 1; }
  grep -qx 'ProtectClock=false' "$installed_unit" || { recovery_reason RECOVERY_CTV_PROTECTCLOCK_INVALID; return 1; }
  grep -qx 'User=aegis-idea3' "$installed_unit" || { recovery_reason RECOVERY_CTV_USER_INVALID; return 1; }
  grep -qx 'NoNewPrivileges=true' "$installed_unit" || { recovery_reason RECOVERY_CTV_NONPRIVILEGE_INVALID; return 1; }
  grep -qx 'CapabilityBoundingSet=' "$installed_unit" || { recovery_reason RECOVERY_CTV_CAPABILITY_BOUND_INVALID; return 1; }
  grep -qx 'AmbientCapabilities=' "$installed_unit" || { recovery_reason RECOVERY_CTV_AMBIENT_CAPABILITY_INVALID; return 1; }
}
recovery_successor_detector_mode_gate() {
  local canon mode
  canon=$(recovery_canonical_dir)
  if [ -f "$canon/CTV-GLOBAL-CLOSEOUT-PASS" ]; then
    mode=$($SUDO awk -F= '$1 == "CTV_DETECTOR_BASELINE_MODE" {print $2}' "$canon/CTV-GLOBAL-CLOSEOUT-PASS" 2>/dev/null)
    case "$mode" in ACTIVE|INACTIVE) ;; *) recovery_reason RECOVERY_CTV_DETECTOR_MODE_INVALID; return 1;; esac
    return 0
  fi
  recovery_ctu_detector_mode_gate
}
recovery_ctu_detector_mode_gate() {
  local canon mode out pid
  canon=$(recovery_canonical_dir)
  mode=$($SUDO awk -F= '$1 == "CTU_DETECTOR_BASELINE_MODE" {print $2}' "$canon/CTU-GLOBAL-CLOSEOUT-PASS" 2>/dev/null)
  case "$mode" in
    ACTIVE)
      f1u_detector_running_gate || { recovery_reason RECOVERY_CTU_ACTIVE_DETECTOR_MISMATCH; return 1; }
      ;;
    INACTIVE)
      out=$($SUDO systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Restart -p MainPID -p InvocationID -p NRestarts aegis-idea3-detector.service 2>/dev/null) || { recovery_reason RECOVERY_CTU_INACTIVE_DETECTOR_STATE_UNREADABLE; return 1; }
      pid=$(awk -F= '$1 == "MainPID" {print $2}' <<< "$out")
      grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=inactive' <<< "$out" && grep -qx 'SubState=dead' <<< "$out" && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [ "$pid" = 0 ] && grep -qx 'InvocationID=' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" || { recovery_reason RECOVERY_CTU_INACTIVE_DETECTOR_MISMATCH; return 1; }
      [ "$($SUDO pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 0 ] || { recovery_reason RECOVERY_CTU_INACTIVE_PROCESS_PRESENT; return 1; }
      ;;
    *) recovery_reason RECOVERY_CTU_DETECTOR_MODE_INVALID; return 1 ;;
  esac
}

recovery_sudo_noninteractive_gate() {
  [ -z "$SUDO" ] || $SUDO true 2>/dev/null || { recovery_reason RECOVERY_SUDO_CREDENTIAL_NOT_ACTIVE; return 1; }
}
# recovery_env_gate — nothing in the caller's environment may redirect an interpreter, a loader, a module path, a fixture root or a Recovery/RESTORE target.
recovery_env_gate() {
  local var
  for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PYTHONINSPECT PYTHONBREAKPOINT PYTHONEXECUTABLE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV \
      AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_RECOVERY_SOCKET AEGIS_RECOVERY_CORE_USER AEGIS_RCVSTAGE_APP_DIR AEGIS_RCVSTAGE_AUDIT_DB AEGIS_RCVSTAGE_PROTOCOL_DB AEGIS_RCVSTAGE_WORK_DIR \
      AEGIS_RCVSTAGE_STEP AEGIS_RCVSTAGE_LIVE_AUTHORIZED AEGIS_RCVSTAGE_SECRET RECOVERY_SECRET RECOVERY_RESTORE_CONFIRMATION RECOVERY_TEST_ONLY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED \
      RECOVERY_TEST_ONLY_TRUST_ROOT RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT GLOBAL_MARKER_DIR AEGIS_LOG_PATH AEGIS_DB_PATH; do
    [ -z "${!var:-}" ] || { recovery_reason "RECOVERY_ENVIRONMENT_OVERRIDE_SET:$var"; return 1; }
  done
}
recovery_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { recovery_reason "RECOVERY_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $RECOVERY_R1I_TABLE" || { recovery_reason "RECOVERY_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $RECOVERY_R1I_TABLE 2>/dev/null) || { recovery_reason "RECOVERY_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | /usr/bin/python3 -I -B "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { recovery_reason "RECOVERY_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
}
recovery_digest_gate() {
  local file=${1:-} want=${2:-} label=${3:-FILE} got
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ -f "$file" ] || { recovery_reason "RECOVERY_${label}_DIGEST_INPUT_INVALID"; return 1; }
  got=$($SUDO sha256sum "$file" 2>/dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || { recovery_reason "RECOVERY_${label}_DIGEST_MISMATCH"; return 1; }
}
recovery_current_release_gate() {
  local link=${1:-} want=${2:-}
  [ "$($SUDO readlink "$link" 2>/dev/null)" = "$want" ] || { recovery_reason "RECOVERY_CURRENT_RELEASE_DRIFT"; return 1; }
}
# recovery_interpreter_gate PY — the interpreter is an absolute path that resolves to a regular file owned by root and not group/world writable (root runs it; the operator runs it for the Core client steps).
recovery_interpreter_gate() {
  local resolved
  resolved=$(readlink -f "${1:-}" 2>/dev/null) && [ -f "$resolved" ] && [[ "${1:-}" == /* ]] || { recovery_reason "RECOVERY_INTERPRETER_UNRESOLVABLE"; return 1; }
  [ "$(stat -c %U "$resolved")" = root ] && [ -z "$(find "$resolved" -maxdepth 0 -perm /022 2>/dev/null)" ] || { recovery_reason "RECOVERY_INTERPRETER_NOT_ROOT_OWNED"; return 1; }
}
# recovery_verifier_gate SNAPSHOT MANIFEST_SHA256 REPO TOOL MAIN — the verifier source the operator AND root execute is the frozen immutable snapshot: the pinned tool re-proves the manifest, every file digest, the
# exact file set, no symlink, root ownership and a trusted ancestor chain to `/`; every snapshot file is byte-identical to the PINNED-main git object; and the required module closure exists.
recovery_verifier_gate() {
  local snap=${1:-} want=${2:-} repo=${3:-} tool=${4:-} main=${5:-} sha rel got module
  [ -f "$tool" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { recovery_reason "RECOVERY_VERIFIER_GATE_INPUT_INVALID"; return 1; }
  recovery_commit_gate "$repo" "$main" || return 1
  /usr/bin/python3 -I -B "$tool" check "$snap" "$want" >/dev/null 2>&1 || { recovery_reason "RECOVERY_VERIFIER_SNAPSHOT_DRIFT_OR_NOT_ROOT_OWNED"; return 1; }
  while read -r sha rel; do
    [ "$rel" != "" ] || continue
    got=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { recovery_reason "RECOVERY_VERIFIER_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel"; return 1; }
  done < "$snap/RECOVERY-VERIFIER-SHA256SUMS"
  for module in recovery_stage recovery_evidence recovery_client recovery_protocol local_restore ip_containment r1_acceptance r1bv_validation historical_disposition; do
    [ -f "$snap/aegis_soc/$module.py" ] || { recovery_reason "RECOVERY_VERIFIER_CLOSURE_INCOMPLETE:$module"; return 1; }
  done
}
# recovery_cli_gate RELEASE_PATH CLI_SHA256 — the program the owner types the RESTORE secret into is EXACTLY the pinned release's own CLI: the release directory and the CLI tree are canonical, root-owned and not
# group/world writable with no symlink, `aegis_soc/cli.py` matches its frozen digest, and the release interpreter resolves to a regular root-owned file.
recovery_cli_gate() {
  local release=${1:-} want=${2:-} entry
  [[ "$release" == /* ]] && [[ "$release" != *..* ]] && [ "$(readlink -f "$release" 2>/dev/null)" = "$release" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { recovery_reason "RECOVERY_CLI_INPUT_INVALID"; return 1; }
  for entry in "$release" "$release/aegis_soc" "$release/aegis_soc/cli.py" "$release/venv/bin/python"; do
    [ -e "$entry" ] || { recovery_reason "RECOVERY_CLI_ENTRY_MISSING:$entry"; return 1; }
  done
  for entry in "$release" "$release/aegis_soc" "$release/aegis_soc/cli.py"; do
    [ ! -L "$entry" ] && [ "$(stat -c %U "$entry")" = root ] && [ -z "$(find "$entry" -maxdepth 0 -perm /022 2>/dev/null)" ] || { recovery_reason "RECOVERY_CLI_NOT_ROOT_OWNED_OR_WRITABLE:$entry"; return 1; }
  done
  [ -z "$(find "$release/aegis_soc" -type l -print -quit 2>/dev/null)" ] && [ -z "$(find "$release/aegis_soc" -perm /022 -print -quit 2>/dev/null)" ] || { recovery_reason "RECOVERY_CLI_TREE_SYMLINK_OR_WRITABLE"; return 1; }
  [ "$(sha256sum "$release/aegis_soc/cli.py" 2>/dev/null | cut -d' ' -f1)" = "$want" ] || { recovery_reason "RECOVERY_CLI_DIGEST_MISMATCH"; return 1; }
  recovery_interpreter_gate "$release/venv/bin/python" || return 1
}

# recovery_release_closure_gate RELEASE_ID RELEASE_PATH SUMS_SHA256 — the D4 execution closure is the release's OWN authoritative manifest: the existing L7 release guard (real directory, no symlink/special file, root-owned,
# nothing group/world-writable, exact layout, RELEASE-SHA256SUMS matching EVERY payload file incl. the whole aegis_soc closure and the venv) plus the pinned digest of that manifest and the manifested `cli.py` entry.
recovery_release_closure_gate() {
  local rid=${1:-} release=${2:-} sums=${3:-} guard="${CTRL:-}/p4-l7-release-guard.py" out cli_sha
  [[ "$rid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$sums" =~ ^[0-9a-f]{64}$ ]] && [ -f "$guard" ] || { recovery_reason "RECOVERY_RELEASE_CLOSURE_INPUT_INVALID"; return 1; }
  out=$($SUDO "$PY" "$guard" check --logical-path "/opt/aegis-idea3/releases/$rid" --host-path "$release" --expect-owner root 2>&1) && [[ "$out" == L7_RELEASE_GUARD=PASS* ]] \
    || { recovery_reason "RECOVERY_RELEASE_CLOSURE_NOT_THE_MANIFESTED_RELEASE:${out##*reason=}"; return 1; }
  [ "$($SUDO sha256sum "$release/RELEASE-SHA256SUMS" 2>/dev/null | cut -d' ' -f1)" = "$sums" ] || { recovery_reason "RECOVERY_RELEASE_MANIFEST_DIGEST_MISMATCH"; return 1; }
  cli_sha=$(sha256sum "$release/aegis_soc/cli.py" 2>/dev/null | cut -d' ' -f1)
  grep -qx "$cli_sha  aegis_soc/cli.py" "$release/RELEASE-SHA256SUMS" 2>/dev/null || { recovery_reason "RECOVERY_CLI_NOT_A_MANIFESTED_ENTRY"; return 1; }
}

# ---- bounded sudo keepalive (F3): ONE interactive `sudo -v` is the runner's; this library only ever runs `sudo -n -v` afterwards ------------------------------------------------------------------------------
# A failed refresh signals the owner-run process (USR1, trapped here); the gate then fails closed. Before the marker that is RECOVERY_ATTEMPT_CONSUMED=NO; after it, FAIL_IMMUTABLE. Nothing persists beyond this process: the loop
# ends when the parent exits, at EXIT (the runner's trap) or after RECOVERY_KEEPALIVE_MAX_SEC. No secret is ever involved.
recovery_keepalive_failed() { RECOVERY_KEEPALIVE_FAILED=1; }
recovery_start_sudo_keepalive() {
  local parent=$$ interval=$RECOVERY_KEEPALIVE_INTERVAL_SEC max=$RECOVERY_KEEPALIVE_MAX_SEC
  [ -n "$SUDO" ] || return 0
  [ -z "$RECOVERY_KEEPALIVE_PID" ] || { recovery_reason "RECOVERY_KEEPALIVE_ALREADY_STARTED"; return 1; }
  trap recovery_keepalive_failed USR1
  (
    waited=0
    while kill -0 "$parent" 2>/dev/null && [ "$waited" -lt "$max" ]; do
      sleep "$interval"; waited=$((waited + interval))
      $SUDO -v >/dev/null 2>&1 </dev/null || { kill -USR1 "$parent" 2>/dev/null; exit 1; }
    done
  ) >/dev/null 2>&1 </dev/null &
  RECOVERY_KEEPALIVE_PID=$!
}
recovery_stop_sudo_keepalive() {
  [ -z "$RECOVERY_KEEPALIVE_PID" ] || { kill "$RECOVERY_KEEPALIVE_PID" 2>/dev/null; wait "$RECOVERY_KEEPALIVE_PID" 2>/dev/null; RECOVERY_KEEPALIVE_PID=""; }
  return 0
}
# recovery_sudo_authority_gate — the refresher is running, has never failed, and a non-interactive privileged command works RIGHT NOW.
recovery_sudo_authority_gate() {
  [ -n "$SUDO" ] || return 0
  [ -n "$RECOVERY_KEEPALIVE_PID" ] && [ "$RECOVERY_KEEPALIVE_FAILED" = 0 ] && kill -0 "$RECOVERY_KEEPALIVE_PID" 2>/dev/null || { recovery_reason "RECOVERY_SUDO_KEEPALIVE_NOT_HEALTHY"; return 1; }
  $SUDO true >/dev/null 2>&1 </dev/null || { recovery_reason "RECOVERY_SUDO_AUTHORITY_LOST"; return 1; }
}

# ---- D4 program preparation (F1/F2): private operator-owned logs OUTSIDE the immutable release, a terminal, and an exact rehearsal BEFORE the marker ----------------------------------------------------------
# recovery_private_log_prepare VAR NAME — "$EVID/NAME" is created exclusively (0600, operator-owned, not a symlink) inside the private operator-owned evidence directory; the path is derived here, never from the environment.
recovery_private_log_prepare() {
  local var=$1 name=$2 me path
  me=$(id -u); path="${EVID:-}/$name"
  [[ "${EVID:-}" == /* ]] && [ -d "$EVID" ] && [ ! -L "$EVID" ] && [ "$(stat -c %u "$EVID")" = "$me" ] && [ -z "$(find "$EVID" -maxdepth 0 -perm /077)" ] || { recovery_reason "RECOVERY_EVIDENCE_DIR_NOT_PRIVATE_OPERATOR_OWNED"; return 1; }
  ( set -o noclobber; : > "$path" ) 2>/dev/null || { recovery_reason "RECOVERY_LOG_NOT_CREATABLE:$name"; return 1; }
  chmod 600 "$path" && [ ! -L "$path" ] && [ "$(stat -c '%a %u' "$path")" = "600 $me" ] || { recovery_reason "RECOVERY_LOG_NOT_PRIVATE:$name"; return 1; }
  printf -v "$var" '%s' "$path"
}
recovery_logs_prepare() { recovery_private_log_prepare RECOVERY_D4_LOG d4-cli.log && recovery_private_log_prepare RECOVERY_OPERATOR_LOG stage-operator.log; }
# recovery_tty_gate — the real CLI refuses (exit 2) without an interactive terminal AFTER the attempt would be consumed; stdin and the terminal output descriptor must both be terminals.
recovery_tty_gate() {
  [ -t 0 ] && [ -t "${RECOVERY_D4_OUT_FD:-1}" ] || { recovery_reason "RECOVERY_INTERACTIVE_TERMINAL_REQUIRED (stdin and the terminal descriptor must be a terminal; nothing was consumed)"; return 1; }
}

# ---- operator / root program wrappers ----------------------------------------------------------------------------------------------------------------------------------
# The Core client steps run as the OPERATOR (the only uid the Core Recovery socket accepts) from the IMMUTABLE verifier snapshot only, with a clean environment and a fixed PATH. Root-side commands use the same
# snapshot under the privilege prefix. Neither ever runs a file from a worktree or /home.
# EVERY invocation sets an explicit AEGIS_LOG_PATH (importing the Core modules opens a log file; without it the path falls back to a relative `aegis_soc.log` in the cwd). Before the private operator log exists it is /dev/null;
# root-side commands log into the root-owned private work directory. The caller's environment never chooses it.
recovery_operator_py() { env -i PATH="$RECOVERY_SAFE_PATH" AEGIS_LOG_PATH="${RECOVERY_OPERATOR_LOG:-/dev/null}" PYTHONDONTWRITEBYTECODE=1 "$PY" -I -B -c 'import runpy,sys; sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[1:]; runpy.run_module("aegis_soc.recovery_stage",run_name="__main__")' "$VERIFIER_SNAPSHOT_DIR" "$@"; }
recovery_root_py() { $SUDO env -i PATH="$RECOVERY_SAFE_PATH" AEGIS_LOG_PATH="${WORK:-/dev/null}/stage-root.log" PYTHONDONTWRITEBYTECODE=1 "$PY" -I -B -c 'import runpy,sys; sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[1:]; runpy.run_module("aegis_soc.recovery_stage",run_name="__main__")' "$VERIFIER_SNAPSHOT_DIR" "$@"; }
# recovery_reason_gate REASON — the existing production RESTORE-reason validator (bounded, printable, no shell-active character). Run BEFORE the marker; the SAME reason is then passed to D4.
recovery_reason_gate() {
  local reason=${1-}
  [ -n "$reason" ] || { recovery_reason "RECOVERY_REASON_REQUIRED"; return 1; }
  recovery_operator_py check-reason "--reason=$reason" >/dev/null 2>&1 || { recovery_reason "RECOVERY_REASON_INVALID"; return 1; }
}

# ---- capture / compare (the generic Phase-4 preservation harness, run as root into the root work directory) ---------------------------------------------------------------
recovery_require_hook() { type "$1" >/dev/null 2>&1 || { recovery_reason "RECOVERY_RUNNER_HOOK_MISSING:$1"; return 1; }; }
# recovery_capture LABEL DIR — ONE read-only L0 capture into DIR (inside the root work directory; never chowned, so the operator can never rewrite it).
recovery_capture() {
  recovery_require_hook recovery_control_gate && recovery_control_gate || return 1
  $SUDO env PYTHONPATH="$VERIFIER_SNAPSHOT_DIR" PYTHONDONTWRITEBYTECODE=1 EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="${JOURNAL_SINCE:-}" bash "$CTRL/p4-l0-capture.sh" || return 1
  $SUDO grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1
  $SUDO bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1
  echo "CAPTURE_$1=COMPLETE SHA256=PASS"
}
# recovery_trustedclock_gate DIR — the captured TrustedClock evidence is available and SYNCED (a missing, UNAVAILABLE or UNTRUSTED capture is a refusal, never a pass).
recovery_trustedclock_gate() {
  $SUDO cat "$1/time.tsv" 2>/dev/null | awk -F'\t' '$1=="time.trustedclock.state" && $2=="SYNCED" {ok=1} END{exit ok?0:1}' || { recovery_reason "RECOVERY_TRUSTEDCLOCK_NOT_SYNCED:$1"; return 1; }
}
# recovery_compare BEFORE AFTER OUTFILE EXPECTED_APPROVED [ALLOW_KEYS_FILE] — the generic comparator with NO static allowance. The ONLY approved findings are the exact keys named by an allow file that was generated
# AFTER the exact containment delta was proven, and their count must equal EXPECTED_APPROVED. Everything else (including unrelated nft/network/service/listener/sysctl drift, TrustedClock, IDEA2 S10) must be clean.
recovery_compare() {
  local before=$1 after=$2 out=$3 approved=$4 allow=${5:-} rc=0 line
  recovery_require_hook recovery_control_gate && recovery_control_gate || return 1
  $SUDO env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="${AP_IF:-}" AEGIS_AP_ADDRESS="${AP_ADDR:-}" ${allow:+ALLOW_KEYS_FILE="$allow"} ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$CTRL/p4-compare.sh" "$before" "$after" > "$out" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$out" || true
  [ "$rc" = 0 ] || return 1
  for line in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 "FINDINGS_APPROVED_CHANGE=$approved" PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$line" "$out" || { echo "COMPARE_REQUIREMENT_FAILED: $line"; return 1; }
  done
}
recovery_runtime_unchanged() {
  local now
  now() { printf '%s/%s\n' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
  [ "$(now "$CORE_UNIT")" = "$CORE_PRE" ] && [ "$(now "$DETECTOR_UNIT")" = "$DETECTOR_PRE" ]
}

# ---- hooks of the attempt state machine --------------------------------------------------------------------------------------------------------------------------------
recovery_hook_pregates() { echo "== Recovery pre-gates (read-only; nothing consumed)"; recovery_require_hook recovery_pregates && recovery_pregates; }
recovery_hook_baseline() {
  local canon
  recovery_require_hook recovery_handler && recovery_require_hook recovery_prepare_evidence || return 1
  recovery_prepare_evidence || { recovery_reason "RECOVERY_EVIDENCE_DIR_NOT_CREATABLE"; return 1; }
  # F1/F2/F3: the private logs, the terminal, the EXACT D4 rehearsal and the privilege authority are proven BEFORE anything else (and long before the marker)
  recovery_logs_prepare && recovery_tty_gate && recovery_d4_rehearsal && recovery_sudo_authority_gate || return 1
  canon=$(recovery_canonical_dir)
  $SUDO test -d "$canon" || $SUDO mkdir -m 0700 "$canon" 2>/dev/null || { recovery_reason "RECOVERY_CANONICAL_DIR_NOT_CREATABLE"; return 1; }
  [ -n "${WORK:-}" ] && [ "$(dirname "$WORK")" = "$canon" ] && ! $SUDO test -e "$WORK" && $SUDO mkdir -m 0700 -- "$WORK" || { recovery_reason "RECOVERY_WORK_DIR_NOT_CREATABLE"; return 1; }
  $SUDO bash -c 'set -o noclobber; printf "RECOVERY_FROZEN_RUNNER_SHA256=%s\nRECOVERY_CONTROL_MANIFEST_SHA256=%s\n" "$1" "$2" > "$3"' _ "$RUNNER_SHA256" "$CONTROL_MANIFEST_SHA256" "$WORK/RECOVERY-FROZEN-RUNNER-PROVENANCE" || { recovery_reason "RECOVERY_PROVENANCE_NOT_CREATED"; return 1; }
  $SUDO chmod 0400 "$WORK/RECOVERY-FROZEN-RUNNER-PROVENANCE" || return 1
  mkdir -m 700 -- "$STEPS" || { recovery_reason "RECOVERY_STEPS_DIR_NOT_CREATABLE"; return 1; }
  echo "== PRE-MARKER quiescence captures, trusted clock, firewall dump and immutable baseline (read-only)"
  recovery_capture PRECHECK "$WORK/precheck-root" || return 1
  recovery_trustedclock_gate "$WORK/precheck-root" || return 1
  sleep "${RECOVERY_QUIESCENCE_SLEEP:-5}"
  recovery_capture PRE "$WORK/pre-root" || return 1
  recovery_trustedclock_gate "$WORK/pre-root" || return 1
  recovery_compare "$WORK/precheck-root" "$WORK/pre-root" "$EVID/compare-preconsume.txt" 0 || { echo "RECOVERY_PRECONSUME_QUIESCENCE=FAIL"; return 1; }
  echo "RECOVERY_PRECONSUME_TRUSTEDCLOCK=PASS"; echo "RECOVERY_PRECONSUME_QUIESCENCE=PASS"
  recovery_handler NFT_PRE || return 1
  recovery_handler NFT_PRE_CHECK || return 1
  recovery_handler READINESS || return 1   # F4/M-c: the running Core's R2/R6/R7 settings and its timezone, proven BEFORE the marker
  recovery_handler BASELINE || return 1
  recovery_operator_py status --steps-dir "$STEPS" && recovery_operator_py probe-pre --steps-dir "$STEPS"
}
recovery_hook_regate() { recovery_require_hook recovery_authority_gates && recovery_authority_gates && recovery_sudo_authority_gate && recovery_tty_gate && recovery_attempt_unconsumed; }
# --- post-marker hooks: ANY failure here is a consumed immutable FAIL; none of them is ever retried -------------------------------------------------------------------------
recovery_hook_isolate() { recovery_operator_py isolate --steps-dir "$STEPS" && recovery_operator_py probe-post-isolate --steps-dir "$STEPS"; }
# recovery_d4_run — the owner's interactive NORMAL-path RESTORE: ONE invocation, from the pinned release, with the validated reason. The secret and the confirmation are typed into that program's own prompts on the
# terminal; this wrapper passes no secret and no confirmation, captures no stdin, and writes the program's output to the terminal descriptors only (never to the run log).
recovery_d4_exec() {
  ( cd "$RELEASE_PATH" && exec env -i PATH="$RECOVERY_SAFE_PATH" HOME="${HOME:-/nonexistent}" TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}" AEGIS_RUNTIME_DIR="$RUNTIME_DIR" AEGIS_LOG_PATH="$RECOVERY_D4_LOG" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 \
      "$RELEASE_PATH/venv/bin/python" -B -s -m aegis_soc.cli restore "--reason=$RECOVERY_REASON" --wait "$RECOVERY_D4_WAIT_SECONDS" )
}
recovery_d4_run() {
  [ -n "$RECOVERY_D4_LOG" ] || { recovery_reason "RECOVERY_D4_LOG_NOT_PREPARED"; return 1; }
  recovery_d4_exec >&"${RECOVERY_D4_OUT_FD:-1}" 2>&"${RECOVERY_D4_ERR_FD:-2}"   # stdin is inherited: the owner types the secret into the program's own prompt
}
# recovery_d4_rehearsal — the EXACT pinned D4 command (same release, interpreter, environment, reason, wait, log) with stdin from /dev/null. The real CLI validates the reason, then refuses BEFORE any prompt, secret read or Recovery
# request because no terminal is attached: exit 2 with that specific message proves import + argument parsing work. It reads no secret, connects to nothing and consumes nothing.
recovery_d4_rehearsal() {
  local out rc
  [ -n "$RECOVERY_D4_LOG" ] || { recovery_reason "RECOVERY_D4_LOG_NOT_PREPARED"; return 1; }
  out=$(recovery_d4_exec </dev/null 2>&1); rc=$?
  [ "$rc" = 2 ] && [[ "$out" == *"RESTORE refused: an interactive local terminal is required"* ]] && [[ "$out" != *Traceback* ]] || { recovery_reason "RECOVERY_D4_REHEARSAL_FAILED (the pinned D4 program did not reach its interactive-terminal refusal; nothing was consumed)"; return 1; }
}
recovery_hook_d4() {
  local code
  recovery_d4_run; code=$?
  # the exit code is recorded ONCE and is only an operator-side hint; 1/2/4 and anything unexpected are terminal; 3 may proceed ONLY into read-only reconciliation (RESTORE is never resent)
  recovery_operator_py record-d4 --steps-dir "$STEPS" --exit-code "$code"
}
recovery_hook_restore_status() { recovery_operator_py restore-status --steps-dir "$STEPS" --wait-seconds 300 && recovery_operator_py probe-final --steps-dir "$STEPS"; }
recovery_hook_close() { recovery_operator_py close --steps-dir "$STEPS" --summary "$RECOVERY_CLOSE_SUMMARY"; }
recovery_hook_final() {
  local out n
  recovery_sudo_authority_gate || { echo "RECOVERY_SUDO_AUTHORITY_LOST_BEFORE_FINAL=YES"; return 1; }
  recovery_require_hook recovery_authority_gates && recovery_authority_gates || { echo "RECOVERY_AUTHORITY_DRIFT_BEFORE_FINAL=YES"; return 1; }
  recovery_capture POST "$WORK/post-root" || return 1
  recovery_trustedclock_gate "$WORK/post-root" || return 1
  recovery_handler NFT_POST || return 1
  recovery_handler FINAL || return 1
  out=$(recovery_handler DELTA) || return 1
  n=$(sed -n 's/^RECOVERY_CONTAINMENT_DELTA=PASS ALLOWED_KEYS=\([0-9][0-9]*\)$/\1/p' <<< "$out")
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { recovery_reason "RECOVERY_CONTAINMENT_DELTA_NOT_PROVEN"; return 1; }
  recovery_compare "$WORK/pre-root" "$WORK/post-root" "$EVID/compare-pre-post.txt" "$n" "$WORK/allow-keys.generated" || return 1
  recovery_runtime_unchanged || { echo "RECOVERY_SERVICE_LIFECYCLE_DRIFT=YES"; return 1; }
  recovery_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || return 1
}
recovery_hook_verify() {
  local out
  out=$(recovery_handler FINAL verify.sh 2>&1) || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"; grep -qx 'RECOVERY_VERIFY=PASS' <<< "$out"
}
recovery_hook_preserve_evidence() {
  # EVIDENCE-PRESERVING: the rollback handler performs no action. Nothing real is deleted, reopened, re-isolated, restored or edited.
  recovery_handler FINAL rollback.sh 2>/dev/null || true
  echo "RECOVERY_EVIDENCE_ROOT=${WORK:-unset} (retained; the canonical attempt marker is retained and never removed)"
}

# ---- attempt state machine ---------------------------------------------------------------------------------------------------------------------------------------------
# Ordering (fixed): pre-gates -> baseline -> re-gate -> CONSUME THE CANONICAL MARKER (immediately before the first mutation) -> ISOLATE -> D4 (ONCE) -> RESTORE_STATUS/PROBE -> CLOSE -> FINAL -> VERIFY ONCE.
# Any failure BEFORE the marker leaves the attempt unconsumed. ANY failure AFTER the marker is RECOVERY_RESULT=FAIL_IMMUTABLE, attempt consumed, rerun not allowed: evidence is preserved and nothing is retried,
# repaired, rolled back or deleted. There is no loop around any hook and no second attempt authority.
recovery_run_attempt() {
  local stage canon
  recovery_attempt_unconsumed || { echo "RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO (refused before any hook)"; return 1; }
  echo "RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO"
  for stage in pregates baseline regate; do
    if ! "recovery_hook_$stage"; then
      echo "RECOVERY_PRE_ATTEMPT_FAILURE=$stage RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO (no marker was created; no Recovery mutation happened)"
      return 1
    fi
  done
  if ! recovery_sudo_authority_gate; then
    echo "RECOVERY_PRE_ATTEMPT_FAILURE=sudo RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO (the privilege authority was lost immediately before the marker; no marker was created)"
    return 1
  fi
  if ! recovery_consume_attempt "$WORK"; then
    canon=$(recovery_canonical_dir)
    if $SUDO test -e "$canon/$RECOVERY_GLOBAL_MARKER_NAME" || $SUDO test -L "$canon/$RECOVERY_GLOBAL_MARKER_NAME"; then
      echo "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=marker RECOVERY_LIVE_EXECUTED=YES RECOVERY_ATTEMPT_CONSUMED=YES RECOVERY_RERUN_ALLOWED=NO RECOVERY_R2_R8_EXECUTED=NO (no Recovery mutation happened)"
      recovery_hook_preserve_evidence marker || true
    else
      echo "RECOVERY_PRE_ATTEMPT_FAILURE=marker RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO (the canonical marker was not created)"
    fi
    return 1
  fi
  echo "RECOVERY_LIVE_EXECUTED=YES RECOVERY_ATTEMPT_CONSUMED=YES RECOVERY_RERUN_ALLOWED=NO"
  for stage in isolate d4 restore_status close final verify; do
    if ! "recovery_hook_$stage"; then recovery_attempt_failed "$stage"; return 1; fi
  done
  echo "RECOVERY_RESULT=PASS"
  echo "RECOVERY_R2_R8_EXECUTED=YES"
  echo "RECOVERY_PROMOTION=NOT_AUTOMATIC (the canonical live closed-pass closeout token is reserved for a separately reviewed LIVE closeout receipt; LVR, L8 and L9 stay unpromoted)"
  return 0
}
recovery_attempt_failed() {
  echo "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=$1 RECOVERY_LIVE_EXECUTED=YES RECOVERY_ATTEMPT_CONSUMED=YES RECOVERY_RERUN_ALLOWED=NO RECOVERY_R2_R8_EXECUTED=NO"
  recovery_hook_preserve_evidence "$1" || true
  echo "RECOVERY_EVIDENCE_PRESERVED=YES (no retry, no repair, no rollback, no reopen; human reconciliation required; R1I stays installed)"
}

recovery_no_live_claims() {
  cat <<'EOF'
RECOVERY_REPOSITORY_IMPLEMENTED=YES
RECOVERY_LIVE_EXECUTED=NO
RECOVERY_ATTEMPT_CONSUMED=NO
RECOVERY_R2_R8_EXECUTED=NO
R1B_RESULT=FAIL_IMMUTABLE
R1BV_RESULT=PASS
LVR_PROVEN=NO
L8_ACCEPTANCE=NO
L9_PROVEN=NO
EOF
}
