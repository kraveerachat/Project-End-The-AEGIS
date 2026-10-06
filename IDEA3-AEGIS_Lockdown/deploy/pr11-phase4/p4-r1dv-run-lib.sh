#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1Dv (R1D post-disposition validation) owner-run gate library. Sourced by the FROZEN owner runner; nothing here runs on its own and nothing here mutates the host. Every gate returns 0 on
# PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them.
#
# Owner decision (fixed): R1Dv is a NON-MUTATING successor VALIDATION stage. It is NOT an R1D retry or replay (R1DV_IS_R1D_RETRY=NO): the immutable R1D result stays FAIL while its committed disposition is retained.
# R1Dv validates the ALREADY COMMITTED R1D state read-only. This library contains no attempt marker, no consumption function and no path to the R1D socket or the R1D caller: it creates and modifies nothing.


: "${SUDO=sudo}"
_R1DV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1u-run-lib.sh
. "$_R1DV_LIB_DIR/p4-f1u-run-lib.sh"

# Every Git read that feeds an R1DV trust decision runs with replacement objects DISABLED. A real `git replace GOOD EVIL` keeps the apparent commit SHA while changing the bytes plain Git resolves, so the
# wrapper sets GIT_NO_REPLACE_OBJECTS=1 explicitly on EVERY invocation (a caller's environment cannot re-enable replacement). It is a shell function, so it also covers the shared run libraries sourced
# above, which call plain `git`.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }



R1DV_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1DV_R1A_FAILURE_CLOSEOUT_RECEIPT_REL="$R1DV_LOGS_REL/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1DV_R1I_CLOSEOUT_RECEIPT_REL="$R1DV_LOGS_REL/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1DV_F1U_CLOSEOUT_RECEIPT_REL="$R1DV_LOGS_REL/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1DV_R1I_TABLE="inet aegis_idea3_r1i"

r1dv_reason() { printf '%s\n' "$1" >&2; return 1; }

# Canonical governance directory (fixed by the stage contract; readonly; no environment override). R1Dv only READS it. Historical records it relies on (names only; never created, changed or removed here):
if ! readonly -p 2>/dev/null | grep -q 'R1DV_CANONICAL_DIR='; then
  R1DV_CANONICAL_DIR=/var/lib/aegis-idea3-governance
  readonly R1DV_CANONICAL_DIR
fi
R1D_MARKER_NAME="R1D-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1D attempt that MUST exist (read-only presence check)
R1B_MARKER_NAME="R1B-GLOBAL-ATTEMPT-CONSUMED"      # the successor markers that must NOT exist when R1Dv runs
R1B_WINDOW_NAME="R1B-ATTEMPT-WINDOW"
R1A_MARKER_NAME="R1A-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1A attempt that MUST exist
R1A_WINDOW_NAME="R1A-ATTEMPT-WINDOW"

r1dv_canonical_dir() {
  if [ "${R1DV_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${R1DV_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$R1DV_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$R1DV_CANONICAL_DIR"; fi
}

# r1dv_canonical_dir_valid — when the canonical directory exists it must be a real directory (never a symlink), owned by root (the current user when no sudo is in use, i.e. in tests) and not group/world
# writable. R1Dv never creates it: a missing directory is refused by the history gate.
r1dv_canonical_dir_valid() {
  local dir owner want
  dir=$(r1dv_canonical_dir)
  [[ "$dir" == /* ]] && [[ "$dir" != *..* ]] || { r1dv_reason "R1DV_CANONICAL_DIR_INVALID"; return 1; }
  [ -d "$(dirname "$dir")" ] && [ ! -L "$(dirname "$dir")" ] || { r1dv_reason "R1DV_CANONICAL_DIR_PARENT_INVALID"; return 1; }
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then
    $SUDO test -d "$dir" && ! $SUDO test -L "$dir" || { r1dv_reason "R1DV_CANONICAL_DIR_INVALID"; return 1; }
    owner=$($SUDO stat -c %u "$dir" 2>/dev/null); want=0; [ -n "$SUDO" ] || want=$(id -u)
    [ "$owner" = "$want" ] && [ -z "$($SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1dv_reason "R1DV_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED"; return 1; }
  fi
}
# r1dv_history_gate — the canonical governance history R1Dv depends on (read-only, root): the consumed R1A attempt (marker AND window record) EXISTS; the R1D marker EXISTS (R1D was attempted and consumed); the R1B successor
# has NOT begun (no marker, no window record). Anything missing, any symlink, or any R1B record fails closed. Nothing is created, changed or deleted.
r1dv_history_gate() {
  local canon name
  r1dv_canonical_dir_valid || return 1
  canon=$(r1dv_canonical_dir)
  $SUDO test -d "$canon" || { r1dv_reason "R1DV_CANONICAL_DIR_MISSING"; return 1; }
  for name in "$R1A_MARKER_NAME" "$R1A_WINDOW_NAME" "$R1D_MARKER_NAME"; do
    { $SUDO test -f "$canon/$name" && ! $SUDO test -L "$canon/$name"; } || { r1dv_reason "R1DV_HISTORY_RECORD_MISSING:$name"; return 1; }
  done
  for name in "$R1B_MARKER_NAME" "$R1B_WINDOW_NAME"; do
    if $SUDO test -e "$canon/$name" || $SUDO test -L "$canon/$name"; then r1dv_reason "R1DV_R1B_ALREADY_BEGUN:$name (R1Dv is only valid BEFORE R1B)"; return 1; fi
  done
}

# ---- predecessor receipt gates (pinned-commit content, never PR numbers) ------------------------------------------------
# r1dv_commit_gate REPO MAIN — the pinned commit is a real commit object (replacement disabled) and HEAD is exactly that commit. Every receipt/byte read below uses MAIN explicitly, never HEAD.
r1dv_commit_gate() {
  local repo=${1:-} main=${2:-}
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || { r1dv_reason "R1DV_PINNED_COMMIT_MALFORMED"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "$main^{commit}" 2>/dev/null)" = "$main" ] || { r1dv_reason "R1DV_PINNED_COMMIT_NOT_A_COMMIT_OBJECT"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$main" ] || { r1dv_reason "R1DV_HEAD_NOT_THE_PINNED_COMMIT"; return 1; }
}
# r1dv_field_files REPO MAIN FIELD VALUE — status-log receipts OF THE PINNED COMMIT holding FIELD=VALUE as a whole line (output lines are `MAIN:path`).
r1dv_field_files() {
  git -C "$1" grep -lE "^[[:space:]]*([-*][[:space:]]+)?\`?$3[[:space:]]*=[[:space:]]*$4\`?[[:space:]]*\$" "$2" -- "$R1DV_LOGS_REL" 2>/dev/null | sort
}
# _r1dv_only_receipt REPO MAIN CANONICAL_REL LABEL FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and it is the canonical receipt path.
_r1dv_only_receipt() {
  local repo=$1 main=$2 canonical=$3 label=$4 pair files="" part
  shift 4
  for pair in "$@"; do
    part=$(r1dv_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [ "${files#"$main":}" = "$canonical" ] || return 1
}
# _r1dv_unique_suffix_receipt REPO MAIN NAME_SUFFIX FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and its file name ends with NAME_SUFFIX (the closeout of a
# stage whose date-stamped name did not exist when this library was written).
_r1dv_unique_suffix_receipt() {
  local repo=$1 main=$2 suffix=$3 pair files="" part
  shift 3
  for pair in "$@"; do
    part=$(r1dv_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [[ "$files" == "$main:$R1DV_LOGS_REL/"*"$suffix" ]] || return 1
}
# r1dv_receipt_gate REPO RELEASE_ID MAIN — F1 detector deployed, the R1 evidence foundation merged, F1u (Core with ALERT_ACCEPTED) deployed, R1I LIVE closed — each from ONE canonical receipt of the pinned
# commit (read as MAIN:path with replacement objects disabled) — and no contradictory or duplicate success state, and R1DV not already recorded.

# r1dv_receipt_gate REPO RELEASE_ID MAIN — the pinned-commit history: F1 closeout, R1 foundation, F1u closeout (history), the unique R1Du LIVE closeout naming the pinned release, the R1I closeout, the immutable R1A failure
# closeout and the ONE unique immutable R1D FAILURE closeout (committed disposition, final-stage comparison failure, TrustedClock evidence unavailable because the verifier snapshot omitted trusted_time). No R1D PASS, no R1B
# or Recovery claim, no mutation/socket/disposition claim by R1Dv, and no R1Dv success recorded yet (the unique R1Dv closeout is created AFTER a successful live run).
r1dv_receipt_gate() {
  local repo=${1:-} release=${2:-} main=${3:-} claim
  [ -n "$repo" ] && [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { r1dv_reason "R1DV_RECEIPT_GATE_INPUT_INVALID"; return 1; }
  r1dv_commit_gate "$repo" "$main" || return 1
  _r1dv_only_receipt "$repo" "$main" "$F1U_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES || { r1dv_reason "R1DV_F1_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1dv_only_receipt "$repo" "$main" "$F1U_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED || { r1dv_reason "R1DV_R1_FOUNDATION_MISSING_OR_AMBIGUOUS"; return 1; }
  git -C "$repo" cat-file -e "$main:$R1DV_F1U_CLOSEOUT_RECEIPT_REL" 2>/dev/null || { r1dv_reason "R1DV_F1U_CLOSEOUT_MISSING"; return 1; }
  _r1dv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1du-live-closeout.md" R1DU_LIVE=CLOSED_PASS R1DU_LIVE_EXECUTED=YES R1DU_PRODUCTION_DEPLOYED=YES R1DU_ATTEMPT_CONSUMED=YES \
    R1DU_RERUN_ALLOWED=NO R1DU_RELEASE_ID="$release" R1DU_R1D_EXECUTED=NO R1DU_INCIDENT_MUTATED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1dv_reason "R1DV_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1dv_only_receipt "$repo" "$main" "$R1DV_R1I_CLOSEOUT_RECEIPT_REL" R1I_CLOSEOUT R1I_LIVE=CLOSED_PASS R1I_LIVE_EXECUTED=YES R1I_ATTEMPT_CONSUMED=YES R1I_RERUN_ALLOWED=NO || { r1dv_reason "R1DV_R1I_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1dv_only_receipt "$repo" "$main" "$R1DV_R1A_FAILURE_CLOSEOUT_RECEIPT_REL" R1A_FAILURE_CLOSEOUT R1A_LIVE_EXECUTED=YES R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO R1A_RESULT=FAIL R1A_STAGE_VERIFY=NOT_REACHED \
    F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO || { r1dv_reason "R1DV_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1dv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1d-live-failure-closeout.md" R1D_FAILURE_CLOSEOUT=YES R1D_LIVE=CLOSED_FAIL R1D_LIVE_EXECUTED=YES R1D_ATTEMPT_CONSUMED=YES R1D_RERUN_ALLOWED=NO \
    R1D_RESULT=FAIL R1D_FAILED_STAGE=final R1D_CORE_DISPOSITION_CALL=ONCE R1D_DISPOSITION_COMMITTED=YES R1D_DISPOSITION=DISPOSED R1D_RECOVERY_R8=NO R1D_FINAL=PASS R1D_VERIFY=NOT_REACHED \
    PRESERVATION_S10=FAIL COMPARE_RESULT=FAIL R1D_FAILURE_ROOT_CAUSE=R1D_VERIFIER_SNAPSHOT_MISSING_TRUSTED_TIME HISTORICAL_INCIDENT_STATE=CLOSED R1DV_REQUIRED=YES \
    F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO || { r1dv_reason "R1DV_R1D_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  for claim in R1D_RESULT=PASS R1D_LIVE=CLOSED_PASS R1B_LIVE_EXECUTED=YES R1B_LIVE=CLOSED_PASS R1B_ATTEMPT_CONSUMED=YES RECOVERY_R2_R8_EXECUTED=YES F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED \
      RECOVERY_R1_R8_PROVEN=YES R1DV_LIVE=CLOSED_PASS R1DV_LIVE_EXECUTED=YES R1DV_RESULT=PASS R1DV_INCIDENT_MUTATED=YES R1DV_R1D_SOCKET_CONNECTED=YES R1DV_DISPOSITION_CREATED=YES; do
    [ -z "$(r1dv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { r1dv_reason "R1DV_CONTRADICTORY_OR_ALREADY_RECORDED (a receipt carries ${claim})"; return 1; }
  done
}

# ---- host gates (read-only) ---------------------------------------------------------------------------------------------------------------------------
# r1dv_r1i_present_gate TOOL — the live R1I table is still present and is EXACTLY the owned shape (root read; the R1I validator accepts only the exact table).
r1dv_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { r1dv_reason "R1DV_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $R1DV_R1I_TABLE" || { r1dv_reason "R1DV_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $R1DV_R1I_TABLE 2>/dev/null) || { r1dv_reason "R1DV_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | python3 "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { r1dv_reason "R1DV_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
}
# r1dv_digest_gate FILE EXPECTED_SHA256 LABEL — a deployed/authority file matches its frozen digest.
r1dv_digest_gate() {
  local file=${1:-} want=${2:-} label=${3:-FILE} got
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ -f "$file" ] || { r1dv_reason "R1DV_${label}_DIGEST_INPUT_INVALID"; return 1; }
  got=$($SUDO sha256sum "$file" 2>/dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || { r1dv_reason "R1DV_${label}_DIGEST_MISMATCH"; return 1; }
}
# r1dv_current_release_gate CURRENT_LINK RELEASE_PATH — the `current` pointer is exactly the frozen release.
r1dv_current_release_gate() {
  local link=${1:-} want=${2:-}
  [ "$($SUDO readlink "$link" 2>/dev/null)" = "$want" ] || { r1dv_reason "R1DV_CURRENT_RELEASE_DRIFT"; return 1; }
}
# r1dv_journal_access_gate — the trusted journal (with the metadata the verifier needs) is readable: ONE bounded read-only journalctl.
r1dv_journal_access_gate() {
  $SUDO journalctl -o json --no-pager -n 1 --output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_TRANSPORT,_EXE,_UID >/dev/null 2>&1 || { r1dv_reason "R1DV_JOURNAL_UNREADABLE"; return 1; }
}

# ---- immutable verifier authority ------------------------------------------------------------------------------------------------------------------
# r1dv_verifier_gate SNAPSHOT MANIFEST_SHA256 REPO DETECTOR_SHA256 TOOL MAIN — the verifier source root executes is the frozen immutable snapshot: manifest digest, every file digest, exact file set, no symlink and
# nothing writable (the pinned tool); every snapshot file is byte-identical to the PINNED-main git object (so the whole dependency closure is the reviewed source); and the snapshot's production_detector.py
# (which the verifier imports to reconstruct the detector's rules) is exactly the deployed detector's frozen digest. Read-only.
r1dv_verifier_gate() {
  local snap=${1:-} want=${2:-} repo=${3:-} det=${4:-} tool=${5:-} main=${6:-} sha rel got
  [ -f "$tool" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { r1dv_reason "R1DV_VERIFIER_GATE_INPUT_INVALID"; return 1; }
  r1dv_commit_gate "$repo" "$main" || return 1
  python3 "$tool" check "$snap" "$want" >/dev/null 2>&1 || { r1dv_reason "R1DV_VERIFIER_SNAPSHOT_DRIFT_OR_NOT_ROOT_OWNED"; return 1; }
  while read -r sha rel; do
    [ "$rel" != "" ] || continue
    got=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { r1dv_reason "R1DV_VERIFIER_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel"; return 1; }
  done < "$snap/R1DV-VERIFIER-SHA256SUMS"
  [ -f "$snap/aegis_soc/historical_validation.py" ] && [ -f "$snap/aegis_soc/historical_disposition.py" ] && [ -f "$snap/aegis_soc/database.py" ] && [ -f "$snap/aegis_soc/trusted_time.py" ] && [ -f "$snap/aegis_soc/protocol_v1.py" ] || { r1dv_reason "R1DV_VERIFIER_CLOSURE_INCOMPLETE"; return 1; }
}
# r1dv_interpreter_gate PY — root runs this interpreter: it must resolve to a root-owned file that is not group/world writable.
r1dv_interpreter_gate() {
  local resolved
  resolved=$(readlink -f "${1:-}" 2>/dev/null) && [ -f "$resolved" ] || { r1dv_reason "R1DV_INTERPRETER_UNRESOLVABLE"; return 1; }
  [ "$(stat -c %U "$resolved")" = root ] && [ -z "$(find "$resolved" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1dv_reason "R1DV_INTERPRETER_NOT_ROOT_OWNED"; return 1; }
}
