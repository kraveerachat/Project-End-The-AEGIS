#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L8u (governed READ-ONLY L8 live ACCEPTANCE of the already-provisioned production ESP32), ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow (l8u_runner_freeze.py) derives ONE root-owned frozen runner from this exact
# template (the EXPECTED_MAIN Git object, replacement objects disabled) plus ONLY the approved pin substitutions and refuses to do so before LVR PASS is recorded in that main. Nothing in this repository
# executes it, creates an authorization or K3 record, or freezes a pin.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-l8u-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L8u.txt and k3-L8u.txt (FRESH same-day, stage=L8u, exact key sets, no extra field).
# Stage order: ... -> Recovery R2-R8 -> LVR -> L8u -> (L8 historical provisioning stage: SUPERSEDED, never run live after L8p) -> L9.
# L8u is a NEW governed successor, never a retry or replay of L8, L8p, Recovery or LVR. It is OBSERVATION ONLY: it never opens a serial device, runs esptool, resets, flashes, provisions or commands the ESP32,
# never publishes MQTT, never restarts a unit and never reruns L8p or NTP. ONE attempt TOTAL: a failed attempt is FAIL_IMMUTABLE (marker consumed, FAIL closeout written, no automatic retry, nothing to roll back).
# Claim boundary: L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY (authenticated Protocol-v1 STATUS observed after the attempt, the pinned runtime state, nothing actuated, historical L8p identity evidence matched).
# It does NOT claim the electrical relay, physical isolation, or L9.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin   # fixed: no program is ever selected through the caller's PATH
export LC_ALL=C
IFS=$' \t\n'   # fixed: the field separator is never inherited
[ "${SUDO+x}" != x ] || { echo "STOP: environment override SUDO is forbidden." >&2; exit 2; }

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
CONTROL_SNAPSHOT_DIR=PIN_CONTROL_SNAPSHOT_DIR
CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
CORE_UNIT_SHA256=PIN_CORE_UNIT_SHA256
DEVICE_ID=PIN_DEVICE_ID
DEVICE_MAC=PIN_DEVICE_MAC
FIRMWARE_SHA256=PIN_FIRMWARE_SHA256
L8P_EVIDENCE_FILE=PIN_L8P_EVIDENCE_FILE
L8P_EVIDENCE_SHA256=PIN_L8P_EVIDENCE_SHA256
LVR_CLOSEOUT_SHA256=PIN_LVR_CLOSEOUT_SHA256
EXPECTED_STATE=PIN_EXPECTED_STATE
OBSERVE_SECONDS=PIN_OBSERVE_SECONDS
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 CORE_UNIT_SHA256 DEVICE_ID DEVICE_MAC FIRMWARE_SHA256 L8P_EVIDENCE_FILE L8P_EVIDENCE_SHA256 LVR_CLOSEOUT_SHA256 EXPECTED_STATE OBSERVE_SECONDS; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA." >&2; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier." >&2; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid." >&2; exit 2; }
for pin in CONTROL_MANIFEST_SHA256 CORE_UNIT_SHA256 FIRMWARE_SHA256 L8P_EVIDENCE_SHA256 LVR_CLOSEOUT_SHA256; do
  [[ "${!pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: $pin is not a 64-hex SHA-256." >&2; exit 2; }
done
[[ "$DEVICE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "STOP: DEVICE_ID is not a valid device id." >&2; exit 2; }
[[ "$DEVICE_MAC" =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || { echo "STOP: DEVICE_MAC is not a lowercase colon-separated MAC." >&2; exit 2; }
[ "$EXPECTED_STATE" = LOCKDOWN ] || [ "$EXPECTED_STATE" = NORMAL ] || { echo "STOP: EXPECTED_STATE must be LOCKDOWN or NORMAL." >&2; exit 2; }
[[ "$OBSERVE_SECONDS" =~ ^[1-9][0-9]{1,3}$ ]] && [ "$OBSERVE_SECONDS" -ge 10 ] && [ "$OBSERVE_SECONDS" -le 3600 ] || { echo "STOP: OBSERVE_SECONDS must be 10..3600." >&2; exit 2; }
for pin in CONTROL_SNAPSHOT_DIR L8P_EVIDENCE_FILE; do
  [[ "${!pin}" == /* ]] && [[ "${!pin}" != *..* ]] || { echo "STOP: $pin must be an absolute path." >&2; exit 2; }
done
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root." >&2; exit 2; }
# No environment may redirect a live run: interpreter/loader/module overrides, shell startup files, Git redirection, fixture roots, handler overrides, device-backend switches and every test seam must be unset.
for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PYTHONSAFEPATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR \
    AEGIS_L8U_WORK_DIR AEGIS_L8U_LIVE_AUTHORIZED AEGIS_L8U_CONTROL AEGIS_L8_BACKEND AEGIS_L8_LIVE_AUTHORIZED AEGIS_L8_ESPTOOL AEGIS_L8P_LIVE_AUTHORIZED L8U_TEST_ONLY_CANONICAL_DIR_ENABLED L8U_TEST_ONLY_CANONICAL_DIR \
    L8U_TEST_ONLY_TRUST_ROOT L8U_TEST_ONLY_BOUNDARY L8U_TEST_ONLY_RUNNER_TRUST_ENABLED L8U_TEST_ONLY_RUNNER_TRUST_ROOT L8U_TEST_ONLY_SNAPSHOT_TRUST_ENABLED L8U_TEST_ONLY_SNAPSHOT_TRUST_ROOT SUDO_ASKPASS SUDO_EDITOR; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set; refusing a live run." >&2; exit 2; }
done
[ -z "$(env | sed -n 's/^GIT_[^=]*=.*/x/p')" ] || { echo "STOP: a GIT_* environment override is set; refusing a live run." >&2; exit 2; }
[ -z "$(env | sed -n 's/^\(SHELLOPTS\|BASHOPTS\)=.*/x/p')" ] || { echo "STOP: environment override SHELLOPTS/BASHOPTS is set; refusing a live run." >&2; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] && [ "$(readlink -f -- "$AUTH_DIR")" = "$AUTH_DIR" ] && [ "$(stat -c %u -- "$AUTH_DIR")" = "$OPERATOR_UID" ] && [ -z "$(find "$AUTH_DIR" -maxdepth 0 -perm /022)" ] \
  || { echo "usage: bash $0 <canonical, operator-owned, non-group/world-writable AUTH_DIR with authorization-L8u.txt and k3-L8u.txt>" >&2; exit 2; }

# Snapshot ownership invariant (LITERAL constants of the frozen runner, not environment): the control snapshot and EVERY ancestor up to the trusted parent are owned by this uid and not group/world writable.
# The committed template pins 0 (root) and `/`; a test copy may substitute its own values, a live freeze must not.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH   # replaced by the freeze workflow: a worktree at EXPECTED_MAIN used ONLY to read pinned git objects (receipts, byte-equality); NO shell or Python is sourced or executed from it
case "$REPO" in */PIN_*) echo "STOP: runner is not pinned (REPO). Run the owner freeze workflow first." >&2; exit 2 ;; esac
PY=PIN_PYTHON_BIN
case "$PY" in PIN_*) echo "STOP: runner is not pinned (PY). Run the owner freeze workflow first." >&2; exit 2 ;; esac
EVID_ROOT=/PIN_EVIDENCE_ROOT
case "$EVID_ROOT" in /PIN_*) echo "STOP: runner is not pinned (EVID_ROOT). Run the owner freeze workflow first." >&2; exit 2 ;; esac
[ "$(readlink -f -- "$REPO")" = "$REPO" ] && [ -d "$REPO/.git" ] || { echo "STOP: REPO is not a canonical repository path." >&2; exit 2; }
# The LIVE control plane is the frozen IMMUTABLE control snapshot (the manifested copy of deploy/pr11-phase4 at EXPECTED_MAIN): every sourced library and every script root executes comes from CTRL.
CTRL=$CONTROL_SNAPSHOT_DIR
STG=$CTRL/stages/L8u
LIB=$CTRL/p4-l8u-run-lib.sh
GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
CORE_UNIT=aegis-idea3-core.service
DETECTOR_UNIT=aegis-idea3-detector.service
BROKER_UNIT=aegis-idea3-mosquitto.service
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F); STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
# Git authority reads run with replacement objects DISABLED on every invocation. A shell function, so it also covers the git calls inside every library sourced later.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }
# control_gate — the frozen runner re-proves the control snapshot ITSELF (inline, never via sourced code): canonical path, root-owned entries and trusted ancestors to the trust root, manifest digest, every file's digest,
# exact file set, no symlink, nothing writable. Run BEFORE the first source and again immediately before EVERY root execution (capture, compare, stage handlers, stage gate).
control_gate() {
  local m="$CTRL/L8U-CONTROL-SHA256SUMS" d
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
  ( cd "$CTRL" && sha256sum -c --quiet --strict L8U-CONTROL-SHA256SUMS ) >/dev/null 2>&1 || { echo "GATE_FAIL: CONTROL_FILE_DRIFT" >&2; return 1; }
  [ -z "$(find "$CTRL" -type l -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SYMLINK_PRESENT" >&2; return 1; }
  [ -z "$(find "$CTRL" -perm /222 -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SOURCE_WRITABLE" >&2; return 1; }
  [ "$(find "$CTRL" -type f ! -name L8U-CONTROL-SHA256SUMS -printf '%P\n' | LC_ALL=C sort)" = "$(cut -c67- "$m" | LC_ALL=C sort)" ] || { echo "GATE_FAIL: CONTROL_FILE_SET_DRIFT" >&2; return 1; }
}
# control_git_gate — every control snapshot file is byte-identical to its pinned-main git object (the snapshot is exactly the reviewed source).
control_git_gate() {
  local sha rel got
  # the pinned commit must be a REAL commit object (replacement objects disabled by the git wrapper above) and HEAD must be exactly it; the reviewed bytes are read as EXPECTED_MAIN:path, never HEAD:path
  [ "$(git -C "$REPO" rev-parse --verify "$EXPECTED_MAIN^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_PINNED_COMMIT_NOT_A_COMMIT_OBJECT" >&2; return 1; }
  [ "$(git -C "$REPO" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_REPO_HEAD_NOT_PINNED_MAIN" >&2; return 1; }
  while read -r sha rel; do
    got=$(git -C "$REPO" show "$EXPECTED_MAIN:$GIT_P4_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { echo "GATE_FAIL: CONTROL_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel" >&2; return 1; }
  done < "$CTRL/L8U-CONTROL-SHA256SUMS"
}
# The library is sourced ONLY after A (control_gate) AND B (control_git_gate) pass.
control_gate || die "the control snapshot is not the frozen immutable authority; nothing was sourced, created or touched"
control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was sourced, created or touched"
# shellcheck disable=SC1090
source "$LIB"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
l8u_env_gate || die "the environment redirects an interpreter, loader, module path, fixture root or device backend; nothing was created or touched"
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen L8u operator; nothing was created or touched"
sudo -v || die "sudo authentication failed"   # the ONLY interactive sudo establishment; every privileged command below uses `sudo -n`
SUDO='sudo -n'
l8u_start_sudo_keepalive || die "the bounded sudo keepalive could not start; nothing was created"
trap l8u_stop_sudo_keepalive EXIT   # nothing outlives this owner-run process, not even on a refusal before the attempt (replaced by on_exit once the evidence directory exists)

# ===== evidence, terminal result, failure model ====================================================================================================================
EVID=$EVID_ROOT/$TODAY-l8u-$STAMP
WORK=$EVID/l8u-work
TERMINAL=0; L8U_MARKER_CREATED=0
# terminal_fail REASON — the ONE failure exit. L8u mutates nothing, so there is nothing to roll back: the marker stays consumed (no retry), a FAIL closeout makes a contradictory PASS impossible, the terminal
# result is written durable BEFORE anything else is printed (a dead terminal cannot lose it), and the evidence directory is scanned for secrets. Idempotent; signals cannot re-enter it.
terminal_fail() {
  local reason=$1 consumed=NO result
  trap - ERR INT TERM HUP
  [ "$TERMINAL" = 0 ] || exit 1
  TERMINAL=1
  if l8u_present "$(l8u_path "$L8U_MARKER_NAME")" 2>/dev/null; then
    consumed=YES
    l8u_write_closeout "$L8U_CLOSEOUT_FAIL_NAME" "$(l8u_fail_content "$EXPECTED_MAIN" "$reason" "$EVID")" 2>/dev/null || true
  fi
  if [ "$consumed" = YES ]; then result=FAIL_IMMUTABLE; else result=REFUSED_BEFORE_ATTEMPT; fi
  if [ -d "$EVID" ]; then
    printf 'L8U_RESULT=%s\nL8U_ATTEMPT_CONSUMED=%s\nL8U_RERUN_ALLOWED=%s\nL8U_FAILURE_REASON=%s\nL8U_ROLLBACK=NOT_REQUIRED\nESP32_TOUCHED=NO\n' "$result" "$consumed" "$([ "$consumed" = YES ] && echo NO || echo ONLY_WITH_A_FRESH_AUTHORIZATION)" "$reason" > "$EVID/terminal-result" 2>/dev/null || true
    sudo -n sync -- "$EVID/terminal-result" "$EVID" 2>/dev/null || true
    l7u_secret_scan "$EVID" /usr/bin/python3 >/dev/null 2>&1 || printf 'L8U_EVIDENCE_SECRET_SCAN=HITS_OR_FAILED\n' >> "$EVID/terminal-result" 2>/dev/null || true
  fi
  l8u_stop_sudo_keepalive
  echo "L8U_RESULT=$result L8U_ATTEMPT_CONSUMED=$consumed reason=$reason" >&2 || true
  exit 1
}
on_signal() { terminal_fail "SIGNAL_$1"; }
on_exit() { local rc=$?; [ "$TERMINAL" = 1 ] || [ "$rc" = 0 ] || terminal_fail "EXIT_$rc"; l8u_stop_sudo_keepalive; }
# l8u_root SCRIPT — a stage handler from the control snapshot, re-proved immediately before EVERY root execution; nothing derived from the operator's environment except the frozen pins.
l8u_handler() {
  control_gate || return 1
  $SUDO env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_L8U_LIVE_AUTHORIZED=YES AEGIS_L8U_WORK_DIR="$WORK" AEGIS_L8U_CONTROL="$CTRL" AEGIS_L8U_DEVICE_ID="$DEVICE_ID" AEGIS_L8U_DEVICE_MAC="$DEVICE_MAC" \
    AEGIS_L8U_FIRMWARE_SHA256="$FIRMWARE_SHA256" AEGIS_L8U_L8P_EVIDENCE_FILE="$L8P_EVIDENCE_FILE" AEGIS_L8U_L8P_EVIDENCE_SHA256="$L8P_EVIDENCE_SHA256" AEGIS_L8U_EXPECTED_STATE="$EXPECTED_STATE" \
    AEGIS_L8U_OBSERVE_SECONDS="$OBSERVE_SECONDS" AEGIS_L8U_CORE_PID="${CORE_PRE_PID:-0}" AEGIS_L8U_CORE_PRE_PID="${CORE_PRE_PID:-0}" AEGIS_L8U_CORE_UNIT_SHA256="$CORE_UNIT_SHA256" PYTHONDONTWRITEBYTECODE=1 bash "$STG/$1"
}
capture() { control_gate || return 1; $SUDO env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$CTRL/p4-l0-capture.sh"; }
compare() { # PRE_ROOT OTHER_ROOT OUT — zero Core-host drift (the stage allow files are empty)
  control_gate || return 1
  $SUDO env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" bash "$CTRL/p4-compare.sh" "$1" "$2" > "$3"
  grep -qx 'PRESERVATION_S10=PASS' "$3" && grep -qx 'COMPARE_RESULT=PASS' "$3"
}
snap() { printf '%s/%s\n' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

# ===== PRE-AUTH / PRE-ATTEMPT gates (all read-only; NONE consumes the attempt) ==========================================================================
l8u_pregates() {
  local gate_out
  # 1. exact main + clean pinned worktree + origin; every predecessor from the Git objects of the pinned main (LVR PASS, strict-ancestor LVR execution main, historical L8p closeout)
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
  [ -z "$(git -C "$REPO" status --porcelain --ignored)" ] || gate "worktree is not clean (ignored files included)"
  git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
  l8u_predecessor_gate "$REPO" "$EXPECTED_MAIN" "$LVR_CLOSEOUT_SHA256" || gate "predecessor gate failed: LVR PASS closeout / historical L8p (see reason above)"
  # 2. fresh same-day stage=L8u records, exact key sets, bound to this main + this exact runner + the pinned device/firmware/LVR closeout
  l8u_records_gate "$AUTH_DIR" "$TODAY" "$EXPECTED_MAIN" "$RUNNER_SHA256" "$DEVICE_MAC" "$FIRMWARE_SHA256" "$LVR_CLOSEOUT_SHA256" || gate "Authorization/K3 records invalid (see reason above)"
  for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
  control_gate || gate "control snapshot drift before the stage gate"
  # 3. the REAL stage gate from the immutable control snapshot
  gate_out=$(TZ=Asia/Bangkok bash "$CTRL/p4-stage-gate.sh" --stage L8u --mode live --authorization "$AUTH_DIR/authorization-L8u.txt" --k3 "$AUTH_DIR/k3-L8u.txt" 2>&1) || gate "stage gate failed"
  for f in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$f" || gate "stage gate did not report $f"; done
  # 4. one attempt TOTAL; Recovery governance ran; sudo authority
  l8u_marker_unconsumed || gate "L8u is ONE attempt TOTAL and one is already consumed (or the canonical governance directory is invalid)"
  l8u_recovery_marker_gate || gate "the Recovery attempt marker is missing (L8u follows the governed Recovery)"
  l8u_sudo_authority_gate || gate "the sudo keepalive is not healthy"
  # 5. host: headroom, preserved services, broker, IDEA2 S10, Core + detector healthy, the pinned CTu unit, runtime already ready, historical L8p evidence matches the pinned device/firmware
  l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
  l8u_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
  l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent broker gate failed (see reason above)"
  l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
  l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not healthy (see reason above)"
  f1u_detector_running_gate || gate "the detector is not healthy (see reason above)"
  l8u_core_unit_gate "$CORE_UNIT_SHA256" || gate "the installed Core unit is not the pinned unit (see reason above)"
  CORE_PRE_PID=$(systemctl show -p MainPID --value "$CORE_UNIT")
  l8u_runtime_preflight "$CORE_PRE_PID" "$EXPECTED_STATE" || gate "the Core runtime is not already in the pinned state (see reason above)"
  l8u_historical_evidence_gate "$DEVICE_MAC" "$FIRMWARE_SHA256" "$L8P_EVIDENCE_FILE" "$L8P_EVIDENCE_SHA256" || gate "the historical L8p evidence does not match the pinned device/firmware (see reason above)"
  [ "$GATE_FAILED" = 0 ]
}

l8u_run_attempt() {
  l8u_pregates || { echo "L8U_RESULT=REFUSED_BEFORE_ATTEMPT L8U_ATTEMPT_CONSUMED=NO (nothing was created, consumed or touched)" >&2; exit 1; }
  mkdir -m 700 -- "$EVID" || die "evidence directory could not be created"
  exec > >(tee -a "$EVID/owner-run.log") 2>&1
  trap 'on_exit' EXIT; trap 'on_signal INT' INT; trap 'on_signal TERM' TERM; trap 'on_signal HUP' HUP
  JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
  cp "$AUTH_DIR/authorization-L8u.txt" "$AUTH_DIR/k3-L8u.txt" "$EVID/"
  { echo "MAIN=$EXPECTED_MAIN"; echo "RUNNER_SHA256=$RUNNER_SHA256"; echo "CONTROL_MANIFEST_SHA256=$CONTROL_MANIFEST_SHA256"; echo "DEVICE_ID=$DEVICE_ID"; echo "DEVICE_MAC=$DEVICE_MAC"
    echo "FIRMWARE_SHA256=$FIRMWARE_SHA256"; echo "LVR_CLOSEOUT_SHA256=$LVR_CLOSEOUT_SHA256"; echo "EXPECTED_STATE=$EXPECTED_STATE"; echo "CORE_PRE=$(snap "$CORE_UNIT")"; echo "DETECTOR_PRE=$(snap "$DETECTOR_UNIT")"
    echo "L8P_EXECUTED=NO"; echo "ESP32_TOUCHED=NO"; echo "NTP_RERUN=NO"; } > "$EVID/frozen-inputs.txt"
  capture "$EVID/pre-root" l8u-pre || terminal_fail PRE_CAPTURE
  # the read-only gates are re-proved IMMEDIATELY before the attempt is consumed (state may have drifted during the PRE capture)
  l8u_marker_unconsumed && l8u_core_unit_gate "$CORE_UNIT_SHA256" && l7u_core_running_gate "$CORE_UNIT" && f1u_detector_running_gate || terminal_fail PRE_CONSUME_REGATE
  [ "$(systemctl show -p MainPID --value "$CORE_UNIT")" = "$CORE_PRE_PID" ] || terminal_fail CORE_CHANGED_BEFORE_CONSUME
  l8u_runtime_preflight "$CORE_PRE_PID" "$EXPECTED_STATE" || terminal_fail PRE_CONSUME_RUNTIME_REGATE
  mkdir -m 700 -- "$WORK" || terminal_fail WORK_DIR
  # ---- ATTEMPT CONSUMED from here: no retry; failures are FAIL_IMMUTABLE; nothing to roll back ----
  if ! l8u_consume_attempt "$WORK" "$DEVICE_ID"; then
    [ "$L8U_MARKER_CREATED" = 1 ] && terminal_fail MARKER_DURABILITY
    echo "L8U_RESULT=FAIL_IMMUTABLE L8U_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING" >&2
    exit 1
  fi
  l8u_handler apply.sh || terminal_fail APPLY
  capture "$EVID/post-root" l8u-post || terminal_fail POST_CAPTURE
  compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" || terminal_fail COMPARE_S10
  l7u_secret_scan "$EVID" /usr/bin/python3 || terminal_fail SECRET_SCAN
  l8u_handler verify.sh || terminal_fail VERIFY
  # ---- terminal PASS: durable terminal-result and the closeout are written, atomically, BEFORE the success line ----
  printf 'L8U_RESULT=PASS\nL8U_ATTEMPT_CONSUMED=YES\nL8U_RERUN_ALLOWED=NO\nL8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY\nL8P_EXECUTED=NO\nESP32_TOUCHED=NO\n' > "$EVID/terminal-result" || terminal_fail TERMINAL_RESULT
  sudo -n sync -- "$EVID/terminal-result" "$EVID" || terminal_fail TERMINAL_RESULT
  l8u_write_closeout "$L8U_CLOSEOUT_PASS_NAME" "$(l8u_pass_content "$EXPECTED_MAIN" "$RUNNER_SHA256" "$EVID")" || terminal_fail CLOSEOUT
  TERMINAL=1
  l8u_stop_sudo_keepalive
  echo "L8U_LIVE=PASS L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY L8P_EXECUTED=NO ESP32_TOUCHED=NO ELECTRICAL_RELAY_PROOF=NO L9_PROVEN=NO"
}

l8u_run_attempt
echo "L8U_AUTOMATIC_RESULT_ONLY=YES"
echo "L8U_CLAIM_BOUNDARY: logical acceptance only. The canonical live closeout receipt, L9 and any physical/electrical claim are promoted ONLY by separately reviewed LIVE closeouts after independent inspection of the evidence."
exit 0
