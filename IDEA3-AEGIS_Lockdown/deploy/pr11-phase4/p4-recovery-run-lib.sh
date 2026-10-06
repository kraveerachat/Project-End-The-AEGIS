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
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }

RECOVERY_SAFE_PATH=/usr/sbin:/usr/bin:/sbin:/bin
RECOVERY_R1I_TABLE="inet aegis_idea3_r1i"
RECOVERY_D4_WAIT_SECONDS=120
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

recovery_sudo_noninteractive_gate() {
  [ -z "$SUDO" ] || $SUDO true 2>/dev/null || { recovery_reason RECOVERY_SUDO_CREDENTIAL_NOT_ACTIVE; return 1; }
}
# recovery_env_gate — nothing in the caller's environment may redirect an interpreter, a loader, a module path, a fixture root or a Recovery/RESTORE target.
recovery_env_gate() {
  local var
  for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PYTHONINSPECT PYTHONBREAKPOINT PYTHONEXECUTABLE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV \
      AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_RECOVERY_SOCKET AEGIS_RECOVERY_CORE_USER AEGIS_RCVSTAGE_APP_DIR AEGIS_RCVSTAGE_AUDIT_DB AEGIS_RCVSTAGE_PROTOCOL_DB AEGIS_RCVSTAGE_WORK_DIR \
      AEGIS_RCVSTAGE_STEP AEGIS_RCVSTAGE_LIVE_AUTHORIZED AEGIS_RCVSTAGE_SECRET RECOVERY_SECRET RECOVERY_RESTORE_CONFIRMATION RECOVERY_TEST_ONLY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED \
      RECOVERY_TEST_ONLY_TRUST_ROOT RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT GLOBAL_MARKER_DIR; do
    [ -z "${!var:-}" ] || { recovery_reason "RECOVERY_ENVIRONMENT_OVERRIDE_SET:$var"; return 1; }
  done
}
recovery_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { recovery_reason "RECOVERY_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $RECOVERY_R1I_TABLE" || { recovery_reason "RECOVERY_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $RECOVERY_R1I_TABLE 2>/dev/null) || { recovery_reason "RECOVERY_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | python3 "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { recovery_reason "RECOVERY_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
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
  python3 "$tool" check "$snap" "$want" >/dev/null 2>&1 || { recovery_reason "RECOVERY_VERIFIER_SNAPSHOT_DRIFT_OR_NOT_ROOT_OWNED"; return 1; }
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

# ---- operator / root program wrappers ----------------------------------------------------------------------------------------------------------------------------------
# The Core client steps run as the OPERATOR (the only uid the Core Recovery socket accepts) from the IMMUTABLE verifier snapshot only, with a clean environment and a fixed PATH. Root-side commands use the same
# snapshot under the privilege prefix. Neither ever runs a file from a worktree or /home.
recovery_operator_py() { env -i PATH="$RECOVERY_SAFE_PATH" PYTHONPATH="$VERIFIER_SNAPSHOT_DIR" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.recovery_stage "$@"; }
recovery_root_py() { $SUDO env -i PATH="$RECOVERY_SAFE_PATH" PYTHONPATH="$VERIFIER_SNAPSHOT_DIR" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.recovery_stage "$@"; }
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
  canon=$(recovery_canonical_dir)
  $SUDO test -d "$canon" || $SUDO mkdir -m 0700 "$canon" 2>/dev/null || { recovery_reason "RECOVERY_CANONICAL_DIR_NOT_CREATABLE"; return 1; }
  [ -n "${WORK:-}" ] && [ "$(dirname "$WORK")" = "$canon" ] && ! $SUDO test -e "$WORK" && $SUDO mkdir -m 0700 -- "$WORK" || { recovery_reason "RECOVERY_WORK_DIR_NOT_CREATABLE"; return 1; }
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
  recovery_handler BASELINE || return 1
  recovery_operator_py status --steps-dir "$STEPS" && recovery_operator_py probe-pre --steps-dir "$STEPS"
}
recovery_hook_regate() { recovery_require_hook recovery_authority_gates && recovery_authority_gates && recovery_attempt_unconsumed; }
# --- post-marker hooks: ANY failure here is a consumed immutable FAIL; none of them is ever retried -------------------------------------------------------------------------
recovery_hook_isolate() { recovery_operator_py isolate --steps-dir "$STEPS" && recovery_operator_py probe-post-isolate --steps-dir "$STEPS"; }
# recovery_d4_run — the owner's interactive NORMAL-path RESTORE: ONE invocation, from the pinned release, with the validated reason. The secret and the confirmation are typed into that program's own prompts on the
# terminal; this wrapper passes no secret and no confirmation, captures no stdin, and writes the program's output to the terminal descriptors only (never to the run log).
recovery_d4_run() {
  ( cd "$RELEASE_PATH" && exec env -i PATH="$RECOVERY_SAFE_PATH" HOME="${HOME:-/nonexistent}" TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}" AEGIS_RUNTIME_DIR="$RUNTIME_DIR" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 \
      "$RELEASE_PATH/venv/bin/python" -B -s -m aegis_soc.cli restore "--reason=$RECOVERY_REASON" --wait "$RECOVERY_D4_WAIT_SECONDS" ) >&"${RECOVERY_D4_OUT_FD:-1}" 2>&"${RECOVERY_D4_ERR_FD:-2}"
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
