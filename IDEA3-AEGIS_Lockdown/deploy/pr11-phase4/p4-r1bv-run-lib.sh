#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1Bv (successor read-only validation of the EXISTING failed R1B evidence) owner-run gate library. Sourced by the FROZEN owner runner; nothing here runs on its own and nothing here mutates
# the host. Every gate returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them.
#
# Owner decision (fixed): R1Bv is a NON-MUTATING successor VALIDATION stage. It is NOT an R1B retry or replay (R1BV_IS_R1B_RETRY=NO): R1B stays R1B_RESULT=FAIL_IMMUTABLE and is never rerun. R1Bv validates the
# EXISTING R1B evidence read-only. This library contains no attempt marker, no consumption function, no window-record writer and no path that creates an event: it creates and modifies nothing.


: "${SUDO=sudo}"
_R1BV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1u-run-lib.sh
. "$_R1BV_LIB_DIR/p4-f1u-run-lib.sh"

# Every Git read that feeds an R1BV trust decision runs with replacement objects DISABLED. A real `git replace GOOD EVIL` keeps the apparent commit SHA while changing the bytes plain Git resolves, so the
# wrapper sets GIT_NO_REPLACE_OBJECTS=1 explicitly on EVERY invocation (a caller's environment cannot re-enable replacement). It is a shell function, so it also covers the shared run libraries sourced
# above, which call plain `git`.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }



R1BV_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1BV_R1A_FAILURE_CLOSEOUT_RECEIPT_REL="$R1BV_LOGS_REL/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1BV_R1I_CLOSEOUT_RECEIPT_REL="$R1BV_LOGS_REL/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1BV_F1U_CLOSEOUT_RECEIPT_REL="$R1BV_LOGS_REL/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1BV_R1I_TABLE="inet aegis_idea3_r1i"

r1bv_reason() { printf '%s\n' "$1" >&2; return 1; }

# Canonical governance directory (fixed by the stage contract; readonly; no environment override). R1Bv only READS it. Historical records it relies on (names only; never created, changed or removed here):
if ! readonly -p 2>/dev/null | grep -q 'R1BV_CANONICAL_DIR='; then
  R1BV_CANONICAL_DIR=/var/lib/aegis-idea3-governance
  readonly R1BV_CANONICAL_DIR
fi
R1D_MARKER_NAME="R1D-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1D attempt that MUST exist (read-only presence check)
R1B_MARKER_NAME="R1B-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1B attempt that MUST exist (R1Bv validates its evidence; it is never rewritten or removed)
R1B_WINDOW_NAME="R1B-ATTEMPT-WINDOW"               # the R1B window record that MUST be ABSENT (never created or reconstructed by R1Bv)
R1A_MARKER_NAME="R1A-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1A attempt that MUST exist
R1A_WINDOW_NAME="R1A-ATTEMPT-WINDOW"

r1bv_canonical_dir() {
  if [ "${R1BV_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${R1BV_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$R1BV_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$R1BV_CANONICAL_DIR"; fi
}

# r1bv_canonical_dir_valid — when the canonical directory exists it must be a real directory (never a symlink), owned by root (the current user when no sudo is in use, i.e. in tests) and not group/world
# writable. R1Bv never creates it: a missing directory is refused by the history gate.
r1bv_canonical_dir_valid() {
  local dir owner want
  dir=$(r1bv_canonical_dir)
  [[ "$dir" == /* ]] && [[ "$dir" != *..* ]] || { r1bv_reason "R1BV_CANONICAL_DIR_INVALID"; return 1; }
  [ -d "$(dirname "$dir")" ] && [ ! -L "$(dirname "$dir")" ] || { r1bv_reason "R1BV_CANONICAL_DIR_PARENT_INVALID"; return 1; }
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then
    $SUDO test -d "$dir" && ! $SUDO test -L "$dir" || { r1bv_reason "R1BV_CANONICAL_DIR_INVALID"; return 1; }
    owner=$($SUDO stat -c %u "$dir" 2>/dev/null); want=0; [ -n "$SUDO" ] || want=$(id -u)
    [ "$owner" = "$want" ] && [ -z "$($SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1bv_reason "R1BV_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED"; return 1; }
  fi
}
# r1bv_history_gate — the canonical governance history R1Bv depends on (read-only, root): R1A marker AND window exist; the R1D marker exists; the R1B marker EXISTS as a regular file (the consumed attempt) and the
# R1B window record is ABSENT. Anything missing, any symlink, a present R1B window record: fail closed. Nothing is created, changed or deleted.
r1bv_history_gate() {
  local canon name
  r1bv_canonical_dir_valid || return 1
  canon=$(r1bv_canonical_dir)
  $SUDO test -d "$canon" || { r1bv_reason "R1BV_CANONICAL_DIR_MISSING"; return 1; }
  for name in "$R1A_MARKER_NAME" "$R1A_WINDOW_NAME" "$R1D_MARKER_NAME" "$R1B_MARKER_NAME"; do
    { $SUDO test -f "$canon/$name" && ! $SUDO test -L "$canon/$name"; } || { r1bv_reason "R1BV_HISTORY_RECORD_MISSING:$name"; return 1; }
  done
  if $SUDO test -e "$canon/$R1B_WINDOW_NAME" || $SUDO test -L "$canon/$R1B_WINDOW_NAME"; then r1bv_reason "R1BV_R1B_WINDOW_RECORD_PRESENT (history says ABSENT; R1Bv never creates or reconstructs it)"; return 1; fi
}
# r1bv_corroboration_gate R1B_AUTH_DIR R1B_EVIDENCE_DIR — the preserved R1B artifacts the observer needs EXIST (presence only; the observer validates content and trust): the authorization-local marker, the owner-run
# log and the root-private preserved baseline. An absent artifact is never invented.
r1bv_corroboration_gate() {
  local auth=${1:-} evid=${2:-}
  [[ "$auth" == /* ]] && [[ "$evid" == /* ]] && [[ "$auth$evid" != *..* ]] || { r1bv_reason "R1BV_CORROBORATION_INPUT_INVALID"; return 1; }
  [ -f "$auth/R1B-ATTEMPT-CONSUMED" ] && [ ! -L "$auth/R1B-ATTEMPT-CONSUMED" ] || { r1bv_reason "R1BV_LOCAL_MARKER_MISSING"; return 1; }
  [ -f "$evid/owner-run.log" ] && [ ! -L "$evid/owner-run.log" ] || { r1bv_reason "R1BV_RUNNER_LOG_MISSING"; return 1; }
  { $SUDO test -f "$evid/r1b-work/r1-baseline.json" && ! $SUDO test -L "$evid/r1b-work/r1-baseline.json"; } || { r1bv_reason "R1BV_PRESERVED_BASELINE_MISSING"; return 1; }
}
# r1bv_sudo_noninteractive_gate — R1Bv has NO long wait, but every privileged phase is preceded by this NON-INTERACTIVE check: a lapsed sudo credential fails here with an explicit reason, BEFORE the phase starts
# (R1B failed late because a password prompt could not complete). It never prompts and never weakens root authority. With no sudo in use (tests) it passes.
r1bv_sudo_noninteractive_gate() {
  [ -z "$SUDO" ] || ${SUDO%% *} -n true 2>/dev/null || { r1bv_reason "R1BV_SUDO_CREDENTIAL_NOT_ACTIVE (refusing to start a privileged phase that could stall on a password prompt)"; return 1; }
}

# ---- predecessor receipt gates (pinned-commit content, never PR numbers) ------------------------------------------------
# r1bv_commit_gate REPO MAIN — the pinned commit is a real commit object (replacement disabled) and HEAD is exactly that commit. Every receipt/byte read below uses MAIN explicitly, never HEAD.
r1bv_commit_gate() {
  local repo=${1:-} main=${2:-}
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || { r1bv_reason "R1BV_PINNED_COMMIT_MALFORMED"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "$main^{commit}" 2>/dev/null)" = "$main" ] || { r1bv_reason "R1BV_PINNED_COMMIT_NOT_A_COMMIT_OBJECT"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$main" ] || { r1bv_reason "R1BV_HEAD_NOT_THE_PINNED_COMMIT"; return 1; }
}
# r1bv_field_files REPO MAIN FIELD VALUE — status-log receipts OF THE PINNED COMMIT holding FIELD=VALUE as a whole line (output lines are `MAIN:path`).
r1bv_field_files() {
  git -C "$1" grep -lE "^[[:space:]]*([-*][[:space:]]+)?\`?$3[[:space:]]*=[[:space:]]*$4\`?[[:space:]]*\$" "$2" -- "$R1BV_LOGS_REL" 2>/dev/null | sort
}
# _r1bv_only_receipt REPO MAIN CANONICAL_REL LABEL FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and it is the canonical receipt path.
_r1bv_only_receipt() {
  local repo=$1 main=$2 canonical=$3 label=$4 pair files="" part
  shift 4
  for pair in "$@"; do
    part=$(r1bv_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [ "${files#"$main":}" = "$canonical" ] || return 1
}
# _r1bv_unique_suffix_receipt REPO MAIN NAME_SUFFIX FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and its file name ends with NAME_SUFFIX (the closeout of a
# stage whose date-stamped name did not exist when this library was written).
_r1bv_unique_suffix_receipt() {
  local repo=$1 main=$2 suffix=$3 pair files="" part
  shift 3
  for pair in "$@"; do
    part=$(r1bv_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [[ "$files" == "$main:$R1BV_LOGS_REL/"*"$suffix" ]] || return 1
}
# r1bv_receipt_gate REPO RELEASE_ID MAIN — the pinned-commit history R1Bv requires, each from ONE canonical receipt (read as MAIN:path with replacement objects disabled): F1 closeout, R1 foundation, F1u closeout,
# the unique R1Du LIVE closeout naming the pinned release, R1I, the immutable R1A failure, the unique immutable R1D failure closeout, the unique R1Dv LIVE PASS closeout and the ONE unique immutable R1B FAILURE
# closeout (windowrecord). The R1B result-file sets must resolve UNIQUELY to that closeout (an extra bare FAIL/FAIL_IMMUTABLE receipt is ambiguity). No R1B PASS, rerun, window-record or Recovery claim, no
# R1Bv mutation/retry/window/event claim, and NO R1Bv LIVE closeout yet (the unique R1Bv closeout is created AFTER a successful live run; a second live run is never prepared on top of one).
r1bv_receipt_gate() {
  local repo=${1:-} release=${2:-} main=${3:-} claim files
  [ -n "$repo" ] && [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { r1bv_reason "R1BV_RECEIPT_GATE_INPUT_INVALID"; return 1; }
  r1bv_commit_gate "$repo" "$main" || return 1
  _r1bv_only_receipt "$repo" "$main" "$F1U_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES || { r1bv_reason "R1BV_F1_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_only_receipt "$repo" "$main" "$F1U_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED || { r1bv_reason "R1BV_R1_FOUNDATION_MISSING_OR_AMBIGUOUS"; return 1; }
  git -C "$repo" cat-file -e "$main:$R1BV_F1U_CLOSEOUT_RECEIPT_REL" 2>/dev/null || { r1bv_reason "R1BV_F1U_CLOSEOUT_MISSING"; return 1; }
  _r1bv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1du-live-closeout.md" R1DU_LIVE=CLOSED_PASS R1DU_LIVE_EXECUTED=YES R1DU_PRODUCTION_DEPLOYED=YES R1DU_ATTEMPT_CONSUMED=YES \
    R1DU_RERUN_ALLOWED=NO R1DU_RELEASE_ID="$release" R1DU_R1D_EXECUTED=NO R1DU_INCIDENT_MUTATED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1bv_reason "R1BV_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_only_receipt "$repo" "$main" "$R1BV_R1I_CLOSEOUT_RECEIPT_REL" R1I_CLOSEOUT R1I_LIVE=CLOSED_PASS R1I_LIVE_EXECUTED=YES R1I_ATTEMPT_CONSUMED=YES R1I_RERUN_ALLOWED=NO || { r1bv_reason "R1BV_R1I_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_only_receipt "$repo" "$main" "$R1BV_R1A_FAILURE_CLOSEOUT_RECEIPT_REL" R1A_FAILURE_CLOSEOUT R1A_LIVE_EXECUTED=YES R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO R1A_RESULT=FAIL R1A_STAGE_VERIFY=NOT_REACHED \
    F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO || { r1bv_reason "R1BV_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1d-live-failure-closeout.md" R1D_FAILURE_CLOSEOUT=YES R1D_LIVE=CLOSED_FAIL R1D_RESULT=FAIL R1D_DISPOSITION_COMMITTED=YES R1D_RERUN_ALLOWED=NO \
    R1D_FAILURE_ROOT_CAUSE=R1D_VERIFIER_SNAPSHOT_MISSING_TRUSTED_TIME HISTORICAL_INCIDENT_STATE=CLOSED F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1bv_reason "R1BV_R1D_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1dv-live-closeout.md" R1DV_LIVE=CLOSED_PASS R1DV_LIVE_EXECUTED=YES R1DV_RESULT=PASS R1DV_IS_R1D_RETRY=NO R1DV_READ_ONLY_VALIDATION_ONLY=YES \
    R1DV_INCIDENT_MUTATED=NO R1DV_R1D_SOCKET_CONNECTED=NO R1DV_DISPOSITION_CREATED=NO PREEXISTING_OPEN_INCIDENT_COUNT=0 R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1bv_reason "R1BV_R1DV_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1bv_r1b_failure_closeout "$repo" "$main" || return 1
  for claim in R1D_RESULT=PASS R1D_LIVE=CLOSED_PASS R1B_RESULT=PASS R1B_RESULT=FAIL R1B_LIVE=CLOSED_PASS R1B_RERUN_ALLOWED=YES R1B_WINDOW_RECORD=PRESENT R1B_FINAL_VERIFIER_REACHED=YES R1B_FINAL_CAPTURE_REACHED=YES \
      RECOVERY_R2_R8_EXECUTED=YES F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED RECOVERY_R1_R8_PROVEN=YES R1BV_LIVE=CLOSED_PASS R1BV_LIVE=CLOSED_FAIL R1BV_LIVE_EXECUTED=YES R1BV_RESULT=PASS R1BV_RESULT=FAIL \
      R1BV_IS_R1B_RETRY=YES R1BV_READ_ONLY_VALIDATION_ONLY=NO R1BV_INCIDENT_MUTATED=YES R1BV_R1B_MARKER_MUTATED=YES R1BV_WINDOW_RECORD_CREATED=YES R1BV_WINDOW_RECORD_RECONSTRUCTED=YES \
      R1BV_NEW_EXTERNAL_EVENT_GENERATED=YES R1B_RESULT_REWRITTEN=YES; do
    [ -z "$(r1bv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { r1bv_reason "R1BV_CONTRADICTORY_OR_ALREADY_RECORDED (a receipt carries ${claim})"; return 1; }
  done
  # no R1Bv success of ANY kind is recorded yet (every positive live-result claim is refused, canonical name or not): a second live run is never prepared on top of one
  for claim in R1BV_LIVE=CLOSED_PASS R1BV_LIVE_EXECUTED=YES R1BV_RESULT=PASS R1BV_VERIFY=PASS R1BV_HISTORICAL_BOUND=PASS R1BV_REAL_DETECTOR_CHAIN=PASS R1BV_AUDIT_INTEGRITY=PASS R1BV_COMPARE_RESULT=PASS R1BV_PRESERVATION_S10=PASS; do
    [ -z "$(r1bv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { r1bv_reason "R1BV_ALREADY_RECORDED (a receipt carries ${claim})"; return 1; }
  done
}
# _r1bv_r1b_failure_closeout REPO MAIN — the ONE unique immutable R1B failure closeout (exact governance fields); the R1B result-file sets resolve uniquely to it (an extra bare receipt is ambiguity). The R1Bv LIVE closeout itself
# restates R1B_RESULT=FAIL_IMMUTABLE by contract, so ONLY that canonical-name file is excluded from the uniqueness count.
_r1bv_r1b_failure_closeout() {
  local repo=${1:-} main=${2:-} set
  _r1bv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1b-live-failure-closeout.md" R1B_FAILURE_CLOSEOUT=YES R1B_LIVE=CLOSED_FAIL R1B_LIVE_EXECUTED=YES R1B_ATTEMPT_CONSUMED=YES R1B_RERUN_ALLOWED=NO \
    R1B_RESULT=FAIL_IMMUTABLE R1B_FAILED_STAGE=windowrecord R1B_FAILURE_ROOT_CAUSE=POST_OBSERVATION_SUDO_AUTH_EXPIRY_DURING_WINDOW_RECORD R1B_GLOBAL_MARKER=PRESENT R1B_WINDOW_RECORD=ABSENT \
    R1B_FINAL_CAPTURE_REACHED=NO R1B_FINAL_VERIFIER_REACHED=NO R1BV_REQUIRED=YES R1BV_AUTHORIZED=YES R1BV_IS_R1B_RETRY=NO R1BV_READ_ONLY_VALIDATION_ONLY=YES R1I_MUST_REMAIN_INSTALLED=YES \
    RECOVERY_R2_R8_EXECUTED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED || { r1bv_reason "R1BV_R1B_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  for set in "R1B_RESULT FAIL_IMMUTABLE" "R1B_LIVE CLOSED_FAIL"; do
    [ "$(r1bv_field_files "$repo" "$main" ${set% *} ${set#* } | grep -v '_music_idea3-r1bv-live-closeout\.md$' | grep -c .)" = 1 ] || { r1bv_reason "R1BV_R1B_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS (an extra receipt carries ${set% *}=${set#* })"; return 1; }
  done
}
# r1bv_recovery_predecessor_gate REPO MAIN — the reusable fail-closed R1B/R1Bv predecessor check a Recovery R2-R8 stage must call. No Recovery stage exists in this repository yet, so nothing here is wired to one. It
# accepts EXACTLY: the unique truthful R1B immutable FAILURE closeout PLUS the unique R1Bv LIVE PASS closeout. Rejected: R1B failure alone, R1Bv implementation alone, an R1Bv FAIL, duplicate/ambiguous closeouts,
# contradictory PASS/FAIL histories, any R1Bv mutation / retry / window-record / new-event claim, any R1B PASS or rewrite claim. It is ONE predecessor, not the whole Recovery gate (the other prerequisites stay).
r1bv_recovery_predecessor_gate() {
  local repo=${1:-} main=${2:-} claim files
  [ -n "$repo" ] || { r1bv_reason "R1BV_RECOVERY_GATE_INPUT_INVALID"; return 1; }
  r1bv_commit_gate "$repo" "$main" || return 1
  _r1bv_r1b_failure_closeout "$repo" "$main" || return 1
  for claim in R1B_RESULT=PASS R1B_LIVE=CLOSED_PASS R1B_RERUN_ALLOWED=YES R1B_WINDOW_RECORD=PRESENT R1B_FINAL_VERIFIER_REACHED=YES R1B_RESULT_REWRITTEN=YES R1BV_RESULT=FAIL R1BV_LIVE=CLOSED_FAIL \
      R1BV_IS_R1B_RETRY=YES R1BV_READ_ONLY_VALIDATION_ONLY=NO R1BV_INCIDENT_MUTATED=YES R1BV_R1B_MARKER_MUTATED=YES R1BV_WINDOW_RECORD_CREATED=YES R1BV_WINDOW_RECORD_RECONSTRUCTED=YES \
      R1BV_NEW_EXTERNAL_EVENT_GENERATED=YES R1BV_EXISTING_R1B_EVIDENCE_ONLY=NO RECOVERY_R2_R8_EXECUTED=YES F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED RECOVERY_R1_R8_PROVEN=YES; do
    [ -z "$(r1bv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { r1bv_reason "R1BV_RECOVERY_FORBIDDEN_CLAIM (a receipt carries ${claim})"; return 1; }
  done
  # EVERY positive R1Bv live-result claim must resolve to the SAME single canonical closeout: an extra, misnamed or bare receipt carrying ANY of them is ambiguity (split fields across files included)
  files=$({ for claim in R1BV_LIVE=CLOSED_PASS R1BV_LIVE_EXECUTED=YES R1BV_RESULT=PASS R1BV_VERIFY=PASS R1BV_HISTORICAL_BOUND=PASS R1BV_REAL_DETECTOR_CHAIN=PASS R1BV_AUDIT_INTEGRITY=PASS R1BV_COMPARE_RESULT=PASS R1BV_PRESERVATION_S10=PASS; do
      r1bv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}"; done; } | sort -u)
  [ "$(printf '%s\n' "$files" | grep -c .)" = 1 ] || { r1bv_reason "R1BV_RECOVERY_R1BV_CLOSEOUT_MISSING_OR_AMBIGUOUS (every positive R1Bv claim must be in the ONE canonical R1Bv LIVE PASS closeout)"; return 1; }
  _r1bv_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1bv-live-closeout.md" R1BV_LIVE=CLOSED_PASS R1BV_LIVE_EXECUTED=YES R1BV_RESULT=PASS R1BV_VERIFY=PASS R1BV_IS_R1B_RETRY=NO \
    R1BV_READ_ONLY_VALIDATION_ONLY=YES R1BV_NEW_EXTERNAL_EVENT_GENERATED=NO R1BV_EXISTING_R1B_EVIDENCE_ONLY=YES R1BV_INCIDENT_MUTATED=NO R1BV_R1B_MARKER_MUTATED=NO R1BV_WINDOW_RECORD_CREATED=NO \
    R1BV_WINDOW_RECORD_RECONSTRUCTED=NO R1BV_CANONICAL_MARKER_TIME_AUTHORITY=PASS R1BV_HISTORICAL_BOUND=PASS R1BV_EXPECTED_SOURCE_BOUND=PASS R1BV_REAL_DETECTOR_CHAIN=PASS \
    R1BV_NEW_INCIDENT_CREATED_SEMANTICS=PASS R1BV_AUDIT_PROVENANCE=PASS R1BV_AUDIT_INTEGRITY=PASS R1BV_R1I_STATE=PASS R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES R1BV_PRESERVATION_S10=PASS R1BV_COMPARE_RESULT=PASS \
    R1B_RESULT=FAIL_IMMUTABLE R1B_RESULT_REWRITTEN=NO RECOVERY_R2_R8_EXECUTED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R1_R8_PROVEN=NO \
    || { r1bv_reason "R1BV_RECOVERY_R1BV_CLOSEOUT_MISSING_OR_AMBIGUOUS (R1Bv LIVE PASS closeout incomplete, failed or not unique)"; return 1; }
}

# ---- host gates (read-only) ---------------------------------------------------------------------------------------------------------------------------
# r1bv_r1i_present_gate TOOL — the live R1I table is still present and is EXACTLY the owned shape (root read; the R1I validator accepts only the exact table).
r1bv_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { r1bv_reason "R1BV_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $R1BV_R1I_TABLE" || { r1bv_reason "R1BV_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $R1BV_R1I_TABLE 2>/dev/null) || { r1bv_reason "R1BV_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | python3 "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { r1bv_reason "R1BV_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
}
# r1bv_digest_gate FILE EXPECTED_SHA256 LABEL — a deployed/authority file matches its frozen digest.
r1bv_digest_gate() {
  local file=${1:-} want=${2:-} label=${3:-FILE} got
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ -f "$file" ] || { r1bv_reason "R1BV_${label}_DIGEST_INPUT_INVALID"; return 1; }
  got=$($SUDO sha256sum "$file" 2>/dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || { r1bv_reason "R1BV_${label}_DIGEST_MISMATCH"; return 1; }
}
# r1bv_current_release_gate CURRENT_LINK RELEASE_PATH — the `current` pointer is exactly the frozen release.
r1bv_current_release_gate() {
  local link=${1:-} want=${2:-}
  [ "$($SUDO readlink "$link" 2>/dev/null)" = "$want" ] || { r1bv_reason "R1BV_CURRENT_RELEASE_DRIFT"; return 1; }
}
# r1bv_journal_access_gate — the trusted journal (with the metadata the verifier needs) is readable: ONE bounded read-only journalctl.
r1bv_journal_access_gate() {
  $SUDO journalctl -o json --no-pager -n 1 --output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_TRANSPORT,_EXE,_UID >/dev/null 2>&1 || { r1bv_reason "R1BV_JOURNAL_UNREADABLE"; return 1; }
}

# ---- immutable verifier authority ------------------------------------------------------------------------------------------------------------------
# r1bv_verifier_gate SNAPSHOT MANIFEST_SHA256 REPO DETECTOR_SHA256 TOOL MAIN — the verifier source root executes is the frozen immutable snapshot: manifest digest, every file digest, exact file set, no symlink and
# nothing writable (the pinned tool); every snapshot file is byte-identical to the PINNED-main git object (so the whole dependency closure is the reviewed source); and the snapshot's production_detector.py
# (which the verifier imports to reconstruct the detector's rules) is exactly the deployed detector's frozen digest. Read-only.
r1bv_verifier_gate() {
  local snap=${1:-} want=${2:-} repo=${3:-} det=${4:-} tool=${5:-} main=${6:-} sha rel got
  [ -f "$tool" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { r1bv_reason "R1BV_VERIFIER_GATE_INPUT_INVALID"; return 1; }
  r1bv_commit_gate "$repo" "$main" || return 1
  python3 "$tool" check "$snap" "$want" >/dev/null 2>&1 || { r1bv_reason "R1BV_VERIFIER_SNAPSHOT_DRIFT_OR_NOT_ROOT_OWNED"; return 1; }
  while read -r sha rel; do
    [ "$rel" != "" ] || continue
    got=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { r1bv_reason "R1BV_VERIFIER_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel"; return 1; }
  done < "$snap/R1BV-VERIFIER-SHA256SUMS"
  [ "$(sha256sum "$snap/aegis_soc/production_detector.py" 2>/dev/null | cut -d' ' -f1)" = "$det" ] || { r1bv_reason "R1BV_SNAPSHOT_DETECTOR_NOT_THE_PINNED_PRODUCTION_DETECTOR"; return 1; }
  [ -f "$snap/aegis_soc/r1bv_validation.py" ] && [ -f "$snap/aegis_soc/r1_acceptance.py" ] && [ -f "$snap/aegis_soc/production_detector.py" ] && [ -f "$snap/aegis_soc/recovery_evidence.py" ] && [ -f "$snap/aegis_soc/ip_containment.py" ] && [ -f "$snap/aegis_soc/trusted_time.py" ] || { r1bv_reason "R1BV_VERIFIER_CLOSURE_INCOMPLETE"; return 1; }
}
# r1bv_interpreter_gate PY — root runs this interpreter: it must resolve to a root-owned file that is not group/world writable.
r1bv_interpreter_gate() {
  local resolved
  resolved=$(readlink -f "${1:-}" 2>/dev/null) && [ -f "$resolved" ] || { r1bv_reason "R1BV_INTERPRETER_UNRESOLVABLE"; return 1; }
  [ "$(stat -c %U "$resolved")" = root ] && [ -z "$(find "$resolved" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1bv_reason "R1BV_INTERPRETER_NOT_ROOT_OWNED"; return 1; }
}
