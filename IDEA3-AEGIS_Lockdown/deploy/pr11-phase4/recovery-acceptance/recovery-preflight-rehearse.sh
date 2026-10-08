#!/bin/sh
# AEGIS IDEA3 PR11 Phase 4 — Recovery NON-CONSUMING PRE-LIVE REHEARSAL entry point. OWNER-RUN, READ-ONLY. NOT AN AUTHORIZATION. NOT WIRED INTO RECOVERY.
#
# usage (the FROZEN operator user, NOT root, at an interactive terminal; the pinned worktree must be at the frozen EXPECTED_MAIN):
#   sh recovery-preflight-rehearse.sh <FROZEN_RUNNER> <PINNED_WORKTREE> <AUTH_DIR> "<non-secret owner reason>"
#
# It re-proves that this tool is the exact-main code, derives a private rehearsal copy of the frozen runner (see recovery_rehearsal_build.py: the frozen runner
# is only read, never modified or executed), runs ONLY that copy's read-only checks, prints PASS / BLOCKED / NOT_REHEARSED per section, and deletes the copy.
# It never consumes the Recovery attempt, creates no marker/work directory/closeout, sends no device command and restarts nothing. A PASS is not an
# authorization, not a guarantee, and not an input to any gate: the live runner still performs every one of its own gates.
if [ "${AEGIS_RECOVERY_REHEARSAL_CLEAN_START:-}" != YES ]; then
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TERM="${TERM:-dumb}" AEGIS_RECOVERY_REHEARSAL_CLEAN_START=YES /bin/bash --noprofile --norc "$0" "$@"
fi
[ -n "${BASH_VERSION:-}" ] || { echo 'STOP: the rehearsal clean Bash boundary was not established.' >&2; exit 2; }
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

FROZEN=${1:-}; REPO=${2:-}; AUTH_DIR=${3:-}; REASON=${4-}
fail() { printf 'RECOVERY_REHEARSAL_RESULT=BLOCKED reason=%s\n' "$1" >&2; exit 2; }
[ "$#" = 4 ] || fail USAGE
[ "$(id -u)" != 0 ] || fail RUN_AS_THE_OPERATOR_NOT_ROOT
for value in "$FROZEN" "$REPO" "$AUTH_DIR"; do [[ "$value" == /* && "$value" != *..* && "$value" != *//* ]] || fail PATH_NOT_ABSOLUTE; done
# No environment may redirect the rehearsal (the derived runner repeats and extends this list before it does anything else).
for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV AEGIS_RUNTIME_DIR AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_RECOVERY_SOCKET \
    RECOVERY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED RECOVERY_TEST_ONLY_TRUST_ROOT GLOBAL_MARKER_DIR AEGIS_LOG_PATH AEGIS_DB_PATH TMPDIR; do
  [ -z "${!var:-}" ] || fail "ENVIRONMENT_OVERRIDE_SET:$var"
done
[ -f "$FROZEN" ] && [ ! -L "$FROZEN" ] && [ -d "$REPO/.git" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || fail INPUT_PATH_INVALID
[ -n "$REASON" ] || fail REASON_REQUIRED

git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
HERE=$(cd "$(dirname "$0")" && pwd -P)
REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance
[ "$HERE" = "$(cd "$REPO" && pwd -P)/$REL" ] || fail TOOL_NOT_RUN_FROM_THE_PINNED_WORKTREE
MAIN=$(sed -n 's/^EXPECTED_MAIN=\([0-9a-f]\{40\}\)$/\1/p' "$FROZEN")
[[ "$MAIN" =~ ^[0-9a-f]{40}$ && "$(printf '%s\n' "$MAIN" | wc -l)" = 1 ]] || fail FROZEN_EXPECTED_MAIN_INVALID
[ "$(git -C "$REPO" rev-parse --verify "$MAIN^{commit}")" = "$MAIN" ] && [ "$(git -C "$REPO" rev-parse --verify 'HEAD^{commit}')" = "$MAIN" ] || fail WORKTREE_HEAD_NOT_THE_FROZEN_MAIN
[ -z "$(git -C "$REPO" status --porcelain)" ] || fail WORKTREE_NOT_CLEAN
# The tool, the builder and the two modules it imports are the exact-main blobs, and are not writable by group or others.
for file in recovery-preflight-rehearse.sh recovery_rehearsal_build.py recovery_runner_freeze.py recovery_verifier_snapshot.py recovery_preflight_rehearsal.sh; do
  [ -f "$HERE/$file" ] && [ ! -L "$HERE/$file" ] && [ -z "$(find "$HERE/$file" -maxdepth 0 -perm /022)" ] || fail "TOOL_FILE_UNTRUSTED:$file"
  [ "$(sha256sum -- "$HERE/$file" | cut -d' ' -f1)" = "$(git -C "$REPO" show "$MAIN:$REL/$file" | sha256sum | cut -d' ' -f1)" ] || fail "TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:$file"
done

WORKDIR=$(mktemp -d /tmp/aegis-recovery-rehearsal-run.XXXXXX)
cleanup() { [[ "${WORKDIR:-}" == /tmp/aegis-recovery-rehearsal-run.* ]] && [ -d "$WORKDIR" ] && [ ! -L "$WORKDIR" ] && rm -rf -- "$WORKDIR"; WORKDIR=""; }
trap cleanup EXIT
chmod 700 "$WORKDIR"
build=$(/usr/bin/python3 -I -B "$HERE/recovery_rehearsal_build.py" --repo "$REPO" --frozen "$FROZEN" --out-dir "$WORKDIR") || fail DERIVED_COPY_REFUSED
printf '%s\n' "$build" | grep -E '^RECOVERY_REHEARSAL_(BUILD|FROZEN_RUNNER_SHA256|DERIVED_SHA256|FROZEN_RUNNER_MODIFIED)='
derived=$(printf '%s\n' "$build" | sed -n 's/^RECOVERY_REHEARSAL_DERIVED_PATH=//p')
want_derived_sha=$(printf '%s\n' "$build" | sed -n 's/^RECOVERY_REHEARSAL_DERIVED_SHA256=//p')
[ "$derived" = "$WORKDIR/rehearsal-runner.sh" ] && [ -f "$derived" ] && [ ! -L "$derived" ] || fail DERIVED_PATH_INVALID
[[ "$want_derived_sha" =~ ^[0-9a-f]{64}$ ]] || fail DERIVED_DIGEST_INVALID
printf 'RECOVERY_REHEARSAL_START=YES (read-only; the frozen runner is not executed and the attempt block is not present in the copy)\n'
# The copy is operator-owned (no privilege boundary is crossed), so it is re-hashed immediately before it runs: a swap after the build is refused.
[ "$(sha256sum -- "$derived" | cut -d' ' -f1)" = "$want_derived_sha" ] && [ ! -L "$derived" ] || fail DERIVED_COPY_CHANGED_AFTER_THE_BUILD
set +e
/bin/bash --noprofile --norc "$derived" "$AUTH_DIR" "$REASON"
rc=$?
set -e
case "$rc" in
  20) printf 'RECOVERY_REHEARSAL_ENTRY=COMPLETE exit=20 (PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION: every rehearsed check passed; sections remain NOT_REHEARSED)\n' ;;
  10) printf 'RECOVERY_REHEARSAL_ENTRY=COMPLETE exit=10 (BLOCKED: see the sections above)\n' ;;
  97) printf 'RECOVERY_REHEARSAL_ENTRY=SAFETY_TRIPWIRE exit=97 (a forbidden call was refused; nothing was consumed)\n' ;;
  *) printf 'RECOVERY_REHEARSAL_RESULT=BLOCKED reason=RUNNER_PREFIX_REFUSED_BEFORE_THE_REHEARSAL_DRIVER exit=%s\n' "$rc" ;;
esac
printf 'RECOVERY_REHEARSAL_AUTHORIZES_RECOVERY=NO\nRECOVERY_ATTEMPT_CONSUMED_BY_REHEARSAL=NO\n'
exit "$rc"
