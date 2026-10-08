#!/bin/bash -p
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
# Clean start: the shebang uses `bash -p`, which never processes BASH_ENV/ENV. If someone ran `bash <this file>` instead, an injected
# BASH_ENV/ENV file has already executed, so refuse. Then re-exec with an empty environment (only the named test seams survive).
if [ "${CTV_OPTION_B_CLEAN_START:-}" != YES ]; then
  if [[ $- != *p* ]] && { [ -n "${BASH_ENV+x}" ] || [ -n "${ENV+x}" ]; }; then
    printf 'CTV_OPTION_B_VERIFY=FAIL reason=BASH_ENV_INJECTION_REFUSED\n' >&2; exit 1
  fi
  seams=()
  for v in CTV_OPTION_B_TEST_ONLY CTV_OPTION_B_TEST_ROOT; do [ -z "${!v+x}" ] || seams+=("$v=${!v}"); done
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C CTV_OPTION_B_CLEAN_START=YES "${seams[@]}" /bin/bash --noprofile --norc -p "$0" "$@"
fi
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

REPO= MAIN= CANON= WORK= DEVICE= PHASE=pre HERMETIC=NO PATH_PREFIX= BIND_EVIDENCE=NO
EXPECT_PRE_SUMS= EXPECT_POST_SUMS= EXPECT_COMPARE=
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
    --path-prefix) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PATH_PREFIX=${2:-}; shift 2 ;;
    --bind-evidence) BIND_EVIDENCE=YES; shift ;;
    --expect-pre-sums) EXPECT_PRE_SUMS=${2:-}; shift 2 ;; --expect-post-sums) EXPECT_POST_SUMS=${2:-}; shift 2 ;;
    --expect-compare) EXPECT_COMPARE=${2:-}; shift 2 ;;
    *) fail USAGE ;;
  esac
done
[[ "$MAIN" =~ ^[0-9a-f]{40}$ ]] || fail MAIN_INVALID
[[ "$DEVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail DEVICE_ID_INVALID
case "$PHASE" in pre|post) ;; *) fail PHASE_INVALID ;; esac
for h in "$EXPECT_PRE_SUMS" "$EXPECT_POST_SUMS" "$EXPECT_COMPARE"; do [ -z "$h" ] || [[ "$h" =~ ^[0-9a-f]{64}$ ]] || fail EVIDENCE_EXPECTATION_INVALID; done
if [ "$BIND_EVIDENCE" = YES ]; then [ -n "$EXPECT_PRE_SUMS" ] && [ -n "$EXPECT_POST_SUMS" ] && [ -n "$EXPECT_COMPARE" ] || fail EVIDENCE_BINDING_INCOMPLETE; fi
for v in "$REPO" "$CANON" "$WORK" "$UNIT_DEST" "$CORE_ENV"; do
  [[ "$v" == /* && "$v" != *..* && "$v" != *//* && "${v%/}" == "$v" ]] || fail PATH_INVALID
done

# ── 1. Exact merged authority: repo HEAD, and every script/library this verifier executes, equal the git blobs at MAIN.
ob_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
P4=$(dirname "$HERE")
[ "$P4" = "$(cd "$REPO" && pwd -P)/$P4_REL" ] || fail VERIFIER_NOT_RUN_FROM_REPO
[ "$(ob_git -C "$REPO" rev-parse HEAD)" = "$MAIN" ] || fail REPO_HEAD_NOT_EXPECTED_MAIN
APP=$(dirname "$(dirname "$P4")")
# Complete import closure of p4-l5-clock.py (p4-l5-clock -> aegis_soc.trusted_time -> aegis_soc.protocol_v1); a test recomputes it with ast.
AEGIS_SOC_CLOSURE="aegis_soc/__init__.py aegis_soc/trusted_time.py aegis_soc/protocol_v1.py"
EXEC_FILES=()
for rel in ctv-incident/ctv-option-b-verify.sh ctv-incident/ctv-option-b-guard.sh p4-ctv-run-lib.sh p4-ctu-run-lib.sh p4-l5-clock.py; do
  EXEC_FILES+=("$P4/$rel"); gitrel="$P4_REL/$rel"
  [ -f "$P4/$rel" ] && [ ! -L "$P4/$rel" ] || fail AUTHORITY_FILE_MISSING
  want=$(ob_git -C "$REPO" show "$MAIN:$gitrel" | sha256sum | cut -d' ' -f1)
  [ "$(sha256sum -- "$P4/$rel" | cut -d' ' -f1)" = "$want" ] || fail AUTHORITY_FILE_DIFFERS_FROM_MAIN
done
for rel in $AEGIS_SOC_CLOSURE; do
  EXEC_FILES+=("$APP/$rel")
  [ -f "$APP/$rel" ] && [ ! -L "$APP/$rel" ] || fail AUTHORITY_FILE_MISSING
  want=$(ob_git -C "$REPO" show "$MAIN:IDEA3-AEGIS_Lockdown/$rel" | sha256sum | cut -d' ' -f1)
  [ "$(sha256sum -- "$APP/$rel" | cut -d' ' -f1)" = "$want" ] || fail AUTHORITY_FILE_DIFFERS_FROM_MAIN
done
[ "$(ob_git -C "$REPO" show "$MAIN:$UNIT_EXAMPLE_REL" | sha256sum | cut -d' ' -f1)" = "$PIN_UNIT_SHA256" ] || fail PINNED_UNIT_NOT_REVIEWED_SOURCE
[ "$PIN_UNIT_SHA256" != "$PIN_PREIMAGE_SHA256" ] || fail PIN_COLLISION
printf 'CTV_OPTION_B_AUTHORITY=PASS\nCTV_OPTION_B_EXPECTED_MAIN=%s\nCTV_OPTION_B_GUARD_SHA256=%s\n' "$MAIN" "$(sha256sum -- "$P4/ctv-incident/ctv-option-b-guard.sh" | cut -d' ' -f1)"

# shellcheck source=/dev/null
. "$P4/ctv-incident/ctv-option-b-guard.sh"
ob_guard_init
for f in "${EXEC_FILES[@]}"; do ob_trusted_file "$f" || fail EXEC_PATH_NOT_TRUSTED; done
if [ "$HERMETIC" = YES ]; then [ -z "$PATH_PREFIX" ] || { PATH="$PATH_PREFIX:$PATH"; export PATH; }
else
  py=$(realpath -e -- /usr/bin/python3) && [ "$(stat -c %u -- "$py")" = 0 ] && ob_no_gw "$py" || fail PYTHON_NOT_ROOT_TRUSTED
fi
# shellcheck source=/dev/null
. "$P4/p4-ctv-run-lib.sh"
# shellcheck source=/dev/null
. "$P4/p4-ctu-run-lib.sh"
trap 'fail UNEXPECTED_ERROR_LINE_$LINENO' ERR
ob_guard_init_sudo_repin() { if [ "$HERMETIC" = YES ]; then CTV_SUDO=""; elif [ "$(id -u)" = 0 ]; then CTV_SUDO=""; else CTV_SUDO=/usr/bin/sudo; fi; }
ob_guard_init_sudo_repin
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
# Ownership is checked explicitly: ctv_verify_regular_trusted skips it when no privilege prefix is used (running as root).
if [ "$HERMETIC" = YES ]; then want_owner="$(id -u):$(id -g)"; else want_owner=0:0; fi
[ "$(ctv_run stat -c %u:%g -- "$UNIT_DEST")" = "$want_owner" ] && [ -z "$(ctv_run find "$UNIT_DEST" -maxdepth 0 -perm /022 -print)" ] || fail UNIT_OWNERSHIP_INVALID
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
# -I ignores PYTHON* env and cwd/script dirs; the pycache prefix points at a non-existent dir so no planted __pycache__ is ever read.
clock_line=$(/usr/bin/python3 -I -B -X pycache_prefix=/nonexistent-ctv-option-b-pycache "$P4/p4-l5-clock.py" "${clock_args[@]}") || fail TRUSTEDCLOCK_NOT_OK
[[ "$clock_line" =~ ^state=SYNCED\ reason=OK[[:space:]] ]] || fail TRUSTEDCLOCK_NOT_SYNCED
printf 'CTV_OPTION_B_TRUSTEDCLOCK=SYNCED\nCTV_OPTION_B_TRUSTEDCLOCK_REASON=OK\n'

# ── 8. Evidence integrity, positive historical S10 FAIL, PRE detector baseline; digests optionally bound to the authorization.
for d in pre-root post-root; do
  ctv_run test -f "$WORK/$d/SHA256SUMS" && ! ctv_run test -L "$WORK/$d/SHA256SUMS" || fail EVIDENCE_MANIFEST_MISSING
  ctv_run bash -c 'cd "$1" && sha256sum -c --quiet --strict SHA256SUMS' _ "$WORK/$d" >/dev/null 2>&1 || fail EVIDENCE_INTEGRITY_FAIL
  grep -q 'L0_CAPTURE=COMPLETE' <<<"$(ob_cat "$WORK/$d/capture.log")" || fail EVIDENCE_CAPTURE_INCOMPLETE
done
pre_sums=$(ob_sha "$WORK/pre-root/SHA256SUMS"); post_sums=$(ob_sha "$WORK/post-root/SHA256SUMS"); compare_sha=$(ob_sha "$WORK/compare-pre-post.txt")
printf 'CTV_OPTION_B_PRE_SHA256SUMS_SHA256=%s\nCTV_OPTION_B_POST_SHA256SUMS_SHA256=%s\nCTV_OPTION_B_COMPARE_OUTPUT_SHA256=%s\n' "$pre_sums" "$post_sums" "$compare_sha"
[ -z "$EXPECT_PRE_SUMS" ] || [ "$pre_sums" = "$EXPECT_PRE_SUMS" ] || fail EVIDENCE_DIGEST_MISMATCH
[ -z "$EXPECT_POST_SUMS" ] || [ "$post_sums" = "$EXPECT_POST_SUMS" ] || fail EVIDENCE_DIGEST_MISMATCH
[ -z "$EXPECT_COMPARE" ] || [ "$compare_sha" = "$EXPECT_COMPARE" ] || fail EVIDENCE_DIGEST_MISMATCH
compare_text=$(ob_cat "$WORK/compare-pre-post.txt")
# POSITIVE evidence: a genuine p4-compare.sh report (schema line, no-mutation line) that says S10 and the comparison FAILED, each exactly once.
# Absence of PASS is not enough (a truncated file or a STOP report would otherwise qualify).
[ "$(grep -c '^P4_COMPARE_SCHEMA=' <<<"$compare_text")" = 1 ] && [ "$(grep -cx 'PRODUCTION_MUTATION_PERFORMED=NO' <<<"$compare_text")" = 1 ] || fail HISTORICAL_COMPARE_NOT_A_REPORT
[ "$(grep -cx 'PRESERVATION_S10=FAIL' <<<"$compare_text")" = 1 ] && [ "$(grep -cx 'COMPARE_RESULT=FAIL' <<<"$compare_text")" = 1 ] || fail HISTORICAL_S10_FAIL_NOT_POSITIVELY_EVIDENCED
! grep -qx 'PRESERVATION_S10=PASS' <<<"$compare_text" && ! grep -qx 'COMPARE_RESULT=PASS' <<<"$compare_text" || fail HISTORICAL_S10_IS_NOT_A_FAIL
# PRE detector baseline, from the integrity-verified PRE capture (not from the current host).
pre_tsv="$WORK/pre-root/services.tsv"; det=svc.aegis-idea3-detector.service
ob_tsv() { ctv_run awk -F'\t' -v k="$2" '$1 == k { n++; v = $2 } END { if (n != 1) exit 1; print v }' "$1"; }
[ "$(ob_tsv "$pre_tsv" "$det.LoadState")" = loaded ] && [ "$(ob_tsv "$pre_tsv" "$det.ActiveState")" = inactive ] && \
  [ "$(ob_tsv "$pre_tsv" "$det.SubState")" = dead ] && [ "$(ob_tsv "$pre_tsv" "$det.MainPID")" = 0 ] && \
  [ "$(ob_tsv "$pre_tsv" "$det.UnitFileState")" = disabled ] || fail PRE_DETECTOR_BASELINE_NOT_INACTIVE
printf 'CTV_OPTION_B_EVIDENCE_INTEGRITY=PASS\nCTV_OPTION_B_EVIDENCE_DIGESTS_BOUND=%s\nCTV_OPTION_B_PRE_DETECTOR_BASELINE=INACTIVE\n' "$BIND_EVIDENCE"
printf 'CTV_OPTION_B_S10_HISTORICAL_COMPARE=FAIL\nCTV_OPTION_B_S10_POSITIVELY_EVIDENCED=YES\nCTV_OPTION_B_S10_PROMOTED_TO_PASS=NO\n'

# ── 9. Race prevention: the mutable facts this verdict rests on must be identical at the start and the end.
state_end=$(ob_state_digest)
[ "$state_start" = "$state_end" ] || fail STATE_CHANGED_DURING_VERIFY
printf 'CTV_OPTION_B_STATE_SHA256=%s\nCTV_OPTION_B_READ_ONLY=YES\nCTV_OPTION_B_ADDITIONAL_RESTART=NO\nCTV_OPTION_B_VERIFY=PASS\n' "$state_end"
