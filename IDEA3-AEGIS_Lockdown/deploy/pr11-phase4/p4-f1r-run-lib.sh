#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1r (governed current-release activation, NO Core restart) owner-run gate library (sourced by the external frozen owner runner;
# nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories.
# Every function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them;
# SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file reads, `systemctl show` and the read-only `check` of p4-f1r-switch.py.
# F1r owns its OWN one-attempt marker (F1R-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=F1r, no extra field); it reuses the L8p/L7u gates
# (receipt-field lookup, Core running baseline, IDEA2 §10, disk headroom, evidence secret scan). It never installs a release (that is F1i), never restarts the Core,
# never starts the detector (F1) and never claims Recovery R1-R8, LVR, L8 or L9.

: "${SUDO=sudo}"
_F1R_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1-run-lib.sh
. "$_F1R_LIB_DIR/p4-f1-run-lib.sh"

F1R_CURRENT_KEY="host.symlink./opt/aegis-idea3/current.target"
F1R_CORE_UNIT=aegis-idea3-core.service

f1r_reason() { printf '%s\n' "$1" >&2; return 1; }

# f1r_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one F1r attempt.
f1r_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1r_reason "F1R_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/F1R-ATTEMPT-CONSUMED" ] || { f1r_reason "F1R_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# f1r_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails
# closed even if the first attempt failed. The marker name is distinct from every other stage (F1, L6C, L7U, L8p…), so none of them ever authorizes F1r.
f1r_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1r_reason "F1R_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/F1R-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  f1r_reason "F1R_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# f1r_receipt_gate REPO NEW_RELEASE_ID — F1r is allowed only AFTER L8p is closed AND the governed F1i install of THIS release is closed, and only while F1r itself is not already
# recorded as executed, proven by receipts read from the PINNED commit, never the working tree. L8p: the canonical closeout receipt carries BOTH whole-line fields. F1i: exactly
# ONE status-log receipt carries BOTH whole-line fields F1I_LIVE_EXECUTED=YES and F1I_RELEASE_INSTALLED=YES (split fields, duplicates and a missing receipt refuse) AND names the
# release it installed with the whole-line field F1I_RELEASE_ID=<NEW_RELEASE_ID> (a different or missing release id refuses). F1r: ONE receipt carrying BOTH F1R_LIVE_EXECUTED=YES and
# F1R_CURRENT_SWITCHED=YES makes it one-shot. A repository-only or rolled-back record that says NO never satisfies any of these. The runtime release pins stay as defense in depth.
f1r_receipt_gate() {
  local repo=${1:-} rid=${2:-} both f1i bound
  [ -n "$repo" ] || { f1r_reason "F1R_REPO_REQUIRED"; return 1; }
  [[ "$rid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { f1r_reason "F1R_RELEASE_ID_REQUIRED"; return 1; }
  both=$(comm -12 <(l8p_result_field_files "$repo" L8P_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" L8P_PROVISIONING PASS))
  [ -n "$both" ] || { f1r_reason "F1R_L8P_NOT_CLOSED (no receipt carries both L8P_LIVE_EXECUTED=YES and L8P_PROVISIONING=PASS)"; return 1; }
  [ "$(printf '%s\n' "$both" | wc -l)" = 1 ] || { f1r_reason "F1R_L8P_RESULT_NOT_UNIQUE"; return 1; }
  [ "${both#HEAD:}" = "$F1_L8P_CLOSEOUT_RECEIPT_REL" ] || { f1r_reason "F1R_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT"; return 1; }
  f1i=$(comm -12 <(l8p_result_field_files "$repo" F1I_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" F1I_RELEASE_INSTALLED YES))
  [ -n "$f1i" ] || { f1r_reason "F1R_F1I_NOT_CLOSED (no receipt carries both F1I_LIVE_EXECUTED=YES and F1I_RELEASE_INSTALLED=YES; F1r follows the governed F1i install)"; return 1; }
  [ "$(printf '%s\n' "$f1i" | wc -l)" = 1 ] || { f1r_reason "F1R_F1I_RESULT_NOT_UNIQUE"; return 1; }
  bound=$(l8p_result_field_files "$repo" F1I_RELEASE_ID "${rid//./\\.}")
  [ "$bound" = "$f1i" ] || { f1r_reason "F1R_F1I_RELEASE_ID_MISMATCH (the F1i receipt must name F1I_RELEASE_ID=$rid)"; return 1; }
  # the matching receipt must carry EXACTLY ONE whole-line F1I_RELEASE_ID field: a receipt that also names a different (or the same, twice) release id is ambiguous and refuses
  [ "$(git -C "$repo" show "$f1i" 2>/dev/null | grep -cE '^[[:space:]]*([-*][[:space:]]+)?`?F1I_RELEASE_ID[[:space:]]*=[[:space:]]*[^[:space:]`]+`?[[:space:]]*$')" = 1 ] \
    || { f1r_reason "F1R_F1I_RELEASE_ID_NOT_UNIQUE (the F1i receipt must carry exactly one F1I_RELEASE_ID line)"; return 1; }
  [ -z "$(comm -12 <(l8p_result_field_files "$repo" F1R_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" F1R_CURRENT_SWITCHED YES))" ] \
    || { f1r_reason "F1R_ALREADY_EXECUTED (an F1r result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# f1r_detector_source_gate REPO DETECTOR_SHA256 — ties the frozen detector digest pin to the REVIEWED source at the pinned main: the release's
# production_detector.py bytes must be exactly the bytes that were reviewed and merged, not merely a text that looks repaired. Read-only.
f1r_detector_source_gate() {
  local repo=${1:-} want=${2:-} got file
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { f1r_reason "F1R_DETECTOR_PIN_INVALID"; return 1; }
  file="$repo/IDEA3-AEGIS_Lockdown/aegis_soc/production_detector.py"
  [ -f "$file" ] && [ ! -L "$file" ] || { f1r_reason "F1R_DETECTOR_SOURCE_MISSING"; return 1; }
  got=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { f1r_reason "F1R_DETECTOR_SOURCE_DIGEST_MISMATCH (rebuild the release from the pinned main, or re-pin after review)"; return 1; }
}

# f1r_preflight_gate PY TOOL OLD_ID NEW_ID NEW_SOURCE_SHA NEW_DETECTOR_SHA256 — the reviewed tool's READ-ONLY `check`: `current` is exactly the OLD target, the
# OLD and NEW releases pass the existing release guard at --expect-owner root, the NEW release id/source SHA/clean tree/detector digest are exact, the detector
# is absent on BOTH surfaces (systemd unit and standalone process) and the Core is running. It needs ROOT READ authority (/opt/aegis-idea3 may be root-only and
# /proc must show every process), so it runs through $SUDO; it needs neither the live flag nor any write. If the privileged read cannot be performed the gate
# fails (ROOT_READ_UNAVAILABLE) — the owner runner then stops BEFORE the attempt is consumed. `sudo -v` alone only authenticates; it does not elevate this call.
f1r_preflight_gate() {
  local py=${1:-} tool=${2:-} old=${3:-} new=${4:-} src=${5:-} det=${6:-} out reason
  if ! out=$($SUDO env PYTHONDONTWRITEBYTECODE=1 "$py" "$tool" check --old-release-id "$old" --new-release-id "$new" --new-source-sha "$src" --new-detector-sha256 "$det" 2>&1); then
    reason=$(printf '%s\n' "$out" | sed -n 's/.*reason=\([^ ]*\).*/\1/p' | tail -n 1)
    f1r_reason "F1R_PREFLIGHT_FAILED:${reason:-ROOT_READ_UNAVAILABLE}"; return 1
  fi
}

# f1r_core_snapshot_gate PID/NRESTARTS — the Core is the SAME running process (active/running, MainPID and NRestarts exactly as snapshotted). Read-only.
f1r_core_snapshot_gate() {
  local want=${1:-} out pid nr
  out=$(systemctl show -p ActiveState -p SubState -p MainPID -p NRestarts "$F1R_CORE_UNIT" 2>/dev/null) || { f1r_reason "F1R_CORE_STATE_UNREADABLE"; return 1; }
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out"); nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" && [ "$pid/$nr" = "$want" ] \
    || { f1r_reason "F1R_CORE_DRIFT (expected $want, saw ${pid:-?}/${nr:-?}, or not active/running)"; return 1; }
}

# f1r_current_transition_gate PRE_DIR POST_DIR OLD_PATH NEW_PATH — the exact value-level proof the comparator's key approval cannot give: in the captured
# bundles the `current` target is EXACTLY the OLD path before and EXACTLY the NEW path after. Any other target, a removed link or no transition fails.
f1r_current_transition_gate() {
  local pre=${1:-} post=${2:-} old=${3:-} new=${4:-} a b
  a=$(awk -F'\t' -v k="$F1R_CURRENT_KEY" '$1 == k { print $2 }' "$pre/host.tsv" 2>/dev/null)
  b=$(awk -F'\t' -v k="$F1R_CURRENT_KEY" '$1 == k { print $2 }' "$post/host.tsv" 2>/dev/null)
  { [ -n "$old" ] && [ -n "$new" ] && [ "$a" = "$old" ] && [ "$b" = "$new" ]; } \
    || { f1r_reason "F1R_CURRENT_TRANSITION_NOT_EXACT (pre='${a:-MISSING}' post='${b:-MISSING}')"; return 1; }
}

# f1r_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines.
f1r_rollback_output_gate() {
  grep -qxE 'F1R_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "${1:-}" || { f1r_reason "F1R_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
}
