#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1u (governed post-F1 Core upgrade: ONE new release, current OLD -> NEW, ONE Core restart, the detector cycled by systemd as the owner-approved consequence: OPTION A) owner-run gate library (sourced by the external frozen
# owner runner; nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Every function returns 0 on PASS; on FAIL it
# prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them; SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file reads,
# `systemctl show`, `pgrep` and the read-only `check` of p4-f1u-upgrade.py.
# F1u owns its OWN one-attempt marker (F1U-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=F1u, no extra field). It reuses the F1i/F1r/F1/L8p/L7u gates (receipt-field lookup,
# catalog transition, Core running baseline, IDEA2 §10, disk headroom, evidence secret scan). It never reuses a consumed F1/F1i/F1r/L8p record or attempt, never addresses the detector unit (zero explicit detector commands), never injects an
# alert and never claims real detector acceptance (R1A), Recovery R2-R8, LVR, L8 or L9.

: "${SUDO=sudo}"
_F1U_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1i-run-lib.sh
. "$_F1U_LIB_DIR/p4-f1i-run-lib.sh"

F1U_LOGS_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
F1U_F1_CLOSEOUT_RECEIPT_REL="$F1U_LOGS_REL/2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md"
F1U_R1_FOUNDATION_RECEIPT_REL="$F1U_LOGS_REL/2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md"
F1U_CURRENT_KEY="host.symlink./opt/aegis-idea3/current.target"
F1U_CORE_UNIT=aegis-idea3-core.service
F1U_DETECTOR_UNIT=aegis-idea3-detector.service
F1U_APP_REL="IDEA3-AEGIS_Lockdown"

f1u_reason() { printf '%s\n' "$1" >&2; return 1; }

# f1u_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one F1u attempt.
f1u_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1u_reason "F1U_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/F1U-ATTEMPT-CONSUMED" ] || { f1u_reason "F1U_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# f1u_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails closed even if the first attempt failed. The
# marker name is distinct from every other stage (F1I, F1R, F1, L7U, L8p…), so none of their markers ever authorizes F1u and F1u never consumes theirs.
f1u_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1u_reason "F1U_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/F1U-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  f1u_reason "F1U_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# _f1u_only_receipt REPO CANONICAL_REL LABEL FIELD=VALUE... — exactly ONE status-log receipt of the PINNED commit carries ALL the whole-line fields, and it is the canonical receipt path. Zero, several, a
# split set of fields across receipts, or a different file all refuse. Read from the pinned commit, never the working tree.
_f1u_only_receipt() {
  local repo=$1 canonical=$2 label=$3 shift_n=3 pair files="" part
  shift "$shift_n"
  for pair in "$@"; do
    part=$(l8p_result_field_files "$repo" "${pair%%=*}" "${pair#*=}")
    [ -n "$part" ] || { f1u_reason "F1U_${label}_NOT_CLOSED (no receipt carries ${pair})"; return 1; }
    if [ -z "$files" ]; then files=$part; else files=$(comm -12 <(printf '%s\n' "$files") <(printf '%s\n' "$part")); fi
    [ -n "$files" ] || { f1u_reason "F1U_${label}_FIELDS_SPLIT_ACROSS_RECEIPTS"; return 1; }
  done
  [ "$(printf '%s\n' "$files" | wc -l)" = 1 ] || { f1u_reason "F1U_${label}_RESULT_NOT_UNIQUE"; return 1; }
  [ "${files#HEAD:}" = "$canonical" ] || { f1u_reason "F1U_${label}_RESULT_NOT_IN_CANONICAL_RECEIPT"; return 1; }
}

# f1u_receipt_gate REPO — F1u is allowed only after (A) the successful F1 attempt #2 closeout (ONE canonical receipt carrying F1_LIVE_RESULT=PASS, F1_PRODUCTION_DEPLOYED=YES and F1_DETECTOR_STARTED=YES)
# and (B) the merged PR #342 repository foundation (ONE canonical receipt carrying R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES, F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN and R1_VERIFIED=NOT_CLAIMED), with NO
# contradictory live claim anywhere in the status logs (a receipt already claiming real detector acceptance / R1 verified / Recovery R1-R8 proven means this stage's premise is stale: stop and
# re-decide), and only while F1u itself is not already recorded (one receipt carrying BOTH F1U_LIVE_EXECUTED=YES and F1U_PRODUCTION_DEPLOYED=YES makes it one-shot). A repository-only record that says NO
# never satisfies any of these. The PR number is deliberately not trusted: receipt CONTENT is.
f1u_receipt_gate() {
  local repo=${1:-} f1
  [ -n "$repo" ] || { f1u_reason "F1U_REPO_REQUIRED"; return 1; }
  _f1u_only_receipt "$repo" "$F1U_F1_CLOSEOUT_RECEIPT_REL" F1_CLOSEOUT F1_LIVE_RESULT=PASS F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES || return 1
  _f1u_only_receipt "$repo" "$F1U_R1_FOUNDATION_RECEIPT_REL" R1_FOUNDATION R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED || return 1
  for f1 in F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED RECOVERY_R1_R8_PROVEN=YES F1_PRODUCTION_DEPLOYED=NO F1_LIVE_RESULT=FAIL; do
    [ -z "$(l8p_result_field_files "$repo" "${f1%%=*}" "${f1#*=}")" ] || { f1u_reason "F1U_CONTRADICTORY_CLAIM (a receipt carries ${f1})"; return 1; }
  done
  [ -z "$(comm -12 <(l8p_result_field_files "$repo" F1U_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" F1U_PRODUCTION_DEPLOYED YES))" ] \
    || { f1u_reason "F1U_ALREADY_EXECUTED (an F1u result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# f1u_runtime_source_gate REPO DETECTOR_SHA256 RECOVERY_CORE_SHA256 — the frozen digests are exactly the REVIEWED bytes of the PINNED commit (git object, never the working tree): production_detector.py (the
# byte-identical detector the F1 deployment started) and recovery_core.py, which must carry the PR #342 ALERT_ACCEPTED implementation. Read-only.
f1u_runtime_source_gate() {
  local repo=${1:-} det=${2:-} core=${3:-} got
  [[ "$det" =~ ^[0-9a-f]{64}$ ]] || { f1u_reason "F1U_DETECTOR_PIN_INVALID"; return 1; }
  [[ "$core" =~ ^[0-9a-f]{64}$ ]] || { f1u_reason "F1U_RECOVERY_CORE_PIN_INVALID"; return 1; }
  got=$(git -C "$repo" show "HEAD:$F1U_APP_REL/aegis_soc/production_detector.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$det" ] || { f1u_reason "F1U_DETECTOR_SOURCE_DIGEST_MISMATCH (the detector pin is not the reviewed source at the pinned main)"; return 1; }
  got=$(git -C "$repo" show "HEAD:$F1U_APP_REL/aegis_soc/recovery_core.py" 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$got" = "$core" ] || { f1u_reason "F1U_RECOVERY_CORE_SOURCE_DIGEST_MISMATCH (the Core runtime pin is not the reviewed source at the pinned main)"; return 1; }
  git -C "$repo" show "HEAD:$F1U_APP_REL/aegis_soc/recovery_core.py" 2>/dev/null | grep -q 'ALERT_ACCEPTED' || { f1u_reason "F1U_ALERT_ACCEPTED_IMPLEMENTATION_MISSING"; return 1; }
}

# f1u_release_content_gate REPO SOURCE_DIR — every aegis_soc/ file the builder output lists in RELEASE-SHA256SUMS is byte-identical to the pinned commit's blob, so the release carries exactly the merged
# runtime (F1u + PR #342) and nothing else. (The release guard separately proves SUMS matches the files.) Read-only.
f1u_release_content_gate() {
  local repo=${1:-} dir=${2:-} sums line digest rel want n=0
  sums="$dir/RELEASE-SHA256SUMS"
  [ -f "$sums" ] && [ ! -L "$sums" ] || { f1u_reason "F1U_RELEASE_SUMS_MISSING"; return 1; }
  while IFS= read -r line; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ (aegis_soc/[A-Za-z0-9_./-]+)$ ]] || continue
    digest=${BASH_REMATCH[1]}; rel=${BASH_REMATCH[2]}
    want=$(git -C "$repo" show "HEAD:$F1U_APP_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$want" = "$digest" ] || { f1u_reason "F1U_RELEASE_CONTENT_MISMATCH:$rel"; return 1; }
    n=$((n + 1))
  done < "$sums"
  [ "$n" -ge 3 ] || { f1u_reason "F1U_RELEASE_CONTENT_TOO_SMALL"; return 1; }
}

# f1u_preflight_gate PY TOOL OLD_ID NEW_ID SOURCE_DIR SOURCE_SHA DETECTOR_SHA256 RECOVERY_CORE_SHA256 DETECTOR_UNIT_SHA256 — the reviewed tool's READ-ONLY `check` (root read authority through $SUDO): `current` is
# exactly OLD, OLD passes the release guard and carries the reviewed detector bytes, the NEW release is ABSENT, the builder output passes the guard with the exact id/source SHA/clean tree/detector digest and
# a recovery_core.py that equals the pin and carries ALERT_ACCEPTED, the Core is healthy (NRestarts 0), the detector is the F1 process D1 (running, disabled, Restart=no, reviewed unit digest, exactly one
# process, cwd = the OLD release), and the Recovery/alert sockets are served by the Core process. If the privileged read cannot be performed the gate fails (ROOT_READ_UNAVAILABLE).
f1u_preflight_gate() {
  local py=${1:-} tool=${2:-} old=${3:-} new=${4:-} src_dir=${5:-} src=${6:-} det=${7:-} core=${8:-} unit=${9:-} out reason
  if ! out=$($SUDO env PYTHONDONTWRITEBYTECODE=1 "$py" "$tool" check --old-release-id "$old" --new-release-id "$new" --source-dir "$src_dir" --source-sha "$src" --detector-sha256 "$det" \
      --recovery-core-sha256 "$core" --detector-unit-sha256 "$unit" 2>&1); then
    reason=$(printf '%s\n' "$out" | sed -n 's/.*reason=\([^ ]*\).*/\1/p' | tail -n 1)
    f1u_reason "F1U_PREFLIGHT_FAILED:${reason:-ROOT_READ_UNAVAILABLE}"; return 1
  fi
}

# f1u_detector_running_gate — the F1 detector is running as the pre-existing unit with the reviewed contract (shell re-check, independent of the tool): active/running, disabled, Restart=no, NRestarts 0, a positive MainPID,
# exactly one detector process. Read-only; prints nothing but a reason.
f1u_detector_running_gate() {
  local out pid
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState -p Restart "$F1U_DETECTOR_UNIT" 2>/dev/null) || { f1u_reason "F1U_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" \
    && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || { f1u_reason "F1U_DETECTOR_NOT_RUNNING_AS_EXPECTED"; return 1; }
  [ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || { f1u_reason "F1U_DETECTOR_PROCESS_SET_UNEXPECTED"; return 1; }
}

# f1u_detector_snapshot_gate PID/NRESTARTS — the detector is the SAME running process (active/running, MainPID and NRestarts exactly as snapshotted). Read-only.
f1u_detector_snapshot_gate() {
  local want=${1:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$F1U_DETECTOR_UNIT" 2>/dev/null) || { f1u_reason "F1U_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [ "$pid/$nr" = "$want" ] \
    || { f1u_reason "F1U_DETECTOR_DRIFT (expected $want, saw ${pid:-?}/${nr:-?}, or not active/running)"; return 1; }
}

# f1u_detector_cycled_gate PRE_PID/PRE_NRESTARTS — after apply: the detector is active/running on a DIFFERENT positive MainPID (systemd restarted it as the Requires= consequence of the Core restart; F1u never
# commanded it), still disabled with Restart=no and NRestarts 0 (a sanity value only, never lifecycle evidence), and exactly one detector process exists. Read-only.
f1u_detector_cycled_gate() {
  local want=${1:-} out pid
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState -p Restart "$F1U_DETECTOR_UNIT" 2>/dev/null) || { f1u_reason "F1U_DETECTOR_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && grep -qx 'NRestarts=0' <<< "$out" \
    && grep -qx 'UnitFileState=disabled' <<< "$out" && grep -qx 'Restart=no' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" != "${want%%/*}" ] \
    || { f1u_reason "F1U_DETECTOR_NOT_CYCLED_CLEANLY (pre $want, saw ${pid:-?}, or not active/running/disabled/Restart=no)"; return 1; }
  [ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || { f1u_reason "F1U_DETECTOR_PROCESS_SET_UNEXPECTED"; return 1; }
}

# f1u_core_restarted_gate PRE_PID/PRE_NRESTARTS — after apply: the Core is active/running on a DIFFERENT positive MainPID and NRestarts is still 0 (one manual restart; no restart loop). Read-only.
f1u_core_restarted_gate() {
  local want=${1:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$F1U_CORE_UNIT" 2>/dev/null) || { f1u_reason "F1U_CORE_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" != "${want%%/*}" ] && [ "$nr" = 0 ] \
    || { f1u_reason "F1U_CORE_NOT_RESTARTED_ONCE_CLEANLY (pre $want, saw ${pid:-?}/${nr:-?})"; return 1; }
}

# f1u_current_transition_gate PRE_DIR POST_DIR OLD_PATH NEW_PATH — in the captured bundles the `current` target is EXACTLY the OLD path before and EXACTLY the NEW path after.
f1u_current_transition_gate() {
  local pre=${1:-} post=${2:-} old=${3:-} new=${4:-} a b
  a=$(awk -F'\t' -v k="$F1U_CURRENT_KEY" '$1 == k { print $2 }' "$pre/host.tsv" 2>/dev/null)
  b=$(awk -F'\t' -v k="$F1U_CURRENT_KEY" '$1 == k { print $2 }' "$post/host.tsv" 2>/dev/null)
  { [ -n "$old" ] && [ -n "$new" ] && [ "$a" = "$old" ] && [ "$b" = "$new" ]; } \
    || { f1u_reason "F1U_CURRENT_TRANSITION_NOT_EXACT (pre='${a:-MISSING}' post='${b:-MISSING}')"; return 1; }
}

# f1u_catalog_transition_gate PRE_DIR POST_DIR RELEASE_ID TREE_DIGEST — the captured release catalog is EXACTLY the PRE catalog plus ONE entry `<RELEASE_ID>:<TREE_DIGEST>` (the journaled tree digest). Relational,
# never a wildcard: any other addition, a removed or mutated entry, or a different digest fails.
f1u_catalog_transition_gate() {
  f1i_catalog_transition_gate "$@" 2> >(sed 's/^F1I_/F1U_/' >&2)
}

# f1u_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines.
f1u_rollback_output_gate() {
  grep -qxE 'F1U_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "${1:-}" || { f1u_reason "F1U_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
}
