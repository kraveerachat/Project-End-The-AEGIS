#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — RRu (governed Recovery-PREPARATION release deployment: ONE new immutable release that also carries aegis_soc/cli.py, current OLD -> NEW; NO Core restart, NO detector action, NO arming)
# owner-run gate library (sourced by the external frozen owner runner; nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Every
# function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them; SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git
# reads, file reads, `systemctl show`, `pgrep` and the read-only `check` of p4-rru-upgrade.py.
# RRu owns its OWN one-attempt marker (RRU-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=RRu, no extra field). It is NOT a retry of F1i/F1r/F1u/R1Du (consumed forever). It reuses the R1B-failure +
# R1Bv-PASS predecessor gate unchanged. It requires the Recovery attempt marker to be ABSENT, never creates one, never touches an incident, the audit/protocol databases or Recovery state, never claims a Recovery
# result, R1 verification, LVR, L8 or L9, and proves RECOVERY_RUNTIME_RELEASE_READY only.

: "${SUDO=sudo}"
_RRU_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-r1bv-run-lib.sh
. "$_RRU_LIB_DIR/p4-r1bv-run-lib.sh"   # git() with replacement objects disabled, r1bv_* predecessor gates, and (transitively) the f1u/f1i/f1r/l8p/l7u gates incl. f1i_catalog_transition_gate

RRU_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
RRU_R1DU_CLOSEOUT_RECEIPT_REL="$RRU_LOGS_REL/2026-10-06_070624_music_idea3-r1du-live-closeout.md"
RRU_CURRENT_KEY="host.symlink./opt/aegis-idea3/current.target"
RRU_CORE_UNIT=aegis-idea3-core.service
RRU_DETECTOR_UNIT=aegis-idea3-detector.service
RRU_APP_REL="IDEA3-AEGIS_Lockdown"
RRU_CANONICAL_DIR=/var/lib/aegis-idea3-governance
RRU_RECOVERY_MARKER_NAME="RECOVERY-GLOBAL-ATTEMPT-CONSUMED"

rru_reason() { printf '%s\n' "$1" >&2; return 1; }

# rru_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one RRu attempt.
rru_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { rru_reason "RRU_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/RRU-ATTEMPT-CONSUMED" ] || { rru_reason "RRU_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; there is NO automatic retry)"; return 1; }
}

# rru_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails closed even if the first attempt failed. The marker name is
# distinct from every other stage (F1I, F1R, F1, F1U, R1DU, R1D, R1B, RECOVERY…), so none of their markers ever authorizes RRu and RRu never consumes theirs.
rru_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { rru_reason "RRU_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/RRU-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  rru_reason "RRU_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; there is NO automatic retry)"
}

# rru_recovery_marker_absent — the ONE canonical stage-global Recovery attempt marker does not exist (not even as a dangling symlink). RRu is Recovery PREPARATION: it must never run after Recovery consumed its attempt, and it
# never creates, rewrites or removes that marker. Read-only.
rru_recovery_marker_absent() {
  local marker="$RRU_CANONICAL_DIR/$RRU_RECOVERY_MARKER_NAME"
  if $SUDO test -e "$marker" || $SUDO test -L "$marker"; then
    rru_reason "RRU_RECOVERY_ATTEMPT_ALREADY_CONSUMED (RRu is Recovery PREPARATION only; the Recovery marker must be absent)"; return 1
  fi
}

# rru_receipt_gate REPO MAIN OLD_RELEASE_ID — RRu is allowed only after: the pinned commit is HEAD; the EXISTING reviewed R1B-failure + R1Bv-PASS predecessor (unchanged, reused); the ONE canonical R1Du LIVE closeout naming
# the OLD release as the deployed release; NO contradictory claim (a Recovery result, real detector acceptance, R1 verified, LVR/L8/L9) anywhere; and only while RRu itself is not already recorded. A repository-only
# record that says NO never satisfies any of these.
rru_receipt_gate() {
  local repo=${1:-} main=${2:-} old=${3:-} claim
  [ -n "$repo" ] || { rru_reason "RRU_REPO_REQUIRED"; return 1; }
  [[ "$old" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { rru_reason "RRU_OLD_RELEASE_ID_INVALID"; return 1; }
  r1bv_recovery_predecessor_gate "$repo" "$main" || return 1   # also proves HEAD == the pinned main
  _r1bv_only_receipt "$repo" "$main" "$RRU_R1DU_CLOSEOUT_RECEIPT_REL" R1DU_CLOSEOUT R1DU_LIVE=CLOSED_PASS R1DU_LIVE_EXECUTED=YES R1DU_PRODUCTION_DEPLOYED=YES "R1DU_RELEASE_ID=$old" \
    || { rru_reason "RRU_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS (the ONE canonical R1Du LIVE closeout naming the OLD release is required)"; return 1; }
  for claim in RECOVERY_R2_R8_EXECUTED=YES RECOVERY_R1_R8_PROVEN=YES RECOVERY_RESULT=PASS F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED LVR_PROVEN=YES L8_ACCEPTANCE=YES L9_PROVEN=YES; do
    [ -z "$(r1bv_field_files "$repo" "$main" "${claim%%=*}" "${claim#*=}")" ] || { rru_reason "RRU_CONTRADICTORY_CLAIM (a receipt carries ${claim})"; return 1; }
  done
  [ -z "$(r1bv_field_files "$repo" "$main" RRU_LIVE_EXECUTED YES)$(r1bv_field_files "$repo" "$main" RRU_PRODUCTION_DEPLOYED YES)$(r1bv_field_files "$repo" "$main" RECOVERY_RUNTIME_RELEASE_READY YES)" ] \
    || { rru_reason "RRU_ALREADY_EXECUTED (an RRu result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# rru_runtime_source_gate REPO DETECTOR_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256 — the frozen digests are exactly the REVIEWED bytes of the PINNED commit (git object, never the working tree): production_detector.py
# (the byte-identical detector the deployed release carries), recovery_core.py and cli.py (the Recovery D4 restore entrypoint). Read-only.
rru_runtime_source_gate() {
  local repo=${1:-} det=${2:-} core=${3:-} cli=${4:-} got
  [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { rru_reason "RRU_DETECTOR_PIN_INVALID"; return 1; }
  [[ "$core" =~ ^[0-9a-f]{64}$ ]] || { rru_reason "RRU_RECOVERY_CORE_PIN_INVALID"; return 1; }
  [[ "$cli" =~ ^[0-9a-f]{64}$ ]] || { rru_reason "RRU_RESTORE_CLI_PIN_INVALID"; return 1; }
  got=$(git -C "$repo" show "HEAD:$RRU_APP_REL/aegis_soc/production_detector.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$det" ] || { rru_reason "RRU_DETECTOR_SOURCE_DIGEST_MISMATCH (the detector pin is not the reviewed source at the pinned main)"; return 1; }
  got=$(git -C "$repo" show "HEAD:$RRU_APP_REL/aegis_soc/recovery_core.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$core" ] || { rru_reason "RRU_RECOVERY_CORE_SOURCE_DIGEST_MISMATCH (the Core runtime pin is not the reviewed source at the pinned main)"; return 1; }
  got=$(git -C "$repo" show "HEAD:$RRU_APP_REL/aegis_soc/cli.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$cli" ] || { rru_reason "RRU_RESTORE_CLI_SOURCE_DIGEST_MISMATCH (the CLI pin is not the reviewed source at the pinned main)"; return 1; }
}

# rru_release_content_gate REPO SOURCE_DIR — every aegis_soc/ file the builder output lists in RELEASE-SHA256SUMS is byte-identical to the pinned commit's blob, so the release carries exactly the merged runtime, and it
# lists aegis_soc/cli.py and the R1D authority. (The release guard separately proves SUMS matches the files.) Read-only.
rru_release_content_gate() {
  local repo=${1:-} dir=${2:-} sums line digest rel want n=0
  sums="$dir/RELEASE-SHA256SUMS"
  [ -f "$sums" ] && [ ! -L "$sums" ] || { rru_reason "RRU_RELEASE_SUMS_MISSING"; return 1; }
  while IFS= read -r line; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ (aegis_soc/[A-Za-z0-9_./-]+)$ ]] || continue
    digest=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}
    want=$(git -C "$repo" show "HEAD:$RRU_APP_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$want" = "$digest" ] || { rru_reason "RRU_RELEASE_CONTENT_MISMATCH:$rel"; return 1; }
    n=$((n + 1))
  done < "$sums"
  [ "$n" -ge 3 ] || { rru_reason "RRU_RELEASE_CONTENT_TOO_SMALL"; return 1; }
  grep -q "^[0-9a-f]\{64\}  aegis_soc/cli.py$" "$sums" || { rru_reason "RRU_CLI_NOT_IN_RELEASE (the builder output lacks the manifested aegis_soc/cli.py)"; return 1; }
  grep -q "^[0-9a-f]\{64\}  aegis_soc/historical_disposition.py$" "$sums" || { rru_reason "RRU_R1D_DISPOSITION_AUTHORITY_NOT_IN_RELEASE"; return 1; }
}

# rru_preflight_gate PY TOOL OLD_ID NEW_ID SOURCE_DIR SOURCE_SHA DETECTOR_SHA256 RECOVERY_CORE_SHA256 DETECTOR_UNIT_SHA256 RESTORE_CLI_SHA256 — the reviewed tool's READ-ONLY `check` (root read authority through $SUDO):
# `current` is exactly OLD, OLD passes the release guard, the NEW release is ABSENT, the builder output passes the guard and is EXACTLY OLD + cli.py (machine equivalence), the Core runs from OLD and is healthy, the
# detector is the baseline process (cwd = OLD) and the Recovery/alert sockets are served by the Core process. If the privileged read cannot be performed the gate fails (ROOT_READ_UNAVAILABLE).
rru_preflight_gate() {
  local py=${1:-} tool=${2:-} old=${3:-} new=${4:-} src_dir=${5:-} src=${6:-} det=${7:-} core=${8:-} unit=${9:-} cli=${10:-} out reason
  if ! out=$($SUDO env PYTHONDONTWRITEBYTECODE=1 "$py" "$tool" check --old-release-id "$old" --new-release-id "$new" --source-dir "$src_dir" --source-sha "$src" --detector-sha256 "$det" \
      --recovery-core-sha256 "$core" --detector-unit-sha256 "$unit" --restore-cli-sha256 "$cli" 2>&1); then
    reason=$(printf '%s\n' "$out" | sed -n 's/.*reason=\([^ ]*\).*/\1/p' | tail -n 1)
    rru_reason "RRU_PREFLIGHT_FAILED:${reason:-ROOT_READ_UNAVAILABLE}"; return 1
  fi
}

# rru_detector_running_gate — the detector is running as the pre-existing unit with the reviewed contract (shell re-check, independent of the tool): active/running, disabled, Restart=no, NRestarts 0, a positive MainPID,
# exactly one detector process. Read-only; prints nothing but a reason.
rru_detector_running_gate() {
  local out pid
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState -p Restart "$RRU_DETECTOR_UNIT" 2>/dev/null) || { rru_reason "RRU_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" \
    && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || { rru_reason "RRU_DETECTOR_NOT_RUNNING_AS_EXPECTED"; return 1; }
  [ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || { rru_reason "RRU_DETECTOR_PROCESS_SET_UNEXPECTED"; return 1; }
}

# rru_unit_snapshot_gate UNIT PID/NRESTARTS — the unit is the SAME running process (active/running, MainPID and NRestarts exactly as snapshotted). RRu restarts NOTHING, so this holds for the Core AND the detector
# before the attempt, after the apply and after a rollback. Read-only.
rru_unit_snapshot_gate() {
  local unit=${1:-} want=${2:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$unit" 2>/dev/null) || { rru_reason "RRU_UNIT_STATE_UNREADABLE:$unit"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [ "$pid/$nr" = "$want" ] \
    || { rru_reason "RRU_UNIT_DRIFT:$unit (expected $want, saw ${pid:-?}/${nr:-?}, or not active/running)"; return 1; }
}

# rru_current_transition_gate PRE_DIR POST_DIR OLD_PATH NEW_PATH — in the captured bundles the `current` target is EXACTLY the OLD path before and EXACTLY the NEW path after.
rru_current_transition_gate() {
  local pre=${1:-} post=${2:-} old=${3:-} new=${4:-} a b
  a=$(awk -F'\t' -v k="$RRU_CURRENT_KEY" '$1 == k { print $2 }' "$pre/host.tsv" 2>/dev/null)
  b=$(awk -F'\t' -v k="$RRU_CURRENT_KEY" '$1 == k { print $2 }' "$post/host.tsv" 2>/dev/null)
  { [ -n "$old" ] && [ -n "$new" ] && [ "$a" = "$old" ] && [ "$b" = "$new" ]; } \
    || { rru_reason "RRU_CURRENT_TRANSITION_NOT_EXACT (pre='${a:-MISSING}' post='${b:-MISSING}')"; return 1; }
}

# rru_catalog_transition_gate PRE_DIR POST_DIR RELEASE_ID TREE_DIGEST — the captured release catalog is EXACTLY the PRE catalog plus ONE entry `<RELEASE_ID>:<TREE_DIGEST>` (the journaled tree digest). Relational, never a
# wildcard: any other addition, a removed or mutated entry, or a different digest fails.
rru_catalog_transition_gate() {
  f1i_catalog_transition_gate "$@" 2> >(sed 's/^F1I_/RRU_/' >&2)
}

RRU_CORE_CWD_KEY="host.aegis_idea3.recovery.core.runtime_cwd"
RRU_DETECTOR_CWD_KEY="host.aegis_idea3.alert.detector.runtime_cwd"
_rru_record() { awk -F'\t' -v k="$2" '$1 == k { print $2 }' "$1/host.tsv" 2>/dev/null; }

# rru_runtime_unchanged_gate PRE_DIR OTHER_DIR OLD_PATH — the CAPTURED running-process release identity of the Core AND the detector is exactly OLD_PATH in BOTH bundles (RRu restarts nothing: neither the process nor the
# release it runs from may change). `current` is never read here: the pointer proves nothing about the running release.
rru_runtime_unchanged_gate() {
  local pre=${1:-} other=${2:-} old=${3:-} a b c d
  a=$(_rru_record "$pre" "$RRU_CORE_CWD_KEY"); b=$(_rru_record "$other" "$RRU_CORE_CWD_KEY")
  c=$(_rru_record "$pre" "$RRU_DETECTOR_CWD_KEY"); d=$(_rru_record "$other" "$RRU_DETECTOR_CWD_KEY")
  { [ -n "$old" ] && [ "$a" = "$old" ] && [ "$b" = "$old" ] && [ "$c" = "$old" ] && [ "$d" = "$old" ]; } \
    || { rru_reason "RRU_RUNTIME_RELEASE_CHANGED (core pre='${a:-MISSING}' now='${b:-MISSING}', detector pre='${c:-MISSING}' now='${d:-MISSING}'; expected '$old')"; return 1; }
}

# rru_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines; a PASS additionally declares the only class RRu can have (EXACT_PROCESS: nothing was ever restarted).
rru_rollback_output_gate() {
  local out=${1:-}
  grep -qxE 'RRU_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "$out" || { rru_reason "RRU_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
  if grep -qx 'RRU_ROLLBACK=PASS' <<< "$out"; then
    grep -qx 'RRU_ROLLBACK_CLASS=EXACT_PROCESS' <<< "$out" && grep -qx 'CORE_RESTARTED_FOR_ROLLBACK=NO' <<< "$out" || { rru_reason "RRU_ROLLBACK_CLASS_INCONSISTENT"; return 1; }
  fi
}
