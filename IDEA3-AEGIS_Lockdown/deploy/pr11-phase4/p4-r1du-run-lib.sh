#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1Du (governed Core upgrade carrying the R1D historical-disposition authority: ONE new release, current OLD -> NEW, the dedicated R1D channel ARMED by one exact core.env line, ONE Core restart, the detector cycled by systemd as the owner-approved F1u consequence) owner-run gate library (sourced by the external frozen
# owner runner; nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Every function returns 0 on PASS; on FAIL it
# prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them; SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file reads,
# `systemctl show`, `pgrep` and the read-only `check` of p4-r1du-upgrade.py.
# R1Du owns its OWN one-attempt marker (R1DU-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=R1Du, no extra field). It reuses the F1i/F1r/F1/L8p/L7u gates. It never touches an incident, the audit
# DB or Recovery state, never runs R1D, never injects an alert and never claims real detector acceptance, Recovery R2-R8, LVR, L8 or L9.

: "${SUDO=sudo}"
_R1DU_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1i-run-lib.sh
. "$_R1DU_LIB_DIR/p4-f1i-run-lib.sh"

R1DU_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1DU_F1_CLOSEOUT_RECEIPT_REL="$R1DU_LOGS_REL/2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md"
R1DU_R1_FOUNDATION_RECEIPT_REL="$R1DU_LOGS_REL/2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md"
R1DU_F1U_CLOSEOUT_RECEIPT_REL="$R1DU_LOGS_REL/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1DU_R1I_CLOSEOUT_RECEIPT_REL="$R1DU_LOGS_REL/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1DU_R1A_FAILURE_CLOSEOUT_RECEIPT_REL="$R1DU_LOGS_REL/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1DU_CURRENT_KEY="host.symlink./opt/aegis-idea3/current.target"
R1DU_CORE_UNIT=aegis-idea3-core.service
R1DU_DETECTOR_UNIT=aegis-idea3-detector.service
R1DU_APP_REL="IDEA3-AEGIS_Lockdown"

r1du_reason() { printf '%s\n' "$1" >&2; return 1; }

# r1du_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one R1Du attempt.
r1du_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1du_reason "R1DU_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/R1DU-ATTEMPT-CONSUMED" ] || { r1du_reason "R1DU_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# r1du_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails closed even if the first attempt failed. The
# marker name is distinct from every other stage (F1I, F1R, F1, L7U, L8p…), so none of their markers ever authorizes R1Du and R1Du never consumes theirs.
r1du_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { r1du_reason "R1DU_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/R1DU-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  r1du_reason "R1DU_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# _r1du_only_receipt REPO CANONICAL_REL LABEL FIELD=VALUE... — exactly ONE status-log receipt of the PINNED commit carries ALL the whole-line fields, and it is the canonical receipt path. Zero, several, a
# split set of fields across receipts, or a different file all refuse. Read from the pinned commit, never the working tree.
_r1du_only_receipt() {
  local repo=$1 canonical=$2 label=$3 shift_n=3 pair files="" part
  shift "$shift_n"
  for pair in "$@"; do
    part=$(l8p_result_field_files "$repo" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || { r1du_reason "R1DU_${label}_NOT_CLOSED (no receipt carries ${pair})"; return 1; }
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || { r1du_reason "R1DU_${label}_FIELDS_SPLIT_ACROSS_RECEIPTS"; return 1; }
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] || { r1du_reason "R1DU_${label}_RESULT_NOT_UNIQUE"; return 1; }
  [ "${files#HEAD:}" = "$canonical" ] || { r1du_reason "R1DU_${label}_RESULT_NOT_IN_CANONICAL_RECEIPT"; return 1; }
}

# r1du_receipt_gate REPO — R1Du is allowed only after the successful F1 attempt #2 closeout, the PR #342 foundation, the F1u deployment closeout (unique canonical receipt), the R1I LIVE closeout and the
# immutable R1A failure closeout (ONE canonical receipt each, whole-line fields, read from the pinned commit), with NO contradictory live claim anywhere (real detector acceptance / R1 verified / Recovery
# R1-R8 proven / an R1A pass), and only while R1Du itself is not already recorded. A repository-only record that says NO never satisfies any of these.
r1du_receipt_gate() {
  local repo=${1:-} f1
  [ -n "$repo" ] || { r1du_reason "R1DU_REPO_REQUIRED"; return 1; }
  _r1du_only_receipt "$repo" "$R1DU_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES || return 1
  _r1du_only_receipt "$repo" "$R1DU_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED || return 1
  # F1u closeout: ONE canonical receipt of the pinned commit (prose receipt; deployment-only boundary)
  git -C "$repo" cat-file -e "HEAD:$R1DU_F1U_CLOSEOUT_RECEIPT_REL" 2>/dev/null || { r1du_reason "R1DU_F1U_CLOSEOUT_MISSING"; return 1; }
  git -C "$repo" grep -q "installed and activated" HEAD -- "$R1DU_F1U_CLOSEOUT_RECEIPT_REL" && git -C "$repo" grep -q "F1u proves deployment only" HEAD -- "$R1DU_F1U_CLOSEOUT_RECEIPT_REL" \
    || { r1du_reason "R1DU_F1U_CLOSEOUT_NOT_THE_DEPLOYMENT_CLOSEOUT"; return 1; }
  _r1du_only_receipt "$repo" "$R1DU_R1I_CLOSEOUT_RECEIPT_REL" R1I_CLOSEOUT R1I_LIVE=CLOSED_PASS R1I_LIVE_EXECUTED=YES R1I_ATTEMPT_CONSUMED=YES R1I_RERUN_ALLOWED=NO || return 1
  _r1du_only_receipt "$repo" "$R1DU_R1A_FAILURE_CLOSEOUT_RECEIPT_REL" R1A_FAILURE_CLOSEOUT R1A_LIVE_EXECUTED=YES R1A_ATTEMPT_CONSUMED=YES R1A_RERUN_ALLOWED=NO R1A_RESULT=FAIL \
    R1A_STAGE_VERIFY=NOT_REACHED F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R2_R8_EXECUTED=NO || return 1
  for f1 in F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED RECOVERY_R1_R8_PROVEN=YES F1_PRODUCTION_DEPLOYED=NO F1_LIVE_RESULT=FAIL R1A_LIVE=CLOSED_PASS R1D_LIVE_EXECUTED=YES R1B_LIVE_EXECUTED=YES RECOVERY_R2_R8_EXECUTED=YES; do
    [ -z "$(l8p_result_field_files "$repo" "${f1%%=*}" "${f1#*=}")" ] || { r1du_reason "R1DU_CONTRADICTORY_CLAIM (a receipt carries ${f1})"; return 1; }
  done
  [ -z "$(comm -12 <(l8p_result_field_files "$repo" R1DU_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" R1DU_PRODUCTION_DEPLOYED YES))" ] \
    || { r1du_reason "R1DU_ALREADY_EXECUTED (an R1Du result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# r1du_runtime_source_gate REPO DETECTOR_SHA256 RECOVERY_CORE_SHA256 — the frozen digests are exactly the REVIEWED bytes of the PINNED commit (git object, never the working tree): production_detector.py (the
# byte-identical detector the F1 deployment started) and recovery_core.py, which must carry the PR #342 ALERT_ACCEPTED implementation. Read-only.
r1du_runtime_source_gate() {
  local repo=${1:-} det=${2:-} core=${3:-} got
  [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { r1du_reason "R1DU_DETECTOR_PIN_INVALID"; return 1; }
  [[ "$core" =~ ^[0-9a-f]{64}$ ]] || { r1du_reason "R1DU_RECOVERY_CORE_PIN_INVALID"; return 1; }
  got=$(git -C "$repo" show "HEAD:$R1DU_APP_REL/aegis_soc/production_detector.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$det" ] || { r1du_reason "R1DU_DETECTOR_SOURCE_DIGEST_MISMATCH (the detector pin is not the reviewed source at the pinned main)"; return 1; }
  got=$(git -C "$repo" show "HEAD:$R1DU_APP_REL/aegis_soc/recovery_core.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$core" ] || { r1du_reason "R1DU_RECOVERY_CORE_SOURCE_DIGEST_MISMATCH (the Core runtime pin is not the reviewed source at the pinned main)"; return 1; }
  git -C "$repo" show "HEAD:$R1DU_APP_REL/aegis_soc/recovery_core.py" 2>/dev/null | grep -q 'ALERT_ACCEPTED' || { r1du_reason "R1DU_ALERT_ACCEPTED_IMPLEMENTATION_MISSING"; return 1; }
}

# r1du_release_content_gate REPO SOURCE_DIR — every aegis_soc/ file the builder output lists in RELEASE-SHA256SUMS is byte-identical to the pinned commit's blob, so the release carries exactly the merged
# runtime (R1Du + PR #342) and nothing else. (The release guard separately proves SUMS matches the files.) Read-only.
r1du_release_content_gate() {
  local repo=${1:-} dir=${2:-} sums line digest rel want n=0
  sums="$dir/RELEASE-SHA256SUMS"
  [ -f "$sums" ] && [ ! -L "$sums" ] || { r1du_reason "R1DU_RELEASE_SUMS_MISSING"; return 1; }
  while IFS= read -r line; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ (aegis_soc/[A-Za-z0-9_./-]+)$ ]] || continue
    digest=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}
    want=$(git -C "$repo" show "HEAD:$R1DU_APP_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$want" = "$digest" ] || { r1du_reason "R1DU_RELEASE_CONTENT_MISMATCH:$rel"; return 1; }
    n=$((n + 1))
  done < "$sums"
  [ "$n" -ge 3 ] || { r1du_reason "R1DU_RELEASE_CONTENT_TOO_SMALL"; return 1; }
  grep -q "^[0-9a-f]\{64\}  aegis_soc/historical_disposition.py$" "$sums" || { r1du_reason "R1DU_R1D_DISPOSITION_AUTHORITY_NOT_IN_RELEASE"; return 1; }
}

# r1du_preflight_gate PY TOOL OLD_ID NEW_ID SOURCE_DIR SOURCE_SHA DETECTOR_SHA256 RECOVERY_CORE_SHA256 DETECTOR_UNIT_SHA256 — the reviewed tool's READ-ONLY `check` (root read authority through $SUDO): `current` is
# exactly OLD, OLD passes the release guard and carries the reviewed detector bytes, the NEW release is ABSENT, the builder output passes the guard with the exact id/source SHA/clean tree/detector digest and
# a recovery_core.py that equals the pin and carries ALERT_ACCEPTED, the Core is healthy (NRestarts 0), the detector is the F1 process D1 (running, disabled, Restart=no, reviewed unit digest, exactly one
# process, cwd = the OLD release), and the Recovery/alert sockets are served by the Core process. If the privileged read cannot be performed the gate fails (ROOT_READ_UNAVAILABLE).
r1du_preflight_gate() {
  local py=${1:-} tool=${2:-} old=${3:-} new=${4:-} src_dir=${5:-} src=${6:-} det=${7:-} core=${8:-} unit=${9:-} out reason
  if ! out=$($SUDO env PYTHONDONTWRITEBYTECODE=1 "$py" "$tool" check --old-release-id "$old" --new-release-id "$new" --source-dir "$src_dir" --source-sha "$src" --detector-sha256 "$det" \
      --recovery-core-sha256 "$core" --detector-unit-sha256 "$unit" 2>&1); then
    reason=$(printf '%s\n' "$out" | sed -n 's/.*reason=\([^ ]*\).*/\1/p' | tail -n 1)
    r1du_reason "R1DU_PREFLIGHT_FAILED:${reason:-ROOT_READ_UNAVAILABLE}"; return 1
  fi
}

# r1du_detector_running_gate — the F1 detector is running as the pre-existing unit with the reviewed contract (shell re-check, independent of the tool): active/running, disabled, Restart=no, NRestarts 0, a positive MainPID,
# exactly one detector process. Read-only; prints nothing but a reason.
r1du_detector_running_gate() {
  local out pid
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState -p Restart "$R1DU_DETECTOR_UNIT" 2>/dev/null) || { r1du_reason "R1DU_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" \
    && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || { r1du_reason "R1DU_DETECTOR_NOT_RUNNING_AS_EXPECTED"; return 1; }
  [ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || { r1du_reason "R1DU_DETECTOR_PROCESS_SET_UNEXPECTED"; return 1; }
}

# r1du_detector_snapshot_gate PID/NRESTARTS — the detector is the SAME running process (active/running, MainPID and NRestarts exactly as snapshotted). Read-only.
r1du_detector_snapshot_gate() {
  local want=${1:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$R1DU_DETECTOR_UNIT" 2>/dev/null) || { r1du_reason "R1DU_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [ "$pid/$nr" = "$want" ] \
    || { r1du_reason "R1DU_DETECTOR_DRIFT (expected $want, saw ${pid:-?}/${nr:-?}, or not active/running)"; return 1; }
}

# r1du_detector_cycled_gate PRE_PID/PRE_NRESTARTS — after apply: the detector is active/running on a DIFFERENT positive MainPID (systemd restarted it as the Requires= consequence of the Core restart; R1Du never
# commanded it), still disabled with Restart=no and NRestarts 0 (a sanity value only, never lifecycle evidence), and exactly one detector process exists. Read-only.
r1du_detector_cycled_gate() {
  local want=${1:-} out pid
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState -p Restart "$R1DU_DETECTOR_UNIT" 2>/dev/null) || { r1du_reason "R1DU_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" \
    && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" != "${want%%/*}" ] \
    || { r1du_reason "R1DU_DETECTOR_NOT_CYCLED_CLEANLY (pre $want, saw ${pid:-?}, or not active/running/disabled/Restart=no)"; return 1; }
  [ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || { r1du_reason "R1DU_DETECTOR_PROCESS_SET_UNEXPECTED"; return 1; }
}

# r1du_core_restarted_gate PRE_PID/PRE_NRESTARTS — after apply: the Core is active/running on a DIFFERENT positive MainPID and NRestarts is still 0 (one manual restart; no restart loop). Read-only.
r1du_core_restarted_gate() {
  local want=${1:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$R1DU_CORE_UNIT" 2>/dev/null) || { r1du_reason "R1DU_CORE_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" != "${want%%/*}" ] && [ "$nr" = 0 ] \
    || { r1du_reason "R1DU_CORE_NOT_RESTARTED_ONCE_CLEANLY (pre $want, saw ${pid:-?}/${nr:-?})"; return 1; }
}

# r1du_current_transition_gate PRE_DIR POST_DIR OLD_PATH NEW_PATH — in the captured bundles the `current` target is EXACTLY the OLD path before and EXACTLY the NEW path after.
r1du_current_transition_gate() {
  local pre=${1:-} post=${2:-} old=${3:-} new=${4:-} a b
  a=$(awk -F'\t' -v k="$R1DU_CURRENT_KEY" '$1 == k { print $2 }' "$pre/host.tsv" 2>/dev/null)
  b=$(awk -F'\t' -v k="$R1DU_CURRENT_KEY" '$1 == k { print $2 }' "$post/host.tsv" 2>/dev/null)
  { [ -n "$old" ] && [ -n "$new" ] && [ "$a" = "$old" ] && [ "$b" = "$new" ]; } \
    || { r1du_reason "R1DU_CURRENT_TRANSITION_NOT_EXACT (pre='${a:-MISSING}' post='${b:-MISSING}')"; return 1; }
}

# r1du_catalog_transition_gate PRE_DIR POST_DIR RELEASE_ID TREE_DIGEST — the captured release catalog is EXACTLY the PRE catalog plus ONE entry `<RELEASE_ID>:<TREE_DIGEST>` (the journaled tree digest). Relational,
# never a wildcard: any other addition, a removed or mutated entry, or a different digest fails.
r1du_catalog_transition_gate() {
  f1i_catalog_transition_gate "$@" 2> >(sed 's/^F1I_/R1DU_/' >&2)
}

R1DU_CORE_CWD_KEY="host.aegis_idea3.recovery.core.runtime_cwd"
R1DU_DETECTOR_CWD_KEY="host.aegis_idea3.alert.detector.runtime_cwd"
_r1du_record() { awk -F'\t' -v k="$2" '$1 == k { print $2 }' "$1/host.tsv" 2>/dev/null; }
_r1du_real_path() { [[ "${1:-}" =~ ^/opt/aegis-idea3/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }

# r1du_core_runtime_gate PRE_DIR POST_DIR NEW_PATH — the CAPTURED running-process identity: the PRE Core and PRE detector run from a real release that is NOT the NEW one, and after apply BOTH run from exactly
# NEW_PATH. `current` is never read here: the pointer proves nothing about the running release.
r1du_core_runtime_gate() {
  local pre=${1:-} post=${2:-} new=${3:-} a b c d
  a=$(_r1du_record "$pre" "$R1DU_CORE_CWD_KEY"); b=$(_r1du_record "$post" "$R1DU_CORE_CWD_KEY")
  c=$(_r1du_record "$pre" "$R1DU_DETECTOR_CWD_KEY"); d=$(_r1du_record "$post" "$R1DU_DETECTOR_CWD_KEY")
  { _r1du_real_path "$a" && _r1du_real_path "$c" && [ "$a" != "$new" ] && [ "$c" != "$new" ] && [ "$b" = "$new" ] && [ "$d" = "$new" ]; } \
    || { r1du_reason "R1DU_RUNTIME_RELEASE_NOT_PROVEN (core pre='${a:-MISSING}' post='${b:-MISSING}', detector pre='${c:-MISSING}' post='${d:-MISSING}')"; return 1; }
}

# r1du_rollback_class OUTPUT — prints the rollback class a PASS output declared (EXACT_PROCESS | EXACT_RELEASE | SAFE_EQUIVALENT), consistent with its exactness claim; a PASS without one refuses.
r1du_rollback_class() {
  local out=${1:-} cls
  cls=$(sed -n 's/^R1DU_ROLLBACK_CLASS=//p' <<< "$out" | head -n 1)
  case "$cls" in
    EXACT_PROCESS) grep -qx 'R1DU_ROLLBACK_EXACT_PRE_RESTORATION=YES' <<< "$out" && grep -qx 'CORE_RUNTIME_EQUIVALENCE=NOT_APPLICABLE' <<< "$out" || { r1du_reason "R1DU_ROLLBACK_CLASS_INCONSISTENT"; return 1; } ;;
    EXACT_RELEASE) grep -qx 'R1DU_ROLLBACK_EXACT_PRE_RESTORATION=NO' <<< "$out" && grep -qx 'CORE_RUNTIME_EQUIVALENCE=NOT_APPLICABLE' <<< "$out" || { r1du_reason "R1DU_ROLLBACK_CLASS_INCONSISTENT"; return 1; } ;;
    SAFE_EQUIVALENT) grep -qx 'R1DU_ROLLBACK_EXACT_PRE_RESTORATION=NO' <<< "$out" && grep -qx 'CORE_RUNTIME_EQUIVALENCE=PROVEN' <<< "$out" || { r1du_reason "R1DU_ROLLBACK_CLASS_INCONSISTENT"; return 1; } ;;
    *) r1du_reason "R1DU_ROLLBACK_CLASS_MISSING"; return 1 ;;
  esac
  printf '%s\n' "$cls"
}

# r1du_runtime_transition_gate PRE_DIR RB_DIR CLASS OLD_PATH — after a rollback the CAPTURED Core release identity is exactly what the declared class says: EXACT_PROCESS / EXACT_RELEASE => identical to PRE;
# SAFE_EQUIVALENT => PRE was a real release, RB is exactly OLD_PATH and they are different (an honest, never invisible, transition). Anything else fails.
r1du_runtime_transition_gate() {
  local pre=${1:-} rb=${2:-} cls=${3:-} old=${4:-} a b
  a=$(_r1du_record "$pre" "$R1DU_CORE_CWD_KEY"); b=$(_r1du_record "$rb" "$R1DU_CORE_CWD_KEY")
  _r1du_real_path "$a" && _r1du_real_path "$b" || { r1du_reason "R1DU_RUNTIME_TRANSITION_NOT_PROVEN (pre='${a:-MISSING}' rb='${b:-MISSING}')"; return 1; }
  case "$cls" in
    EXACT_PROCESS | EXACT_RELEASE) [ "$a" = "$b" ] || { r1du_reason "R1DU_RUNTIME_TRANSITION_NOT_EXACT ($cls but pre='$a' rb='$b')"; return 1; } ;;
    SAFE_EQUIVALENT) { [ "$a" != "$b" ] && [ "$b" = "$old" ]; } || { r1du_reason "R1DU_RUNTIME_TRANSITION_NOT_EXACT (SAFE_EQUIVALENT but pre='$a' rb='$b')"; return 1; } ;;
    *) r1du_reason "R1DU_RUNTIME_TRANSITION_CLASS_INVALID"; return 1 ;;
  esac
}

# r1du_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines (a PASS additionally declares its class: see r1du_rollback_class).
r1du_rollback_output_gate() {
  grep -qxE 'R1DU_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "${1:-}" || { r1du_reason "R1DU_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
}
