#!/usr/bin/env bash
# CTv consumed-attempt incident disposition, Option B: READ-ONLY verifier.
#
# Proves the installed target Core unit may be RETAINED without any additional restart. It performs reads only
# (cat/sha256sum/stat/find, `systemctl show`, `pgrep`, a read-only adjtimex probe). It never installs, restarts,
# reloads, writes, or removes anything, and it deliberately does NOT use ctv_host_runtime_verify (its `diff -u` has
# one operand and fails on the live host) or the historical S10 comparison (which stays a FAIL; this script never
# promotes it).
#
# Output is machine-parsable KEY=VALUE on stdout; the final line is CTV_OPTION_B_VERIFY=PASS only when every gate
# passed. Any failure prints CTV_OPTION_B_VERIFY=FAIL reason=... on stderr and exits 1 (fail closed).
#
# usage: ctv-option-b-verify.sh --repo MERGED_MAIN_WORKTREE --main SHA40 --canon DIR --work CTV_WORK_DIR --device ID
#                               [--phase pre|post]   (pre: CTv closeouts must be absent; post: FAIL closeout present)
#                               [--hermetic --unit-dest F --core-env F --clock-fixture none|unsynced:N|synced:N
#                                --preimage-sha256 H --path-prefix DIR]   (test seams; refused without --hermetic)
set -Eeuo pipefail
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

# Pins from the Human Owner's verified incident evidence. PIN_UNIT_SHA256 is additionally proven below to equal the
# reviewed unit source at the exact merged main.
PIN_UNIT_SHA256=82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c
PIN_PREIMAGE_SHA256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890
P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
UNIT_EXAMPLE_REL=IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example
CORE_UNIT=aegis-idea3-core.service
EXPECTED_DROPINS='/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf
/etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf'

fail() { printf 'CTV_OPTION_B_VERIFY=FAIL reason=%s\n' "${1:-UNKNOWN}" >&2; exit 1; }
trap 'fail UNEXPECTED_ERROR_LINE_$LINENO' ERR

REPO= MAIN= CANON= WORK= DEVICE= PHASE=pre HERMETIC=NO
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CORE_ENV=/etc/aegis-idea3/core.env
CLOCK_FIXTURE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;; --main) MAIN=${2:-}; shift 2 ;; --canon) CANON=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;; --device) DEVICE=${2:-}; shift 2 ;; --phase) PHASE=${2:-}; shift 2 ;;
    --hermetic) HERMETIC=YES; shift ;;
    --unit-dest) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; UNIT_DEST=${2:-}; shift 2 ;;
    --core-env) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; CORE_ENV=${2:-}; shift 2 ;;
    --clock-fixture) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; CLOCK_FIXTURE=${2:-}; shift 2 ;;
    --preimage-sha256) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PIN_PREIMAGE_SHA256=${2:-}; shift 2 ;;
    --path-prefix) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PATH="${2:-}:$PATH"; export PATH; shift 2 ;;
    *) fail USAGE ;;
  esac
done
[[ "$MAIN" =~ ^[0-9a-f]{40}$ ]] || fail MAIN_INVALID
[[ "$DEVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail DEVICE_ID_INVALID
case "$PHASE" in pre|post) ;; *) fail PHASE_INVALID ;; esac
for v in "$REPO" "$CANON" "$WORK" "$UNIT_DEST" "$CORE_ENV"; do
  [[ "$v" == /* && "$v" != *..* && "$v" != *//* && "${v%/}" == "$v" ]] || fail PATH_INVALID
done

# ── 1. Exact merged authority: repo HEAD, and every script/library this verifier executes, equal the git blobs at MAIN.
ob_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
P4=$(dirname "$HERE")
[ "$P4" = "$(cd "$REPO" && pwd -P)/$P4_REL" ] || fail VERIFIER_NOT_RUN_FROM_REPO
[ "$(ob_git -C "$REPO" rev-parse HEAD)" = "$MAIN" ] || fail REPO_HEAD_NOT_EXPECTED_MAIN
for rel in ctv-incident/ctv-option-b-verify.sh p4-ctv-run-lib.sh p4-ctu-run-lib.sh p4-l5-clock.py; do
  [ -f "$P4/$rel" ] && [ ! -L "$P4/$rel" ] || fail AUTHORITY_FILE_MISSING
  want=$(ob_git -C "$REPO" show "$MAIN:$P4_REL/$rel" | sha256sum | cut -d' ' -f1)
  [ "$(sha256sum -- "$P4/$rel" | cut -d' ' -f1)" = "$want" ] || fail AUTHORITY_FILE_DIFFERS_FROM_MAIN
done
[ "$(ob_git -C "$REPO" show "$MAIN:$UNIT_EXAMPLE_REL" | sha256sum | cut -d' ' -f1)" = "$PIN_UNIT_SHA256" ] || fail PINNED_UNIT_NOT_REVIEWED_SOURCE
[ "$PIN_UNIT_SHA256" != "$PIN_PREIMAGE_SHA256" ] || fail PIN_COLLISION
printf 'CTV_OPTION_B_AUTHORITY=PASS\nCTV_OPTION_B_EXPECTED_MAIN=%s\n' "$MAIN"

if [ "$HERMETIC" = YES ]; then CTV_SUDO=; export CTV_SUDO; fi
# shellcheck source=/dev/null
. "$P4/p4-ctv-run-lib.sh"
# shellcheck source=/dev/null
. "$P4/p4-ctu-run-lib.sh"
trap 'fail UNEXPECTED_ERROR_LINE_$LINENO' ERR
CTV_CANONICAL_DIR=$CANON
ctv_path_ok "$CANON" && ctv_path_ok "$WORK" || fail PATH_INVALID
ob_cat() { ctv_run cat -- "$1"; }
ob_sha() { ctv_run sha256sum -- "$1" | cut -d' ' -f1; }
# ob_prop OUTPUT KEY — the value of KEY, which must appear exactly once.
ob_prop() { awk -v k="$2" 'index($0, k "=") == 1 { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' <<<"$1"; }
ob_absent() { ! ctv_run test -e "$1" && ! ctv_run test -L "$1"; }

# ── 2. Canonical governance state: CTv CONSUMED, no CTv PASS, Recovery untouched, CTu predecessor intact.
marker="$CANON/$CTV_GLOBAL_MARKER_NAME"
ctv_run test -f "$marker" && ! ctv_run test -L "$marker" || fail CTV_MARKER_MISSING
marker_text=$(ob_cat "$marker")
grep -qx 'CTV_ATTEMPT_CONSUMED=YES' <<<"$marker_text" && grep -qx 'CTV_RERUN_ALLOWED=NO' <<<"$marker_text" || fail CTV_MARKER_INVALID
[ "$(ob_prop "$marker_text" work)" = "$WORK" ] || fail CTV_MARKER_WORK_DIR_MISMATCH
ob_absent "$CANON/$CTV_CLOSEOUT_PASS_NAME" || fail CTV_PASS_CLOSEOUT_PRESENT
if [ "$PHASE" = pre ]; then ob_absent "$CANON/$CTV_CLOSEOUT_FAIL_NAME" || fail CTV_FAIL_CLOSEOUT_ALREADY_PRESENT
else ctv_run test -f "$CANON/$CTV_CLOSEOUT_FAIL_NAME" && ! ctv_run test -L "$CANON/$CTV_CLOSEOUT_FAIL_NAME" || fail CTV_FAIL_CLOSEOUT_MISSING; fi
[ -z "$(ctv_run find "$CANON" -maxdepth 1 -name 'RECOVERY-*' -print -quit)" ] || fail RECOVERY_AUTHORITY_PRESENT
ctu_marker_text=$(ob_cat "$CANON/CTU-GLOBAL-ATTEMPT-CONSUMED"); ctu_fail_text=$(ob_cat "$CANON/CTU-GLOBAL-CLOSEOUT-FAIL")
grep -qx 'CTU_ATTEMPT_CONSUMED=YES' <<<"$ctu_marker_text" && grep -qx 'CTU_RESULT=FAIL_IMMUTABLE' <<<"$ctu_fail_text" || fail CTU_PREDECESSOR_INVALID
ob_absent "$CANON/CTU-GLOBAL-CLOSEOUT-PASS" || fail CTU_PASS_PRESENT
printf 'CTV_OPTION_B_CANONICAL_STATE=PASS\nCTV_OPTION_B_RECOVERY_AUTHORITY_UNCHANGED=YES\nCTV_OPTION_B_FROZEN_RUNNER_SHA256=%s\n' "$(ob_prop "$marker_text" CTV_FROZEN_RUNNER_SHA256)"

# ── 3. Journal and pre-image: apply-verified, rollback never completed, pre-image bytes are the pinned original.
journal="$WORK/journal"
journal_text=$(ob_cat "$journal")
[ "$(grep -c '^phase=' <<<"$journal_text")" = 1 ] && grep -qx 'phase=apply-verified' <<<"$journal_text" || fail JOURNAL_NOT_APPLY_VERIFIED
[ "$(ob_prop "$journal_text" preimage)" = "$journal.preimage" ] || fail JOURNAL_PREIMAGE_PATH_INVALID
[ "$(ob_sha "$journal.preimage")" = "$PIN_PREIMAGE_SHA256" ] || fail PREIMAGE_SHA256_MISMATCH
printf 'CTV_OPTION_B_JOURNAL_PHASE=apply-verified\nCTV_OPTION_B_ROLLBACK_COMPLETE=NO\nCTV_OPTION_B_PREIMAGE_SHA256=%s\n' "$PIN_PREIMAGE_SHA256"

ob_state_digest() {
  {
    ob_sha "$UNIT_DEST"; ob_sha "$marker"; ob_sha "$journal"; ob_sha "$journal.preimage"
    ctv_run systemctl show -p ActiveState -p SubState -p MainPID -p InvocationID -p ExecMainStartTimestampMonotonic -p NRestarts -p NeedDaemonReload -p DropInPaths "$CORE_UNIT"
    ctv_run find "$CANON" -maxdepth 1 -name 'RECOVERY-*' -print
  } | sha256sum | cut -d' ' -f1
}
state_start=$(ob_state_digest)

# ── 4. Installed target unit identity (bytes, ownership, required directives).
ctv_verify_regular_trusted "$UNIT_DEST" "$PIN_UNIT_SHA256" || fail UNIT_IDENTITY_INVALID
ctv_target_unit_preflight "$UNIT_DEST" "$PIN_UNIT_SHA256" || fail UNIT_DIRECTIVES_INVALID
printf 'CTV_OPTION_B_UNIT_IDENTITY=PASS\nCTV_OPTION_B_UNIT_SHA256=%s\n' "$PIN_UNIT_SHA256"

# ── 5. Runtime: Core active/running from THIS unit (no pending daemon-reload), effective security properties, exact drop-ins.
runtime=$(ctv_run systemctl show -p LoadState -p ActiveState -p SubState -p Result -p MainPID -p InvocationID -p ExecMainStartTimestampMonotonic -p NRestarts -p FragmentPath -p NeedDaemonReload "$CORE_UNIT")
[ "$(ob_prop "$runtime" LoadState)" = loaded ] && [ "$(ob_prop "$runtime" ActiveState)" = active ] && \
  [ "$(ob_prop "$runtime" SubState)" = running ] && [ "$(ob_prop "$runtime" Result)" = success ] || fail CORE_NOT_ACTIVE_RUNNING
[ "$(ob_prop "$runtime" FragmentPath)" = "$UNIT_DEST" ] || fail CORE_FRAGMENT_PATH_MISMATCH
[ "$(ob_prop "$runtime" NeedDaemonReload)" = no ] || fail CORE_NEEDS_DAEMON_RELOAD
core_pid=$(ob_prop "$runtime" MainPID); [[ "$core_pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_MAINPID_INVALID
[[ "$(ob_prop "$runtime" InvocationID)" =~ ^[0-9a-f]{32}$ ]] || fail CORE_INVOCATION_INVALID
effective=$(ctv_run systemctl show -p ProtectClock -p User -p NoNewPrivileges -p CapabilityBoundingSet -p AmbientCapabilities "$CORE_UNIT")
[[ "$(ob_prop "$effective" ProtectClock)" =~ ^(no|false)$ ]] && [ "$(ob_prop "$effective" User)" = aegis-idea3 ] && \
  [[ "$(ob_prop "$effective" NoNewPrivileges)" =~ ^(yes|true)$ ]] && [ -z "$(ob_prop "$effective" CapabilityBoundingSet)" ] && [ -z "$(ob_prop "$effective" AmbientCapabilities)" ] || fail EFFECTIVE_SECURITY_PROPERTIES_INVALID
dropins=$(ctv_run systemctl show -p DropInPaths --value "$CORE_UNIT")
[ "$(tr ' ' '\n' <<<"$dropins" | sed '/^$/d' | LC_ALL=C sort)" = "$(LC_ALL=C sort <<<"$EXPECTED_DROPINS")" ] || fail DROPINS_NOT_EXACT
printf 'CTV_OPTION_B_RUNTIME=PASS\nCTV_OPTION_B_CORE_MAINPID=%s\nCTV_OPTION_B_EFFECTIVE_SECURITY=PASS\nCTV_OPTION_B_DROPINS=EXACT\n' "$core_pid"

# ── 6. Device identity and detector baseline.
ctv_validate_core_env_device_id "$CORE_ENV" "$DEVICE" || fail DEVICE_ID_MISMATCH
[ "$(ctv_detector_baseline_mode)" = INACTIVE ] || fail DETECTOR_BASELINE_NOT_INACTIVE
printf 'CTV_OPTION_B_DEVICE_ID=%s\nCTV_OPTION_B_DETECTOR_BASELINE_MODE=INACTIVE\n' "$DEVICE"

# ── 7. Current TrustedClock (read-only adjtimex probe through the exact-main predicate).
clock_args=(probe)
[ -z "$CLOCK_FIXTURE" ] || clock_args+=(--fixture-probe "$CLOCK_FIXTURE")
clock_line=$(/usr/bin/python3 -I -B "$P4/p4-l5-clock.py" "${clock_args[@]}") || fail TRUSTEDCLOCK_NOT_OK
[[ "$clock_line" =~ ^state=SYNCED\ reason=OK[[:space:]] ]] || fail TRUSTEDCLOCK_NOT_SYNCED
printf 'CTV_OPTION_B_TRUSTEDCLOCK=SYNCED\nCTV_OPTION_B_TRUSTEDCLOCK_REASON=OK\n'

# ── 8. Evidence integrity, and the historical S10 result is genuinely not a PASS (it is recorded, never promoted).
for d in pre-root post-root; do
  ctv_run test -f "$WORK/$d/SHA256SUMS" && ! ctv_run test -L "$WORK/$d/SHA256SUMS" || fail EVIDENCE_MANIFEST_MISSING
  ctv_run bash -c 'cd "$1" && sha256sum -c --quiet --strict SHA256SUMS' _ "$WORK/$d" >/dev/null 2>&1 || fail EVIDENCE_INTEGRITY_FAIL
  grep -q 'L0_CAPTURE=COMPLETE' <<<"$(ob_cat "$WORK/$d/capture.log")" || fail EVIDENCE_CAPTURE_INCOMPLETE
done
compare_text=$(ob_cat "$WORK/compare-pre-post.txt")
if grep -qx 'PRESERVATION_S10=PASS' <<<"$compare_text" || grep -qx 'COMPARE_RESULT=PASS' <<<"$compare_text"; then fail HISTORICAL_S10_IS_NOT_A_FAIL; fi
printf 'CTV_OPTION_B_EVIDENCE_INTEGRITY=PASS\nCTV_OPTION_B_PRE_SHA256SUMS_SHA256=%s\nCTV_OPTION_B_POST_SHA256SUMS_SHA256=%s\n' "$(ob_sha "$WORK/pre-root/SHA256SUMS")" "$(ob_sha "$WORK/post-root/SHA256SUMS")"
printf 'CTV_OPTION_B_S10_HISTORICAL_COMPARE=FAIL\nCTV_OPTION_B_S10_PROMOTED_TO_PASS=NO\nCTV_OPTION_B_COMPARE_OUTPUT_SHA256=%s\n' "$(ob_sha "$WORK/compare-pre-post.txt")"

# ── 9. Race prevention: the mutable facts this verdict rests on must be identical at the start and the end.
state_end=$(ob_state_digest)
[ "$state_start" = "$state_end" ] || fail STATE_CHANGED_DURING_VERIFY
printf 'CTV_OPTION_B_STATE_SHA256=%s\nCTV_OPTION_B_READ_ONLY=YES\nCTV_OPTION_B_ADDITIONAL_RESTART=NO\nCTV_OPTION_B_VERIFY=PASS\n' "$state_end"
