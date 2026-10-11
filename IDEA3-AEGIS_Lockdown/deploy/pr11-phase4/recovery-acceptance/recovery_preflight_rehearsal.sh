# AEGIS IDEA3 PR11 Phase 4 — Recovery NON-CONSUMING PRE-LIVE REHEARSAL driver (library). NOT AN AUTHORITY. NOT AN AUTHORIZATION.
#
# This file defines functions only; it executes nothing when sourced. It is embedded by recovery_rehearsal_build.py into a DERIVED COPY of a frozen
# Recovery runner, in place of that runner's final `recovery_run_attempt` call. The frozen runner itself is never modified, sourced from here, or rerun.
#
# What the rehearsal DOES: after the runner's own prefix has passed (pins, environment gate, control-snapshot gates, operator identity, ONE sudo
# establishment), it runs the runner's EXISTING read-only checks exactly as the live runner runs them before the marker:
#   recovery_hook_pregates   (exact-main, authorization/K3, real stage gate, R1B/R1Bv predecessor, CTu-or-CTv-PASS successor, RRu, attempt unconsumed,
#                             disk/services/broker/IDEA2 S10, the live authority gates, Recovery socket, owner reason)
#   recovery_hook_regate     (live authority again, sudo authority, terminal, attempt unconsumed)
#   a release-CLI argument-parse check (`aegisctl restore --help`, which exits in argparse BEFORE the restore command can run)
# and it reports each section as PASS, BLOCKED or NOT_REHEARSED. The overall result is never a complete pass: the best outcome is PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION with exit status 20.
#
# What it CANNOT and MUST NOT do: it never consumes the Recovery attempt, creates no marker, no work directory, no provenance file, no capture and no
# closeout, runs no baseline/ISOLATE/RESTORE/CLOSE/FINAL/VERIFY, issues no device command, and restarts nothing. Every consuming or mutating runner function is
# replaced by a tripwire; every privileged command goes through a default-deny read-only wrapper. A PASS here means ONLY "these checks passed just now":
# it is not Recovery authorization, it is not an attempt token, it carries no digest that any gate accepts, and it never replaces the live runner's own gates.

RECOVERY_REHEARSAL_STAGE="Recovery-preflight-rehearsal"
# The real sudo the read-only wrapper delegates to: a plain assignment (the environment cannot choose it). Tests replace it AFTER sourcing.
RECOVERY_REHEARSAL_REAL_SUDO=/usr/bin/sudo
RH_DIR=""
RH_TRIPPED=0

# Every runner/library function that consumes the attempt, writes into the root work directory, runs a post-marker step or issues a command. They are
# redefined as tripwires; none of them is called by the read-only checks above.
RECOVERY_REHEARSAL_POISONED="recovery_consume_attempt recovery_run_attempt recovery_attempt_failed recovery_hook_baseline recovery_hook_isolate recovery_hook_d4 recovery_hook_restore_status recovery_hook_close recovery_hook_final recovery_hook_verify recovery_hook_preserve_evidence recovery_d4_run recovery_d4_exec recovery_d4_rehearsal recovery_handler recovery_prepare_evidence recovery_capture recovery_root_py recovery_compare recovery_logs_prepare recovery_durable recovery_fsync"

recovery_rehearsal_say() { printf 'RECOVERY_REHEARSAL_%s\n' "$1"; }

# recovery_rehearsal_trip NAME — a forbidden function or privileged command was reached. The tripwire FILE is authoritative (the call may run in a subshell).
recovery_rehearsal_trip() {
  printf 'RECOVERY_REHEARSAL_TRIPWIRE=%s\n' "$1" >&2
  [ -z "${RH_DIR:-}" ] || printf '%s\n' "$1" >> "$RH_DIR/TRIPWIRE" 2>/dev/null || true
  exit 97
}

recovery_rehearsal_poison_install() {
  local fn orig
  for fn in $RECOVERY_REHEARSAL_POISONED; do
    eval "$fn() { recovery_rehearsal_trip $fn; }"
  done
  # The Core client wrapper is allowed ONLY for the two read-only subcommands the pre-gates use.
  if declare -F recovery_operator_py >/dev/null 2>&1; then
    eval "recovery_operator_py_original() $(declare -f recovery_operator_py | sed '1d')"
  else
    recovery_operator_py_original() { return 1; }
  fi
  recovery_operator_py() {
    case "${1:-}" in
      socket-check | check-reason) recovery_operator_py_original "$@" ;;
      *) recovery_rehearsal_trip "recovery_operator_py:${1:-}" ;;
    esac
  }
}

# recovery_rehearsal_write_sudo_wrapper PATH CTRL PY — the privileged-command contract of the rehearsal. `sudo` for the pre-gates is replaced by this generated file,
# which validates the WHOLE command (program, every option and every operand) against the exact read-only forms that the reviewed Recovery pre-gates use, and refuses everything
# else (writes the tripwire, exits 97) BEFORE any privileged execution. There is no pattern or substring allow rule:
#   * the program is a bare allowlisted name, resolved only in /usr/bin /bin /usr/sbin /sbin; any `/` in the name is refused (one exception: the pinned interpreter, by exact equality);
#   * no `env`, no shell, no `grep`/`cat`/`cmp`/`sort`/`uniq`/`date`/`journalctl`, no stdin Python: the pre-gates never reach them as privileged commands, so they are not allowed;
#   * the command is executed through `env -i` with a fixed PATH, so no caller variable (LD_*, PATH, PYTHON*, BASH_ENV, ENV, IFS, SHELLOPTS, ...) can reach it.
# Every operand that is a path must be absolute, made of a safe character set, and free of `..`.
recovery_rehearsal_write_sudo_wrapper() {
  local path=$1 ctrl=$2 py=$3 value
  umask 077
  for value in "$RECOVERY_REHEARSAL_REAL_SUDO" "$RH_DIR/sudo-calls.log" "$RH_DIR/TRIPWIRE" "$ctrl" "$py"; do
    [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ && "$value" != *..* ]] || recovery_rehearsal_trip "wrapper-constant-not-a-safe-path"
  done
  {
    printf '#!/bin/bash -p\n'
    printf 'REAL=%q\nLOG=%q\nTRIP=%q\nCTRL=%q\nPY=%q\n' "$RECOVERY_REHEARSAL_REAL_SUDO" "$RH_DIR/sudo-calls.log" "$RH_DIR/TRIPWIRE" "$ctrl" "$py"
    cat <<'WRAPPER'
# Read-only privilege wrapper generated by recovery_preflight_rehearsal.sh. Default deny: a command is allowed only if it matches one of the exact forms below.
set -u
FIXED_PATH=/usr/sbin:/usr/bin:/sbin:/bin
PATH=$FIXED_PATH   # the wrapper's own helpers (realpath) are looked up only in the fixed directories
export PATH
deny() { printf 'RECOVERY_REHEARSAL_SUDO_DENIED=%s\n' "$1" >&2; printf 'sudo:%s\n' "$1" >> "$TRIP"; exit 97; }
args=("$@")
n=$#
[ "$n" -ge 1 ] || deny "empty-command"
for a in "${args[@]}"; do
  case "$a" in *$'\n'* | *$'\r'*) deny "control-character-in-argument" ;; esac
done
prog=${args[0]}
# is_path VALUE — absolute, safe characters only, no `..`
is_path() { [[ "$1" =~ ^/[A-Za-z0-9._/@:+,=%-]*$ ]] && [[ "$1" != *..* ]]; }
resolve() { local d; for d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/$1" ] && [ -f "$d/$1" ] && { printf '%s' "$d/$1"; return 0; }; done; return 1; }

target=""   # the program that will be executed (absolute)
case "$prog" in
  "$PY")
    # the pinned interpreter, by exact equality, running ONE control-snapshot tool with ONE reviewed read-only subcommand
    [ "$n" = 9 ] || deny "python-form"
    is_path "${args[1]}" || deny "python-script-path"
    script=$(realpath -e -- "${args[1]}" 2>/dev/null) || deny "python-script-unresolvable"
    ctrl_real=$(realpath -e -- "$CTRL" 2>/dev/null) || deny "control-snapshot-unresolvable"
    [[ "$script" == "$ctrl_real"/* && "$script" != *..* ]] || deny "python-script-outside-control-snapshot"
    [ "${script##*/}" = p4-l7-release-guard.py ] || deny "python-script-not-reviewed"
    [ "${args[2]}" = check ] && [ "${args[3]}" = --logical-path ] && [[ "${args[4]}" =~ ^/opt/aegis-idea3/releases/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ "${args[5]}" = --host-path ] \
      && is_path "${args[6]}" && [ "${args[7]}" = --expect-owner ] && [ "${args[8]}" = root ] || deny "python-arguments"
    target=$PY ;;
  */*) deny "program-with-path" ;;
  true) [ "$n" = 1 ] || deny "true-args" ;;
  test)
    [ "$n" = 3 ] && { [ "${args[1]}" = -d ] || [ "${args[1]}" = -e ] || [ "${args[1]}" = -L ]; } && is_path "${args[2]}" || deny "test-form" ;;
  stat)
    [ "$n" = 4 ] && [ "${args[1]}" = -c ] && [ "${args[2]}" = '%u' ] && is_path "${args[3]}" || deny "stat-form" ;;
  readlink)
    [ "$n" = 2 ] && is_path "${args[1]}" || deny "readlink-form" ;;
  sha256sum)
    [ "$n" = 2 ] && is_path "${args[1]}" || deny "sha256sum-form" ;;
  find)
    if [ "$n" = 6 ]; then
      is_path "${args[1]}" && [ "${args[2]}" = -maxdepth ] && [ "${args[3]}" = 0 ] && [ "${args[4]}" = -perm ] && [ "${args[5]}" = /022 ] || deny "find-form"
    elif [ "$n" = 15 ]; then
      is_path "${args[1]}" && [ "${args[2]}" = -maxdepth ] && [ "${args[3]}" = 1 ] && [ "${args[4]}" = -type ] && [ "${args[5]}" = f ] && [ "${args[6]}" = '(' ] \
        && [ "${args[7]}" = -name ] && [[ "${args[8]}" =~ ^[A-Za-z0-9_.-]+$ ]] && [ "${args[9]}" = -o ] && [ "${args[10]}" = -name ] && [[ "${args[11]}" =~ ^[A-Za-z0-9_.-]+$ ]] \
        && [ "${args[12]}" = ')' ] && [ "${args[13]}" = -printf ] && [ "${args[14]}" = '%f\n' ] || deny "find-form"
    else deny "find-form"; fi ;;
  awk)
    # only the exact reviewed programs, with exactly one absolute file operand: no -v, -f, --include, redirection, pipe, getline or system
    if [ "$n" = 3 ] && [ "${args[1]}" = 'NF >= 1 {print $1}' ] && is_path "${args[2]}"; then :
    elif [ "$n" = 4 ] && [ "${args[1]}" = '-F=' ] && [ "${args[2]}" = 'NF >= 2 {print $1}' ] && is_path "${args[3]}"; then :
    elif [ "$n" = 4 ] && [ "${args[1]}" = '-F=' ] && [[ "${args[2]}" =~ ^\$1\ ==\ \"[A-Z0-9_]+\"\ \{print\ \$2\}$ ]] && is_path "${args[3]}"; then :
    else deny "awk-program-or-arguments"; fi ;;
  pgrep)
    [ "$n" = 3 ] && [ "${args[1]}" = -fc ] && [ "${args[2]}" = 'aegis_soc[.]production_detector' ] || deny "pgrep-form" ;;
  systemctl)
    # systemctl show (-p PROPERTY)+ UNIT.service — the only systemctl verb
    [ "$n" -ge 5 ] && [ "${args[1]}" = show ] || deny "systemctl-form"
    i=2
    while [ "$i" -lt $((n - 1)) ]; do
      [ "${args[$i]}" = -p ] && [[ "${args[$((i + 1))]}" =~ ^[A-Za-z]+$ ]] || deny "systemctl-property"
      i=$((i + 2))
    done
    [ "$i" = $((n - 1)) ] && [[ "${args[$i]}" =~ ^[A-Za-z0-9@._-]+\.service$ ]] || deny "systemctl-unit" ;;
  nft)
    # list forms only; every operand is a plain identifier, so a `;`, newline, brace or second command can never be present
    if [ "$n" = 3 ] && [ "${args[1]}" = list ] && [ "${args[2]}" = tables ]; then :
    elif [ "$n" = 6 ] && [ "${args[1]}" = --stateless ] && [ "${args[2]}" = list ] && [ "${args[3]}" = table ] && [[ "${args[4]}" =~ ^(inet|ip|ip6)$ ]] && [[ "${args[5]}" =~ ^[A-Za-z0-9_.-]+$ ]]; then :
    else deny "nft-form"; fi ;;
  *) deny "program:${prog:0:40}" ;;
esac
if [ -z "$target" ]; then target=$(resolve "$prog") || deny "program-not-in-fixed-paths"; fi
printf '%s\n' "${args[*]}" >> "$LOG"
exec /usr/bin/env -i PATH="$FIXED_PATH" LC_ALL=C "$REAL" -n "$target" "${args[@]:1}"
WRAPPER
  } > "$path"
  chmod 0500 "$path"
}

# recovery_rehearsal_cleanup — idempotent; removes ONLY the private directory this rehearsal created itself.
recovery_rehearsal_cleanup() {
  recovery_stop_sudo_keepalive 2>/dev/null || true
  if [ -n "${RH_DIR:-}" ] && [[ "$RH_DIR" == */aegis-recovery-rehearsal.* ]] && [ -d "$RH_DIR" ] && [ ! -L "$RH_DIR" ]; then
    rm -rf -- "$RH_DIR"
  fi
  RH_DIR=""
}

# recovery_rehearsal_section NAME STATUS [REASON] — one result line; STATUS is exactly PASS, BLOCKED, NOT_REHEARSED or UNKNOWN.
recovery_rehearsal_section() {
  case "$2" in PASS | BLOCKED | NOT_REHEARSED | UNKNOWN) ;; *) recovery_rehearsal_trip "bad-status:$2" ;; esac
  recovery_rehearsal_say "$1=$2"
  [ -z "${3:-}" ] || recovery_rehearsal_say "$1_REASON=$(printf '%s' "$3" | tr -cd 'A-Za-z0-9_:.() -' | cut -c1-160)"
}

# recovery_rehearsal_run_gate FUNCTION... — runs one read-only check, shows at most 40 bounded reason lines, returns its status.
recovery_rehearsal_run_gate() {
  local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" | tr -cd '[:print:]\n' | head -n 40 | sed 's/^/  | /'
  LAST_GATE_OUTPUT=$out
  return "$rc"
}

recovery_rehearsal_cli_parse() {
  # `aegisctl restore --help`: argparse prints usage and exits 0 before the restore command can execute. The pinned release CLI identity is already proven by
  # the authority gates; this adds import + argument-parser proof WITHOUT running the restore entry point.
  local out rc
  [[ "${RELEASE_PATH:-}" == /* ]] && [ -x "${RELEASE_PATH:-}/venv/bin/python" ] || { LAST_GATE_OUTPUT="RELEASE_PYTHON_MISSING"; return 1; }
  out=$( cd "$RELEASE_PATH" && env -i PATH="$RECOVERY_SAFE_PATH" HOME="${HOME:-/nonexistent}" TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}" AEGIS_RUNTIME_DIR="$RUNTIME_DIR" \
      AEGIS_LOG_PATH="$RH_DIR/cli-parse.log" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 "$RELEASE_PATH/venv/bin/python" -B -s -m aegis_soc.cli restore --help </dev/null 2>&1 ); rc=$?
  LAST_GATE_OUTPUT=$out
  [ "$rc" = 0 ] && [[ "$out" == *"usage: aegisctl restore"* ]] && [[ "$out" != *Traceback* ]] && [[ "$out" != *"RESTORE refused"* ]]
}

# recovery_rehearse — the whole rehearsal. Exit statuses: 20 = every REHEARSED check passed but sections remain NOT_REHEARSED, so the result is PARTIAL (never 0: this
# rehearsal can never be a complete pass, and a caller testing only for 0 must not read it as success; still NOT an authorization), 10 = at least one check is
# BLOCKED, 97 = a safety tripwire fired.
recovery_rehearse() {
  local frozen_sha=${RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256:-} blocked=0 marker canon predecessor=NO
  [[ "$frozen_sha" =~ ^[0-9a-f]{64}$ ]] || { recovery_rehearsal_say "RESULT=BLOCKED"; recovery_rehearsal_say "RESULT_REASON=FROZEN_RUNNER_SHA256_MISSING"; return 10; }
  for fn in recovery_hook_pregates recovery_hook_regate recovery_attempt_unconsumed recovery_canonical_dir; do
    declare -F "$fn" >/dev/null 2>&1 || { recovery_rehearsal_say "RESULT=BLOCKED"; recovery_rehearsal_say "RESULT_REASON=RUNNER_FUNCTION_MISSING_$fn"; return 10; }
  done
  RH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aegis-recovery-rehearsal.XXXXXX") || { recovery_rehearsal_say "RESULT=BLOCKED"; return 10; }
  chmod 700 "$RH_DIR"
  trap recovery_rehearsal_cleanup EXIT
  recovery_rehearsal_say "STAGE=$RECOVERY_REHEARSAL_STAGE"
  recovery_rehearsal_say "MODE=READ_ONLY_NON_CONSUMING_PREFLIGHT"
  recovery_rehearsal_say "REMOTE_TRACKING_NOTE=the runner pre-gates run git fetch origin: a network read that updates remote-tracking refs and objects in the pinned worktree (never its files or HEAD)"
  recovery_rehearsal_say "CLEANUP_LIMIT=SIGINT_SIGTERM_SIGHUP_AND_NORMAL_EXIT_REMOVE_THE_PRIVATE_DIRECTORY_SIGKILL_OR_POWER_LOSS_LEAVES_aegis-recovery-rehearsal.*_IN_TMP_SAFE_TO_DELETE"
  recovery_rehearsal_say "FROZEN_RUNNER_SHA256=$frozen_sha"
  # The derived copy has its own digest; the Authorization names the FROZEN runner, so the pre-gates must be judged against that digest.
  RUNNER_SHA256=$frozen_sha
  recovery_rehearsal_write_sudo_wrapper "$RH_DIR/sudo-ro" "$CTRL" "$PY"
  SUDO="$RH_DIR/sudo-ro"
  recovery_rehearsal_poison_install
  canon=$(recovery_canonical_dir); marker="$canon/$RECOVERY_GLOBAL_MARKER_NAME"

  # 1. the attempt authority is unconsumed (read-only)
  if recovery_rehearsal_run_gate recovery_attempt_unconsumed; then recovery_rehearsal_section ATTEMPT_UNCONSUMED PASS
  else recovery_rehearsal_section ATTEMPT_UNCONSUMED BLOCKED "$LAST_GATE_OUTPUT"; blocked=1; fi
  # 2. the runner's complete read-only pre-gate set (collects EVERY failure, not just the first)
  if recovery_rehearsal_run_gate recovery_hook_pregates; then recovery_rehearsal_section PREGATES PASS
  else
    recovery_rehearsal_section PREGATES BLOCKED "see the GATE_FAIL lines above"; blocked=1
    case "$LAST_GATE_OUTPUT" in *"neither historical CTu PASS nor reviewed CTv PASS"* | *"predecessor gate failed"*) predecessor=YES ;; esac
  fi
  recovery_rehearsal_say "PREDECESSOR_GATE_BLOCKING=$predecessor"
  # 3. the pre-marker re-gate
  if recovery_rehearsal_run_gate recovery_hook_regate; then recovery_rehearsal_section REGATE PASS
  else recovery_rehearsal_section REGATE BLOCKED "$LAST_GATE_OUTPUT"; blocked=1; fi
  # 4. the pinned release CLI imports and parses its arguments (never runs `restore`)
  if recovery_rehearsal_run_gate recovery_rehearsal_cli_parse; then recovery_rehearsal_section RELEASE_CLI_PARSE PASS
  else recovery_rehearsal_section RELEASE_CLI_PARSE BLOCKED "$LAST_GATE_OUTPUT"; blocked=1; fi
  # 5. everything that would need a root-owned work directory, the marker or a command is NOT rehearsed — never reported as passed
  recovery_rehearsal_section BASELINE_AND_ROOT_CAPTURES NOT_REHEARSED "needs a root-owned work directory and provenance file"
  recovery_rehearsal_section D4_EXACT_TERMINAL_REFUSAL NOT_REHEARSED "would execute the restore entry point; the live runner still performs it before the marker"
  recovery_rehearsal_section ATTEMPT_MARKER NOT_REHEARSED "the marker is never created by a rehearsal"
  recovery_rehearsal_section ISOLATE_D4_RESTORE_CLOSE_FINAL_VERIFY NOT_REHEARSED "post-marker steps are never reached"

  # safety proof: nothing was consumed, no tripwire fired
  if [ -s "$RH_DIR/TRIPWIRE" ]; then
    recovery_rehearsal_say "SAFETY_TRIPWIRE=FIRED"
    sed 's/^/RECOVERY_REHEARSAL_TRIPWIRE_DETAIL=/' "$RH_DIR/TRIPWIRE" | head -n 5
    RH_TRIPPED=1
  fi
  if [ "$RH_TRIPPED" = 0 ]; then
    if $SUDO test -e "$marker" 2>/dev/null || $SUDO test -L "$marker" 2>/dev/null; then
      # an already-consumed attempt is a BLOCK that existed before the rehearsal (section 1); report it, never claim the rehearsal did or did not create it beyond section 1
      recovery_rehearsal_say "MARKER_PRESENT=YES"
    else
      recovery_rehearsal_say "MARKER_PRESENT=NO"
    fi
  fi
  recovery_rehearsal_say "ATTEMPT_CONSUMED_BY_REHEARSAL=NO"
  recovery_rehearsal_say "PRODUCTION_MUTATION_BY_REHEARSAL=NO"
  recovery_rehearsal_say "DEVICE_COMMANDS=0"
  recovery_rehearsal_say "AUTHORIZES_RECOVERY=NO"
  recovery_rehearsal_say "IS_AUTHORITY_TOKEN=NO"
  recovery_rehearsal_say "PASS_MEANS=ONLY_THE_REHEARSED_CHECKS_PASSED_JUST_NOW_NOT_AUTHORIZATION_NOT_A_GUARANTEE"
  if [ "$RH_TRIPPED" = 1 ]; then recovery_rehearsal_say "RESULT=SAFETY_TRIPWIRE"; return 97; fi
  if [ "$blocked" = 1 ]; then recovery_rehearsal_say "RESULT=BLOCKED"; return 10; fi
  recovery_rehearsal_say "RESULT=PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION"
  return 20
}
