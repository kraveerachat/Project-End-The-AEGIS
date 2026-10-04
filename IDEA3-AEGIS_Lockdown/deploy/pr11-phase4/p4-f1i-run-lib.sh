#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1i (governed POST-L7 install of ONE repaired immutable release) owner-run gate library (sourced by the external frozen owner runner; nothing here runs
# on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Every function returns 0 on PASS; on FAIL it prints one
# `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them; SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file reads,
# `systemctl show` and the read-only `check` of p4-f1i-install.py.
# F1i owns its OWN one-attempt marker (F1I-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=F1i, no extra field); it reuses the F1r/F1/L8p/L7u gates (receipt-field
# lookup, detector-source digest gate, Core snapshot gate, detector-absent gate, Core running baseline, IDEA2 §10, disk headroom, evidence secret scan). A consumed L6c marker neither
# blocks nor authorizes F1i. It never touches `current`, never restarts the Core, never starts the detector and never claims Recovery R1-R8, LVR, L8 or L9.

: "${SUDO=sudo}"
_F1I_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-f1r-run-lib.sh
. "$_F1I_LIB_DIR/p4-f1r-run-lib.sh"

F1I_CATALOG_KEY="host.aegis_idea3.release_catalog"

f1i_reason() { printf '%s\n' "$1" >&2; return 1; }

# f1i_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one F1i attempt.
f1i_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1i_reason "F1I_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/F1I-ATTEMPT-CONSUMED" ] || { f1i_reason "F1I_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# f1i_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails closed even if the first
# attempt failed. The marker name is distinct from every other stage (L6C, F1, F1R, L7U, L8p…), so none of them ever authorizes F1i.
f1i_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1i_reason "F1I_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/F1I-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  f1i_reason "F1I_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# f1i_receipt_gate REPO — F1i is allowed only AFTER L8p is closed (the canonical L8p closeout receipt of the PINNED commit carries BOTH whole-line fields) and only while F1i itself
# is not already recorded as executed (ONE receipt carrying BOTH F1I_LIVE_EXECUTED=YES and F1I_RELEASE_INSTALLED=YES). Read from the pinned commit, never the working tree.
f1i_receipt_gate() {
  local repo=${1:-} both
  [ -n "$repo" ] || { f1i_reason "F1I_REPO_REQUIRED"; return 1; }
  both=$(comm -12 <(l8p_result_field_files "$repo" L8P_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" L8P_PROVISIONING PASS))
  [ -n "$both" ] || { f1i_reason "F1I_L8P_NOT_CLOSED (no receipt carries both L8P_LIVE_EXECUTED=YES and L8P_PROVISIONING=PASS)"; return 1; }
  [ "$(printf '%s\n' "$both" | wc -l)" = 1 ] || { f1i_reason "F1I_L8P_RESULT_NOT_UNIQUE"; return 1; }
  [ "${both#HEAD:}" = "$F1_L8P_CLOSEOUT_RECEIPT_REL" ] || { f1i_reason "F1I_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT"; return 1; }
  [ -z "$(comm -12 <(l8p_result_field_files "$repo" F1I_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" F1I_RELEASE_INSTALLED YES))" ] \
    || { f1i_reason "F1I_ALREADY_EXECUTED (an F1i result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# f1i_preflight_gate PY TOOL CURRENT_ID RELEASE_ID SOURCE_DIR SOURCE_SHA DETECTOR_SHA256 — the reviewed tool's READ-ONLY `check`: /opt/aegis-idea3 and its releases directory exist,
# `current` is exactly the frozen expected release (and that release passes the release guard), the target release is ABSENT, the builder output passes the existing release guard
# with the exact id/source SHA/clean tree/detector digest, the detector is absent on BOTH surfaces, the Core is running, and the post-L7 material exists. It needs ROOT READ authority
# (/opt/aegis-idea3 may be root-only, /etc/aegis-idea3/credentials is root-only, /proc must show every process), so it runs through $SUDO; it needs neither the live flag nor any write.
# If the privileged read cannot be performed the gate fails (ROOT_READ_UNAVAILABLE) and the owner runner stops BEFORE the attempt is consumed.
f1i_preflight_gate() {
  local py=${1:-} tool=${2:-} cur=${3:-} rid=${4:-} src_dir=${5:-} src=${6:-} det=${7:-} out reason
  if ! out=$($SUDO env PYTHONDONTWRITEBYTECODE=1 "$py" "$tool" check --expected-current-release-id "$cur" --release-id "$rid" --source-dir "$src_dir" --source-sha "$src" --detector-sha256 "$det" 2>&1); then
    reason=$(printf '%s\n' "$out" | sed -n 's/.*reason=\([^ ]*\).*/\1/p' | tail -n 1)
    f1i_reason "F1I_PREFLIGHT_FAILED:${reason:-ROOT_READ_UNAVAILABLE}"; return 1
  fi
}

_f1i_catalog_lines() { printf '%s' "$1" | tr ',' '\n' | sed -e '/^$/d' -e '/^absent$/d' -e '/^<empty>$/d' | LC_ALL=C sort -u; }

# f1i_catalog_transition_gate PRE_DIR POST_DIR RELEASE_ID TREE_DIGEST — the value-level proof the comparator's relational rule is checked against: in the captured bundles the release
# catalog is EXACTLY the PRE catalog plus ONE entry `<RELEASE_ID>:<TREE_DIGEST>` (the journaled tree-state digest of the installed release). Every PRE entry stays byte-identical;
# any other addition, a removed or mutated entry, a different digest or no addition at all fails.
f1i_catalog_transition_gate() {
  local pre=${1:-} post=${2:-} rid=${3:-} digest=${4:-} a b added removed
  a=$(awk -F'\t' -v k="$F1I_CATALOG_KEY" '$1 == k { print $2 }' "$pre/host.tsv" 2>/dev/null)
  b=$(awk -F'\t' -v k="$F1I_CATALOG_KEY" '$1 == k { print $2 }' "$post/host.tsv" 2>/dev/null)
  added=$(comm -13 <(_f1i_catalog_lines "$a") <(_f1i_catalog_lines "$b"))
  removed=$(comm -23 <(_f1i_catalog_lines "$a") <(_f1i_catalog_lines "$b"))
  { [ -n "$rid" ] && [ -n "$digest" ] && [ -z "$removed" ] && [ "$added" = "$rid:$digest" ]; } \
    || { f1i_reason "F1I_CATALOG_TRANSITION_NOT_EXACT (added='${added:-NONE}' removed='${removed:-NONE}')"; return 1; }
}

# f1i_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines.
f1i_rollback_output_gate() {
  grep -qxE 'F1I_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "${1:-}" || { f1i_reason "F1I_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
}
