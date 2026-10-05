#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1D (historical R1A incident disposition) owner-run gate library + attempt state machine. Sourced by the FROZEN owner runner; nothing here runs on its own and
# nothing here mutates the host. Every gate returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them.
#
# Owner-approved R1D model (fixed): MUTATING governed stage, ONE attempt, NO retry. R1D disposes of the ONE preserved historical incident of the immutable failed R1A attempt through the Core's dedicated
# local channel (Core-mediated, atomic, evidence-preserving); it is NOT Recovery R8 and NOT an R1A retry. This library never writes to the audit DB, never closes an incident itself, never touches
# nftables, a unit or the journal, never generates an event and never deletes or edits R1A evidence. The ONLY effect is the one Core call made by the stage handler after the one-shot marker exists.

: "${SUDO=sudo}"
_R1D_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1u-run-lib.sh
. "$_R1D_LIB_DIR/p4-f1u-run-lib.sh"

# Every Git read that feeds an R1D trust decision runs with replacement objects DISABLED. A real `git replace GOOD EVIL` keeps the apparent commit SHA while changing the bytes plain Git resolves, so the
# wrapper sets GIT_NO_REPLACE_OBJECTS=1 explicitly on EVERY invocation (a caller's environment cannot re-enable replacement). It is a shell function, so it also covers the shared run libraries sourced
# above, which call plain `git`.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }

R1D_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1D_R1A_FAILURE_CLOSEOUT_RECEIPT_REL="$R1D_LOGS_REL/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1D_R1I_CLOSEOUT_RECEIPT_REL="$R1D_LOGS_REL/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1D_F1U_CLOSEOUT_RECEIPT_REL="$R1D_LOGS_REL/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1D_R1I_TABLE="inet aegis_idea3_r1i"

r1d_reason() { printf '%s\n' "$1" >&2; return 1; }

# ---- one-attempt authority: ONE canonical stage-global marker + authorization-local marker ------------------------------------------------------------
# R1D is ONE live attempt TOTAL. The authority is a SINGLE canonical stage-global marker whose location is fixed by THIS stage contract (R1D_CANONICAL_DIR below), not pinned per runner and not chosen by
# an operator, an AUTH_DIR, a frozen runner or a successor main. It therefore survives the same runner, a replacement or copied AUTH_DIR, fresh same-day or later Authorization/K3, a successor frozen
# runner and a successor main reconciliation. The directory is root-owned 0700 (a governance record, not a Core, release or evidence path): the ONLY mutation R1D governance owns there is the one
# exclusive creation of the consumption record (and, once, of the window record). It is made immutable best-effort (chattr +i). No repository code removes, resets, rewrites or relocates it.
# The assignment below OVERRIDES any environment value and is readonly, so a runner or caller cannot re-point it; the frozen runner additionally refuses every override variable at start.
if ! readonly -p 2>/dev/null | grep -q 'R1D_CANONICAL_DIR='; then
  R1D_CANONICAL_DIR=/var/lib/aegis-idea3-governance
  readonly R1D_CANONICAL_DIR
fi
# Production snapshot ownership invariant (see r1d_verifier_snapshot.py): uid 0 owns the snapshot and every ancestor up to the trusted parent `/`. The python checker has NO trust-root option; its only test
# seam is the pair of R1D_TEST_ONLY_SNAPSHOT_TRUST_* variables, which it honours ONLY inside a user namespace (the frozen runner refuses to start if either is set). This library passes nothing.
R1D_GLOBAL_MARKER_NAME="R1D-GLOBAL-ATTEMPT-CONSUMED"
R1B_MARKER_NAME="R1B-GLOBAL-ATTEMPT-CONSUMED"      # historical successor markers that must NOT exist when R1D runs
R1B_WINDOW_NAME="R1B-ATTEMPT-WINDOW"
R1A_MARKER_NAME="R1A-GLOBAL-ATTEMPT-CONSUMED"      # the consumed R1A attempt that MUST exist
R1A_WINDOW_NAME="R1A-ATTEMPT-WINDOW"

# r1d_canonical_dir — the canonical directory. TEST-ONLY seam (same precedent as AEGIS_P4_HANDLER_DIR): honoured only when BOTH test variables are set; the frozen runner refuses to start if either is set.
r1d_canonical_dir() {
  if [ "${R1D_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${R1D_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$R1D_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$R1D_CANONICAL_DIR"; fi
}

# r1d_canonical_dir_valid — when the canonical directory exists it must be a real directory (never a symlink), owned by root (the current user when no sudo is in use, i.e. in tests) and not group/world
# writable. A directory that does not exist yet is valid: it is created, once, by the consumption step. Its PARENT must be a real directory.
r1d_canonical_dir_valid() {
  local dir owner want
  dir=$(r1d_canonical_dir)
  [[ "$dir" == /* ]] && [[ "$dir" != *..* ]] || { r1d_reason "R1D_CANONICAL_DIR_INVALID"; return 1; }
  [ -d "$(dirname "$dir")" ] && [ ! -L "$(dirname "$dir")" ] || { r1d_reason "R1D_CANONICAL_DIR_PARENT_INVALID"; return 1; }
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then
    $SUDO test -d "$dir" && ! $SUDO test -L "$dir" || { r1d_reason "R1D_CANONICAL_DIR_INVALID"; return 1; }
    owner=$($SUDO stat -c %u "$dir" 2>/dev/null); want=0; [ -n "$SUDO" ] || want=$(id -u)
    [ "$owner" = "$want" ] && [ -z "$($SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1d_reason "R1D_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED"; return 1; }
  fi
}
# r1d_fsync PATH — an explicit, fail-closed durability barrier for ONE path (a file or a directory): `sync PATH` is coreutils' fsync(2)-on-that-path (never a sleep, never best-effort). A failed sync is a
# FAILURE. Tests intercept `sync` through PATH; nothing here deletes, resets or rewrites anything.
r1d_fsync() {
  local path=${1:-}
  [ -n "$path" ] && $SUDO sync -- "$path" 2>/dev/null || { r1d_reason "R1D_DURABILITY_BARRIER_FAILED:$(basename "$path")"; return 1; }
}
# r1d_durable FILE DIR — the file's data and metadata are forced durable FIRST, then the containing directory entry. Both must succeed.
r1d_durable() {
  r1d_fsync "${1:-}" && r1d_fsync "${2:-}"
}
# r1d_attempt_unconsumed AUTH_DIR — read-only pre-gate: NEITHER the canonical R1D stage-global marker NOR the authorization-local marker exists.
r1d_attempt_unconsumed() {
  local dir=${1:-} canon marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1d_reason "R1D_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  r1d_canonical_dir_valid || return 1
  canon=$(r1d_canonical_dir); marker="$canon/$R1D_GLOBAL_MARKER_NAME"
  if $SUDO test -e "$marker" || $SUDO test -L "$marker"; then
    r1d_reason "R1D_ATTEMPT_ALREADY_CONSUMED (R1D is ONE attempt TOTAL; a replacement AUTH_DIR, fresh Authorization/K3, a successor runner or a successor main cannot enable another; there is NO retry)"; return 1
  fi
  [ ! -e "$dir/R1D-ATTEMPT-CONSUMED" ] || { r1d_reason "R1D_ATTEMPT_ALREADY_CONSUMED (this authorization already consumed its attempt; there is NO retry)"; return 1; }
}
# r1d_history_gate — the canonical governance history R1D depends on (read-only, root): the consumed R1A attempt (marker AND window record) EXISTS and is never touched; the R1B successor has NOT begun (no
# marker, no window record). A missing R1A record, an existing R1B record, or a symlink in place of any of them fails closed.
r1d_history_gate() {
  local canon name
  r1d_canonical_dir_valid || return 1
  canon=$(r1d_canonical_dir)
  $SUDO test -d "$canon" || { r1d_reason "R1D_CANONICAL_DIR_MISSING (the consumed R1A records must exist)"; return 1; }
  for name in "$R1A_MARKER_NAME" "$R1A_WINDOW_NAME"; do
    { $SUDO test -f "$canon/$name" && ! $SUDO test -L "$canon/$name"; } || { r1d_reason "R1D_R1A_RECORD_MISSING:$name"; return 1; }
  done
  for name in "$R1B_MARKER_NAME" "$R1B_WINDOW_NAME"; do
    if $SUDO test -e "$canon/$name" || $SUDO test -L "$canon/$name"; then r1d_reason "R1D_R1B_ALREADY_BEGUN:$name (R1D is only valid BEFORE R1B)"; return 1; fi
  done
}
# r1d_consume_attempt AUTH_DIR — fixed ordering: (1) the marker is proven absent; (2) the canonical stage-global marker is created EXCLUSIVELY (noclobber) — from this instant the attempt is irreversibly
# consumed; (3) the marker file and its directory are forced durable; (4) the authorization-local marker is written. If step 4 fails the attempt STAYS consumed: nothing is deleted, rewritten or retried.
r1d_consume_attempt() {
  local dir=${1:-} canon marker
  r1d_attempt_unconsumed "$dir" || return 1
  canon=$(r1d_canonical_dir); marker="$canon/$R1D_GLOBAL_MARKER_NAME"
  if ! $SUDO test -d "$canon"; then
    r1d_reason "R1D_CANONICAL_DIR_MISSING (nothing was consumed)"; return 1   # R1A created it; R1D never creates the governance directory
  fi
  # The canonical directory's ENTRY in its parent is forced durable before any marker can exist; nothing is consumed yet, a failure here leaves no marker.
  r1d_fsync "$(dirname "$canon")" || { r1d_reason "R1D_CANONICAL_DIR_ENTRY_NOT_DURABLE (nothing was consumed: no marker exists yet)"; return 1; }
  if ! $SUDO bash -c 'set -o noclobber; printf "consumed_at=%s\n" "$(date -u +%FT%TZ)" > "$1"' _ "$marker" 2>/dev/null; then
    r1d_reason "R1D_ATTEMPT_ALREADY_CONSUMED (the canonical stage-global marker exists or could not be created exclusively)"; return 1
  fi
  # The marker now EXISTS: from here the attempt is consumed whatever happens; a failed barrier is a consumed FAIL (no Core call, no retry); the marker is never removed or rewritten.
  r1d_durable "$marker" "$canon" || { r1d_reason "R1D_MARKER_NOT_DURABLE (the attempt IS consumed: the canonical marker exists; no retry is permitted)"; return 1; }
  $SUDO chattr +i "$marker" 2>/dev/null || true      # best-effort immutability of the consumption record (after durability)
  if ! ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$dir/R1D-ATTEMPT-CONSUMED" ) 2>/dev/null; then
    r1d_reason "R1D_LOCAL_MARKER_NOT_WRITTEN (the attempt IS consumed: the canonical stage-global marker exists; no retry is permitted)"; return 1
  fi
}

# ---- predecessor receipt gates (pinned-commit content, never PR numbers) ------------------------------------------------------------------------------
# r1d_commit_gate REPO MAIN — the pinned commit is a real commit object (replacement disabled) and HEAD is exactly that commit. Every receipt/byte read below uses MAIN explicitly, never HEAD.
r1d_commit_gate() {
  local repo=${1:-} main=${2:-}
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || { r1d_reason "R1D_PINNED_COMMIT_MALFORMED"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "$main^{commit}" 2>/dev/null)" = "$main" ] || { r1d_reason "R1D_PINNED_COMMIT_NOT_A_COMMIT_OBJECT"; return 1; }
  [ "$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$main" ] || { r1d_reason "R1D_HEAD_NOT_THE_PINNED_COMMIT"; return 1; }
}
# r1d_field_files REPO MAIN FIELD VALUE — status-log receipts OF THE PINNED COMMIT holding FIELD=VALUE as a whole line (output lines are `MAIN:path`).
r1d_field_files() {
  git -C "$1" grep -lE "^[[:space:]]*([-*][[:space:]]+)?\`?$3[[:space:]]*=[[:space:]]*$4\`?[[:space:]]*\$" "$2" -- "$R1D_LOGS_REL" 2>/dev/null | sort
}
# _r1d_only_receipt REPO MAIN CANONICAL_REL LABEL FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and it is the canonical receipt path.
_r1d_only_receipt() {
  local repo=$1 main=$2 canonical=$3 label=$4 pair files="" part
  shift 4
  for pair in "$@"; do
    part=$(r1d_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [ "${files#"$main":}" = "$canonical" ] || return 1
}
# _r1d_unique_suffix_receipt REPO MAIN NAME_SUFFIX FIELD=VALUE... — exactly ONE receipt of the pinned commit carries ALL the whole-line fields, and its file name ends with NAME_SUFFIX (the closeout of a
# stage whose date-stamped name did not exist when this library was written).
_r1d_unique_suffix_receipt() {
  local repo=$1 main=$2 suffix=$3 pair files="" part
  shift 3
  for pair in "$@"; do
    part=$(r1d_field_files "$repo" "$main" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || return 1
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || return 1
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] && [[ "$files" == "$main:$R1D_LOGS_REL/"*"$suffix" ]] || return 1
}
# r1d_receipt_gate REPO RELEASE_ID MAIN — F1 detector deployed, the R1 evidence foundation merged, F1u (Core with ALERT_ACCEPTED) deployed, R1I LIVE closed — each from ONE canonical receipt of the pinned
# commit (read as MAIN:path with replacement objects disabled) — and no contradictory or duplicate success state, and R1D not already recorded.
r1d_receipt_gate() {
  local repo=${1:-} release=${2:-} main=${3:-} claim files
  [ -n "$repo" ] && [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { r1d_reason "R1D_RECEIPT_GATE_INPUT_INVALID"; return 1; }
  r1d_commit_gate "$repo" "$main" || return 1
  _r1d_only_receipt "$repo" "$main" "$F1U_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES \
    || { r1d_reason "R1D_F1_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  _r1d_only_receipt "$repo" "$main" "$F1U_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED \
    || { r1d_reason "R1D_R1_FOUNDATION_MISSING_OR_AMBIGUOUS"; return 1; }
  # F1u closeout must still exist (history); the pinned CURRENT release is the one the unique R1Du closeout (a Core upgrade that carries the R1D disposition authority) installed and activated.
  git -C "$repo" cat-file -e "$main:$R1D_F1U_CLOSEOUT_RECEIPT_REL" 2>/dev/null || { r1d_reason "R1D_F1U_CLOSEOUT_MISSING"; return 1; }
  _r1d_unique_suffix_receipt "$repo" "$main" "_music_idea3-r1du-live-closeout.md" R1DU_LIVE=CLOSED_PASS R1DU_LIVE_EXECUTED=YES R1DU_PRODUCTION_DEPLOYED=YES R1DU_ATTEMPT_CONSUMED=YES \
    R1DU_RERUN_ALLOWED=NO R1DU_RELEASE_ID="$release" R1DU_R1D_EXECUTED=NO R1DU_INCIDENT_MUTATED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1d_reason "R1D_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  # R1I LIVE closeout: ONE canonical receipt carrying the full success state, and still the unproven claim boundary.
  _r1d_only_receipt "$repo" "$main" "$R1D_R1I_CLOSEOUT_RECEIPT_REL" R1I_CLOSEOUT R1I_LIVE=CLOSED_PASS R1I_LIVE_EXECUTED=YES R1I_PRODUCTION_DEPLOYED=YES R1I_ATTEMPT_CONSUMED=YES \
    R1I_RERUN_ALLOWED=NO PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED \
    || { r1d_reason "R1D_R1I_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  # The predecessor R1A attempt is immutable FAIL/consumed/no-retry. R1D is a NEW successor stage, never a replay.
  _r1d_only_receipt "$repo" "$main" "$R1D_R1A_FAILURE_CLOSEOUT_RECEIPT_REL" R1A_FAILURE_CLOSEOUT \
    R1A_LIVE_EXECUTED=YES R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO R1A_RESULT=FAIL R1A_STAGE_VERIFY=NOT_REACHED \
    F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO \
    || { r1d_reason "R1D_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS"; return 1; }
  [ -z "$(r1d_field_files "$repo" "$main" R1A_LIVE CLOSED_PASS)" ] || { r1d_reason "R1D_R1A_HISTORY_CONTRADICTS_IMMUTABLE_FAIL"; return 1; }
  # no second success claim for R1I anywhere, and no contradictory live claim
  files=$(r1d_field_files "$repo" "$main" R1I_LIVE CLOSED_PASS)
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] || { r1d_reason "R1D_R1I_SUCCESS_NOT_UNIQUE"; return 1; }
  for claim in R1I_LIVE=FAIL R1I_RERUN_ALLOWED=YES F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED R1_VERIFIED=YES RECOVERY_R1_R8_PROVEN=YES \
      R1D_LIVE_EXECUTED=YES R1D_LIVE=CLOSED_PASS R1D_LIVE=FAIL R1D_ATTEMPT_CONSUMED=YES R1B_LIVE_EXECUTED=YES R1B_LIVE=CLOSED_PASS R1B_LIVE=FAIL R1B_ATTEMPT_CONSUMED=YES RECOVERY_R2_R8_EXECUTED=YES; do
    [ -z "$(r1d_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { r1d_reason "R1D_CONTRADICTORY_OR_ALREADY_RECORDED (a receipt carries ${claim})"; return 1; }
  done
}

# ---- host gates (read-only) ---------------------------------------------------------------------------------------------------------------------------
# r1d_r1i_present_gate TOOL — the live R1I table is still present and is EXACTLY the owned shape (root read; the R1I validator accepts only the exact table).
r1d_r1i_present_gate() {
  local tool=${1:-} state
  [ -f "$tool" ] || { r1d_reason "R1D_R1I_VALIDATOR_MISSING"; return 1; }
  $SUDO nft list tables 2>/dev/null | grep -qxF "table $R1D_R1I_TABLE" || { r1d_reason "R1D_R1I_TABLE_MISSING (R1I must stay installed; a reboot removes it)"; return 1; }
  state=$($SUDO nft --stateless list table $R1D_R1I_TABLE 2>/dev/null) || { r1d_reason "R1D_R1I_TABLE_UNREADABLE"; return 1; }
  printf '%s\n' "$state" | python3 "$tool" validate-state /dev/stdin >/dev/null 2>&1 || { r1d_reason "R1D_R1I_TABLE_NOT_EXACT_OWNED_SHAPE"; return 1; }
}
# r1d_digest_gate FILE EXPECTED_SHA256 LABEL — a deployed/authority file matches its frozen digest.
r1d_digest_gate() {
  local file=${1:-} want=${2:-} label=${3:-FILE} got
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ -f "$file" ] || { r1d_reason "R1D_${label}_DIGEST_INPUT_INVALID"; return 1; }
  got=$($SUDO sha256sum "$file" 2>/dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || { r1d_reason "R1D_${label}_DIGEST_MISMATCH"; return 1; }
}
# r1d_current_release_gate CURRENT_LINK RELEASE_PATH — the `current` pointer is exactly the frozen release.
r1d_current_release_gate() {
  local link=${1:-} want=${2:-}
  [ "$($SUDO readlink "$link" 2>/dev/null)" = "$want" ] || { r1d_reason "R1D_CURRENT_RELEASE_DRIFT"; return 1; }
}
# r1d_journal_access_gate — the trusted journal (with the metadata the verifier needs) is readable: ONE bounded read-only journalctl.
r1d_journal_access_gate() {
  $SUDO journalctl -o json --no-pager -n 1 --output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_TRANSPORT,_EXE,_UID >/dev/null 2>&1 || { r1d_reason "R1D_JOURNAL_UNREADABLE"; return 1; }
}

# ---- immutable verifier authority ------------------------------------------------------------------------------------------------------------------
# r1d_verifier_gate SNAPSHOT MANIFEST_SHA256 REPO DETECTOR_SHA256 TOOL MAIN — the verifier source root executes is the frozen immutable snapshot: manifest digest, every file digest, exact file set, no symlink and
# nothing writable (the pinned tool); every snapshot file is byte-identical to the PINNED-main git object (so the whole dependency closure is the reviewed source); and the snapshot's production_detector.py
# (which the verifier imports to reconstruct the detector's rules) is exactly the deployed detector's frozen digest. Read-only.
r1d_verifier_gate() {
  local snap=${1:-} want=${2:-} repo=${3:-} det=${4:-} tool=${5:-} main=${6:-} sha rel got
  [ -f "$tool" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { r1d_reason "R1D_VERIFIER_GATE_INPUT_INVALID"; return 1; }
  r1d_commit_gate "$repo" "$main" || return 1
  python3 "$tool" check "$snap" "$want" >/dev/null 2>&1 || { r1d_reason "R1D_VERIFIER_SNAPSHOT_DRIFT_OR_NOT_ROOT_OWNED"; return 1; }
  while read -r sha rel; do
    [ "$rel" != "" ] || continue
    got=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { r1d_reason "R1D_VERIFIER_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel"; return 1; }
  done < "$snap/R1D-VERIFIER-SHA256SUMS"
  [ -f "$snap/aegis_soc/historical_disposition.py" ] && [ -f "$snap/aegis_soc/database.py" ] && [ -f "$snap/aegis_soc/ip_containment.py" ] || { r1d_reason "R1D_VERIFIER_CLOSURE_INCOMPLETE"; return 1; }
}
# r1d_interpreter_gate PY — root runs this interpreter: it must resolve to a root-owned file that is not group/world writable.
r1d_interpreter_gate() {
  local resolved
  resolved=$(readlink -f "${1:-}" 2>/dev/null) && [ -f "$resolved" ] || { r1d_reason "R1D_INTERPRETER_UNRESOLVABLE"; return 1; }
  [ "$(stat -c %U "$resolved")" = root ] && [ -z "$(find "$resolved" -maxdepth 0 -perm /022 2>/dev/null)" ] || { r1d_reason "R1D_INTERPRETER_NOT_ROOT_OWNED"; return 1; }
}

# ---- attempt state machine -----------------------------------------------------------------------------------------------------------------------------
# r1d_run_attempt AUTH_DIR — drives the fixed ordering with HOOK FUNCTIONS supplied by the runner (stubbed in tests). It owns the marker and NOTHING else:
#   hooks: r1d_hook_pregates  r1d_hook_baseline  r1d_hook_regate  r1d_hook_dispose  r1d_hook_final  r1d_hook_verify  r1d_hook_preserve_evidence REASON
# Ordering (fixed): pre-gates -> baseline (read-only proof) -> re-gate -> CONSUME MARKER -> ONE Core disposition -> final (read-only) -> verify ONCE.
# Any failure BEFORE the marker leaves the attempt unconsumed (nothing was changed). ANY failure AFTER the marker is R1D_RESULT=FAIL, attempt consumed, rerun not allowed: the evidence is preserved,
# nothing is retried, repaired, rolled back or deleted (a committed disposition is irreversible; an unknown outcome is inspected read-only, never resent). There is no loop around any hook.
r1d_run_attempt() {
  local dir=${1:-} stage canon
  r1d_attempt_unconsumed "$dir" || return 1   # a consumed attempt (canonical stage-global OR local) is refused before ANY hook runs
  for stage in pregates baseline regate; do
    if ! "r1d_hook_$stage"; then
      echo "R1D_PRE_ATTEMPT_FAILURE=$stage R1D_ATTEMPT_CONSUMED=NO (nothing was changed; no marker was created)"
      return 1
    fi
  done
  if ! r1d_consume_attempt "$dir"; then
    canon=$(r1d_canonical_dir)
    if $SUDO test -e "$canon/$R1D_GLOBAL_MARKER_NAME" || $SUDO test -L "$canon/$R1D_GLOBAL_MARKER_NAME"; then
      # the canonical stage-global marker exists, so the attempt IS consumed (whether or not this call created it): no Core call, there is no retry
      echo "R1D_RESULT=FAIL R1D_FAILED_STAGE=marker R1D_ATTEMPT_CONSUMED=YES R1D_RERUN_ALLOWED=NO (no Core call was made)"
      r1d_hook_preserve_evidence marker || true
      echo "R1D_EVIDENCE_PRESERVED=YES (the canonical marker is retained; R1I stays installed)"
    else
      echo "R1D_PRE_ATTEMPT_FAILURE=marker R1D_ATTEMPT_CONSUMED=NO (the canonical stage-global marker was not created; nothing was changed)"
    fi
    return 1
  fi
  echo "R1D_ATTEMPT_CONSUMED=YES"
  echo "R1D_CORE_DISPOSITION_CALL=ONCE (the Core derives the target itself; this runner supplies only the owner-authorized binding digest)"
  if ! r1d_hook_dispose; then r1d_attempt_failed dispose; return 1; fi
  if ! r1d_hook_final; then r1d_attempt_failed final; return 1; fi
  if ! r1d_hook_verify; then r1d_attempt_failed verify; return 1; fi
  echo "R1D_RESULT=PASS"
  echo "PREEXISTING_OPEN_INCIDENT_COUNT=0 R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES R1B_ATTEMPT_CONSUMED=NO"
  echo "R1D_PROMOTION=NONE (R1D proves only the Core-mediated historical disposition; R1B must still create a NEW incident from a later genuine event)"
  return 0
}
r1d_attempt_failed() {
  echo "R1D_RESULT=FAIL R1D_FAILED_STAGE=$1 R1D_ATTEMPT_CONSUMED=YES R1D_RERUN_ALLOWED=NO"
  r1d_hook_preserve_evidence "$1" || true
  echo "R1D_EVIDENCE_PRESERVED=YES (no retry, no repair, no rollback of a committed disposition; R1I stays installed)"
}
