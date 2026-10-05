#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1A (real detector acceptance) owner-run gate library + attempt state machine. Sourced by the FROZEN owner runner; nothing here runs on its own and
# nothing here mutates the host. Every gate returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them.
#
# Owner-approved R1A model (fixed): MUTATING governed stage, ONE attempt, NO retry, GENUINE EXTERNAL EVENT only. This library never generates an event, never writes to the Core, never
# touches nftables, the audit DB, the journal or a unit, and never deletes or edits genuine evidence. A failed attempt stops with the evidence preserved.

: "${SUDO=sudo}"
_R1A_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1u-run-lib.sh
. "$_R1A_LIB_DIR/p4-f1u-run-lib.sh"

R1A_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1A_R1I_CLOSEOUT_RECEIPT_REL="$R1A_LOGS_REL/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1A_F1U_CLOSEOUT_RECEIPT_REL="$R1A_LOGS_REL/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1A_R1I_TABLE="inet aegis_idea3_r1i"

r1a_reason() { printf '%s\n' "$1" >&2; return 1; }

# ---- one-attempt marker ------------------------------------------------------------------------------------------------------------------------------
# r1a_attempt_unconsumed AUTH_DIR — read-only pre-gate.
r1a_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1a_reason "R1A_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/R1A-ATTEMPT-CONSUMED" ] || { r1a_reason "R1A_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; there is NO retry)"; return 1; }
}
# r1a_consume_attempt AUTH_DIR — exclusive create (noclobber). The marker is never removed by any code path.
r1a_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1a_reason "R1A_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/R1A-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then return 0; fi
  r1a_reason "R1A_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; there is NO retry)"
}

# ---- predecessor receipt gates (pinned-commit content, never PR numbers) ------------------------------------------------------------------------------
# r1a_receipt_gate REPO RELEASE_ID — F1 detector deployed, the R1 evidence foundation merged, F1u (Core with ALERT_ACCEPTED) deployed, R1I LIVE closed — each from ONE canonical receipt of the pinned
# commit — and no contradictory or duplicate success state, and R1A not already recorded.
r1a_receipt_gate() {
  local repo=${1:-} release=${2:-} claim files
  [ -n "$repo" ] && [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { r1a_reason "R1A_RECEIPT_GATE_INPUT_INVALID"; return 1; }
  _f1u_only_receipt "$repo" "$F1U_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES \
    || { r1a_reason "R1A_F1_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _f1u_only_receipt "$repo" "$F1U_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED \
    || { r1a_reason "R1A_R1_FOUNDATION_MISSING_OR_AMBIGUOUS"; return 1; }
  # F1u closeout: ONE canonical receipt, naming the pinned current release as installed and activated, deployment-only boundary.
  git -C "$repo" cat-file -e "HEAD:$R1A_F1U_CLOSEOUT_RECEIPT_REL" 2>/dev/null || { r1a_reason "R1A_F1U_CLOSEOUT_MISSING"; return 1; }
  git -C "$repo" grep -qF "$release" HEAD -- "$R1A_F1U_CLOSEOUT_RECEIPT_REL" && git -C "$repo" grep -q "installed and activated" HEAD -- "$R1A_F1U_CLOSEOUT_RECEIPT_REL" \
    && git -C "$repo" grep -q "F1u proves deployment only" HEAD -- "$R1A_F1U_CLOSEOUT_RECEIPT_REL" || { r1a_reason "R1A_F1U_CLOSEOUT_DOES_NOT_CARRY_THE_PINNED_RELEASE"; return 1; }
  # R1I LIVE closeout: ONE canonical receipt carrying the full success state, and still the unproven claim boundary.
  _f1u_only_receipt "$repo" "$R1A_R1I_CLOSEOUT_RECEIPT_REL" R1I_CLOSEOUT R1I_LIVE=CLOSED_PASS R1I_LIVE_EXECUTED=YES R1I_PRODUCTION_DEPLOYED=YES R1I_ATTEMPT_CONSUMED=YES \
    R1I_RERUN_ALLOWED=NO PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED \
    || { r1a_reason "R1A_R1I_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  # no second success claim for R1I anywhere, and no contradictory live claim
  files=$(l8p_result_field_files "$repo" R1I_LIVE CLOSED_PASS)
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] || { r1a_reason "R1A_R1I_SUCCESS_NOT_UNIQUE"; return 1; }
  for claim in R1I_LIVE=FAIL R1I_RERUN_ALLOWED=YES F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED R1_VERIFIED=YES RECOVERY_R1_R8_PROVEN=YES \
      R1A_LIVE_EXECUTED=YES R1A_LIVE=CLOSED_PASS R1A_LIVE=FAIL R1A_ATTEMPT_CONSUMED=YES; do
    [ -z "$(l8p_result_field_files "$repo" "${claim%%=*}" "${claim#*=}")" ] || { r1a_reason "R1A_CONTRADICTORY_OR_ALREADY_RECORDED (a receipt carries ${claim})"; return 1; }
  done
}

# ---- host gates (read-only) ---------------------------------------------------------------------------------------------------------------------------
# r1a_r1i_present_gate TOOL — the live R1I table is still present and is EXACTLY the owned shape (root read; the R1I validator accepts only the exact table).
r1a_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { r1a_reason "R1A_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $R1A_R1I_TABLE" || { r1a_reason "R1A_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $R1A_R1I_TABLE 2>/dev/null) || { r1a_reason "R1A_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | python3 "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { r1a_reason "R1A_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
}
# r1a_digest_gate FILE EXPECTED_SHA256 LABEL — a deployed/authority file matches its frozen digest.
r1a_digest_gate() {
  local file=${1:-} want=${2:-} label=${3:-FILE} got
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ -f "$file" ] || { r1a_reason "R1A_${label}_DIGEST_INPUT_INVALID"; return 1; }
  got=$($SUDO sha256sum "$file" 2>/dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || { r1a_reason "R1A_${label}_DIGEST_MISMATCH"; return 1; }
}
# r1a_current_release_gate CURRENT_LINK RELEASE_PATH — the `current` pointer is exactly the frozen release.
r1a_current_release_gate() {
  local link=${1:-} want=${2:-}
  [ "$($SUDO readlink "$link" 2>/dev/null)" = "$want" ] || { r1a_reason "R1A_CURRENT_RELEASE_DRIFT"; return 1; }
}
# r1a_journal_access_gate — the trusted journal (with the metadata the verifier needs) is readable: ONE bounded read-only journalctl.
r1a_journal_access_gate() {
  $SUDO journalctl -o json --no-pager -n 1 --output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_TRANSPORT,_EXE,_UID >/dev/null 2>&1 || { r1a_reason "R1A_JOURNAL_UNREADABLE"; return 1; }
}

# ---- attempt state machine -----------------------------------------------------------------------------------------------------------------------------
# r1a_run_attempt AUTH_DIR OBSERVE_SECONDS — drives the fixed ordering with HOOK FUNCTIONS supplied by the runner (stubbed in tests). It owns the marker and NOTHING else:
#   hooks: r1a_hook_pregates  r1a_hook_baseline  r1a_hook_regate  r1a_hook_observe SECONDS  r1a_hook_final  r1a_hook_verify  r1a_hook_preserve_evidence REASON
# Ordering (fixed): pre-gates -> baseline -> re-gate -> CONSUME MARKER -> open window -> observe -> final -> verify ONCE.
# Any failure BEFORE the marker leaves the attempt unconsumed (nothing was observed). ANY failure AFTER the marker is R1A_RESULT=FAIL, attempt consumed, rerun not allowed: the evidence is
# preserved, nothing is retried, repaired, rolled back or deleted. There is no loop around any hook.
r1a_run_attempt() {
  local dir=${1:-} seconds=${2:-} stage
  [[ "$seconds" =~ ^[1-9][0-9]{0,5}$ ]] || { r1a_reason "R1A_OBSERVE_SECONDS_INVALID"; return 1; }
  r1a_attempt_unconsumed "$dir" || return 1   # a consumed attempt is refused before ANY hook runs
  for stage in pregates baseline regate; do
    if ! "r1a_hook_$stage"; then
      echo "R1A_PRE_ATTEMPT_FAILURE=$stage R1A_ATTEMPT_CONSUMED=NO (nothing was observed; no marker was created)"
      return 1
    fi
  done
  r1a_consume_attempt "$dir" || { echo "R1A_PRE_ATTEMPT_FAILURE=marker R1A_ATTEMPT_CONSUMED=UNKNOWN_SEE_REASON"; return 1; }
  echo "R1A_ATTEMPT_CONSUMED=YES"
  echo "R1A_EVENT_WINDOW_OPEN=YES"
  echo "WAITING_FOR_GENUINE_EXTERNAL_EVENT=YES (this runner generates NO event; the owner performs the authorized external event separately)"
  if ! r1a_hook_observe "$seconds"; then r1a_attempt_failed observe; return 1; fi
  if ! r1a_hook_final; then r1a_attempt_failed final; return 1; fi
  if ! r1a_hook_verify; then r1a_attempt_failed verify; return 1; fi
  echo "R1A_RESULT=PASS"
  echo "R1A_PROMOTION=NOT_AUTOMATIC (F1_REAL_DETECTOR_ACCEPTANCE and R1_VERIFIED stay unpromoted until a separately reviewed LIVE closeout)"
  return 0
}
r1a_attempt_failed() {
  echo "R1A_RESULT=FAIL R1A_FAILED_STAGE=$1 R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO"
  r1a_hook_preserve_evidence "$1" || true
  echo "R1A_EVIDENCE_PRESERVED=YES (no retry, no repair, no rollback of genuine evidence; R1I stays installed)"
}
