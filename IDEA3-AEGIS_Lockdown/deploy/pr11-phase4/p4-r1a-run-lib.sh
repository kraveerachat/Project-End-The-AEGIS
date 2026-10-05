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

# ---- one-attempt authority: ONE canonical stage-global marker + authorization-local marker ------------------------------------------------------------
# R1A is ONE live attempt TOTAL. The authority is a SINGLE canonical stage-global marker whose location is fixed by THIS stage contract (R1A_CANONICAL_DIR below), not pinned per runner and not chosen by
# an operator, an AUTH_DIR, a frozen runner or a successor main. It therefore survives the same runner, a replacement or copied AUTH_DIR, fresh same-day or later Authorization/K3, a successor frozen
# runner and a successor main reconciliation. The directory is root-owned 0700 (a governance record, not a Core, release or evidence path): the ONLY mutation R1A governance owns there is the one
# exclusive creation of the consumption record (and, once, of the window record). It is made immutable best-effort (chattr +i). No repository code removes, resets, rewrites or relocates it.
# The assignment below OVERRIDES any environment value and is readonly, so a runner or caller cannot re-point it; the frozen runner additionally refuses every override variable at start.
if ! readonly -p 2>/dev/null | grep -q 'R1A_CANONICAL_DIR='; then
  R1A_CANONICAL_DIR=/var/lib/aegis-idea3-governance
  readonly R1A_CANONICAL_DIR
fi
R1A_GLOBAL_MARKER_NAME="R1A-GLOBAL-ATTEMPT-CONSUMED"
R1A_WINDOW_RECORD_NAME="R1A-ATTEMPT-WINDOW"
R1A_WINDOW_START=""
R1A_WINDOW_END=""

# r1a_canonical_dir — the canonical directory. TEST-ONLY seam (same precedent as AEGIS_P4_HANDLER_DIR): honoured only when BOTH test variables are set; the frozen runner refuses to start if either is set.
r1a_canonical_dir() {
  if [ "${R1A_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${R1A_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$R1A_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$R1A_CANONICAL_DIR"; fi
}

# r1a_ipv4_valid IP — a real, EXTERNAL-capable IPv4 address: four canonical decimal octets 0-255 (no leading zeros), not unspecified, loopback, link-local, multicast/reserved or broadcast.
r1a_ipv4_valid() {
  local ip=${1:-} octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])' first
  [[ "$ip" =~ ^$octet\.$octet\.$octet\.$octet$ ]] || return 1
  first=${ip%%.*}
  [ "$first" != 0 ] && [ "$first" != 127 ] && [ "$first" -lt 224 ] || return 1
  [[ "$ip" != 169.254.* ]]
}
# r1a_canonical_dir_valid — when the canonical directory exists it must be a real directory (never a symlink), owned by root (the current user when no sudo is in use, i.e. in tests) and not group/world
# writable. A directory that does not exist yet is valid: it is created, once, by the consumption step. Its PARENT must be a real directory.
r1a_canonical_dir_valid() {
  local dir owner want
  dir=$(r1a_canonical_dir)
  [[ "$dir" == /* ]] && [[ "$dir" != *..* ]] || { r1a_reason "R1A_CANONICAL_DIR_INVALID"; return 1; }
  [ -d "$(dirname "$dir")" ] && [ ! -L "$(dirname "$dir")" ] || { r1a_reason "R1A_CANONICAL_DIR_PARENT_INVALID"; return 1; }
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then
    $SUDO test -d "$dir" && ! $SUDO test -L "$dir" || { r1a_reason "R1A_CANONICAL_DIR_INVALID"; return 1; }
    owner=$($SUDO stat -c %u "$dir" 2>/dev/null); want=0; [ -n "$SUDO" ] || want=$(id -u)
    [ "$owner" = "$want" ] && [ -z "$($SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1a_reason "R1A_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED"; return 1; }
  fi
}
# r1a_attempt_unconsumed AUTH_DIR — read-only pre-gate: NEITHER the canonical stage-global marker NOR the authorization-local marker exists.
r1a_attempt_unconsumed() {
  local dir=${1:-} canon marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1a_reason "R1A_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  r1a_canonical_dir_valid || return 1
  canon=$(r1a_canonical_dir); marker="$canon/$R1A_GLOBAL_MARKER_NAME"
  if $SUDO test -e "$marker" || $SUDO test -L "$marker"; then
    r1a_reason "R1A_ATTEMPT_ALREADY_CONSUMED (R1A is ONE live attempt TOTAL; a replacement AUTH_DIR, fresh Authorization/K3, a successor runner or a successor main cannot enable another; there is NO retry)"; return 1
  fi
  if $SUDO test -e "$canon/$R1A_WINDOW_RECORD_NAME" || $SUDO test -L "$canon/$R1A_WINDOW_RECORD_NAME"; then
    r1a_reason "R1A_CANONICAL_STATE_INCONSISTENT (a window record exists without a consumption marker: fail closed; do not retry)"; return 1
  fi
  [ ! -e "$dir/R1A-ATTEMPT-CONSUMED" ] || { r1a_reason "R1A_ATTEMPT_ALREADY_CONSUMED (this authorization already consumed its attempt; there is NO retry)"; return 1; }
}
# r1a_consume_attempt AUTH_DIR — fixed ordering: (1) the marker is proven absent; (2) the canonical stage-global marker is created EXCLUSIVELY (noclobber) — from this instant the attempt is irreversibly
# consumed; (3) ONLY THEN is R1A_WINDOW_START sampled; (4) the authorization-local marker is written. If step 4 fails the attempt STAYS consumed: nothing is deleted, rewritten or retried.
r1a_consume_attempt() {
  local dir=${1:-} canon marker
  r1a_attempt_unconsumed "$dir" || return 1
  canon=$(r1a_canonical_dir); marker="$canon/$R1A_GLOBAL_MARKER_NAME"
  $SUDO test -d "$canon" || $SUDO mkdir -m 0700 "$canon" 2>/dev/null || { r1a_reason "R1A_CANONICAL_DIR_NOT_CREATABLE (nothing was consumed)"; return 1; }
  if ! $SUDO bash -c 'set -o noclobber; printf "consumed_at=%s\n" "$(date -u +%FT%TZ)" > "$1"' _ "$marker" 2>/dev/null; then
    r1a_reason "R1A_ATTEMPT_ALREADY_CONSUMED (the canonical stage-global marker exists or could not be created exclusively)"; return 1
  fi
  $SUDO chattr +i "$marker" 2>/dev/null || true      # best-effort immutability of the consumption record
  R1A_WINDOW_START=$(date +%s.%N); export R1A_WINDOW_START   # sampled strictly AFTER the stage-global marker exists
  if ! ( set -o noclobber; printf 'consumed_at=%s\nconsumed_epoch=%s\n' "$(date -u +%FT%TZ)" "$R1A_WINDOW_START" > "$dir/R1A-ATTEMPT-CONSUMED" ) 2>/dev/null; then
    r1a_reason "R1A_LOCAL_MARKER_NOT_WRITTEN (the attempt IS consumed: the canonical stage-global marker exists; no retry is permitted)"; return 1
  fi
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

# ---- immutable verifier authority ------------------------------------------------------------------------------------------------------------------
# r1a_verifier_gate SNAPSHOT MANIFEST_SHA256 REPO DETECTOR_SHA256 TOOL — the verifier source root executes is the frozen immutable snapshot: manifest digest, every file digest, exact file set, no symlink and
# nothing writable (the pinned tool); every snapshot file is byte-identical to the PINNED-main git object (so the whole dependency closure is the reviewed source); and the snapshot's production_detector.py
# (which the verifier imports to reconstruct the detector's rules) is exactly the deployed detector's frozen digest. Read-only.
r1a_verifier_gate() {
  local snap=${1:-} want=${2:-} repo=${3:-} det=${4:-} tool=${5:-} sha rel got
  [ -f "$tool" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { r1a_reason "R1A_VERIFIER_GATE_INPUT_INVALID"; return 1; }
  python3 "$tool" check "$snap" "$want" >/dev/null 2>&1 || { r1a_reason "R1A_VERIFIER_SNAPSHOT_DRIFT"; return 1; }
  while read -r sha rel; do
    [ "$rel" != "" ] || continue
    got=$(git -C "$repo" show "HEAD:IDEA3-AEGIS_Lockdown/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { r1a_reason "R1A_VERIFIER_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel"; return 1; }
  done < "$snap/R1A-VERIFIER-SHA256SUMS"
  [ "$(sha256sum "$snap/aegis_soc/production_detector.py" 2>/dev/null | cut -d' ' -f1)" = "$det" ] || { r1a_reason "R1A_VERIFIER_DETECTOR_NOT_THE_DEPLOYED_DIGEST"; return 1; }
  [ -f "$snap/aegis_soc/recovery_evidence.py" ] && [ -f "$snap/aegis_soc/ip_containment.py" ] && [ -f "$snap/aegis_soc/r1_acceptance.py" ] || { r1a_reason "R1A_VERIFIER_CLOSURE_INCOMPLETE"; return 1; }
}
# r1a_interpreter_gate PY — root runs this interpreter: it must resolve to a root-owned file that is not group/world writable.
r1a_interpreter_gate() {
  local resolved
  resolved=$(readlink -f "${1:-}" 2>/dev/null) && [ -f "$resolved" ] || { r1a_reason "R1A_INTERPRETER_UNRESOLVABLE"; return 1; }
  [ "$(stat -c %U "$resolved")" = root ] && [ -z "$(find "$resolved" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1a_reason "R1A_INTERPRETER_NOT_ROOT_OWNED"; return 1; }
}

# ---- attempt state machine -----------------------------------------------------------------------------------------------------------------------------
# r1a_run_attempt AUTH_DIR OBSERVE_SECONDS — drives the fixed ordering with HOOK FUNCTIONS supplied by the runner (stubbed in tests). It owns the marker and NOTHING else:
#   hooks: r1a_hook_pregates  r1a_hook_baseline  r1a_hook_regate  r1a_hook_observe SECONDS  r1a_hook_final  r1a_hook_verify  r1a_hook_preserve_evidence REASON
# Ordering (fixed): pre-gates -> baseline -> re-gate -> CONSUME MARKER -> open window -> observe -> final -> verify ONCE.
# Any failure BEFORE the marker leaves the attempt unconsumed (nothing was observed). ANY failure AFTER the marker is R1A_RESULT=FAIL, attempt consumed, rerun not allowed: the evidence is
# preserved, nothing is retried, repaired, rolled back or deleted. There is no loop around any hook.
r1a_run_attempt() {
  local dir=${1:-} seconds=${2:-} stage canon
  [[ "$seconds" =~ ^[1-9][0-9]{0,5}$ ]] || { r1a_reason "R1A_OBSERVE_SECONDS_INVALID"; return 1; }
  r1a_attempt_unconsumed "$dir" || return 1   # a consumed attempt (canonical stage-global OR local) is refused before ANY hook runs
  for stage in pregates baseline regate; do
    if ! "r1a_hook_$stage"; then
      echo "R1A_PRE_ATTEMPT_FAILURE=$stage R1A_ATTEMPT_CONSUMED=NO (nothing was observed; no marker was created)"
      return 1
    fi
  done
  if ! r1a_consume_attempt "$dir"; then
    canon=$(r1a_canonical_dir)
    if $SUDO test -e "$canon/$R1A_GLOBAL_MARKER_NAME" || $SUDO test -L "$canon/$R1A_GLOBAL_MARKER_NAME"; then
      # the canonical stage-global marker exists, so the attempt IS consumed (whether or not this call created it): no window opens, nothing is observed, there is no retry
      echo "R1A_RESULT=FAIL R1A_FAILED_STAGE=marker R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO (no window opened; no event was observed)"
      r1a_hook_preserve_evidence marker || true
      echo "R1A_EVIDENCE_PRESERVED=YES (the canonical marker is retained; R1I stays installed)"
    else
      echo "R1A_PRE_ATTEMPT_FAILURE=marker R1A_ATTEMPT_CONSUMED=NO (the canonical stage-global marker was not created; nothing was observed)"
    fi
    return 1
  fi
  echo "R1A_ATTEMPT_CONSUMED=YES"
  echo "R1A_EVENT_WINDOW_OPEN=YES R1A_WINDOW_START_EPOCH=$R1A_WINDOW_START"
  echo "WAITING_FOR_GENUINE_EXTERNAL_EVENT=YES (this runner generates NO event; the owner performs the authorized genuine external event separately)"
  if ! r1a_hook_observe "$seconds"; then r1a_attempt_failed observe; return 1; fi
  R1A_WINDOW_END=$(date +%s.%N); export R1A_WINDOW_END   # the exact END of the marker-bounded window: recorded the instant the bounded wait completes, BEFORE any final capture
  canon=$(r1a_canonical_dir)
  # MANDATORY and exclusive: the canonical marker-bounded window record is the durable evidence of the window. If it cannot be created (permission, I/O, an existing record) the attempt FAILS closed
  # (consumed, no rerun, evidence preserved) and NO final capture or verifier run happens.
  if ! $SUDO bash -c 'set -o noclobber; printf "window_start=%s\nwindow_end=%s\nobserve_seconds=%s\n" "$2" "$3" "$4" > "$1"' _ "$canon/$R1A_WINDOW_RECORD_NAME" "$R1A_WINDOW_START" "$R1A_WINDOW_END" "$seconds" 2>/dev/null; then
    r1a_attempt_failed windowrecord; return 1
  fi
  echo "R1A_EVENT_WINDOW_OPEN=NO R1A_WINDOW_END_EPOCH=$R1A_WINDOW_END"
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
