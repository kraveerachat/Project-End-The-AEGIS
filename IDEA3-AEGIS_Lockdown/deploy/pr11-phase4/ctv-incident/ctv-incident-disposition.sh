#!/bin/bash -p
# CTv consumed-attempt incident disposition, Option B: governed action. PREPARED, NOT AUTHORIZED, NOT EXECUTED.
#
# Records exactly one append-only CTV-GLOBAL-CLOSEOUT-FAIL that truthfully states: the CTv attempt failed, the historical
# S10 comparison FAILED and stays a FAIL, rollback was INCOMPLETE, the target Core unit was RETAINED, no additional restart
# occurred, and no Recovery authority is granted (a CTv FAIL closeout makes the Recovery successor gate refuse).
#
# It touches nothing else: no systemctl verb other than `show` (inside the verifier), no unit/marker/journal/evidence change,
# no restart, no CTv/CTu/Recovery execution. It cannot record without (a) an exact Human Owner authorization file that binds the
# evidence digests, (b) root, (c) the production canonical directory (no override), (d) an exclusive lock, and (e) two fresh passing
# read-only verifier runs whose mutable-state digests are identical, the second immediately before the commit.
#
# usage: ctv-incident-disposition.sh --repo R --main SHA40 --canon DIR --work DIR --device ID [--authorization FILE --record]
#        Without --record it only runs the read-only verifier (dry check) and writes nothing; it prints the evidence digests the
#        Human Owner must place in the authorization file.
#        Test seams (--hermetic ...) are refused unless CTV_OPTION_B_TEST_ONLY=YES and every path is inside a safe CTV_OPTION_B_TEST_ROOT.
set -Eeuo pipefail
umask 077
# Clean start (see the verifier): shebang `bash -p` ignores BASH_ENV/ENV; `bash <file>` with them set is refused; then env -i re-exec.
if [ "${CTV_OPTION_B_CLEAN_START:-}" != YES ]; then
  if [[ $- != *p* ]] && { [ -n "${BASH_ENV+x}" ] || [ -n "${ENV+x}" ]; }; then
    printf 'CTV_INCIDENT_DISPOSITION=FAIL reason=BASH_ENV_INJECTION_REFUSED\n' >&2; exit 1
  fi
  seams=()
  for v in CTV_OPTION_B_TEST_ONLY CTV_OPTION_B_TEST_ROOT CTV_OPTION_B_FAILPOINT; do [ -z "${!v+x}" ] || seams+=("$v=${!v}"); done
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C CTV_OPTION_B_CLEAN_START=YES "${seams[@]}" /bin/bash --noprofile --norc -p "$0" "$@"
fi
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL
PIN_UNIT_SHA256=82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c
PIN_PREIMAGE_SHA256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890
DISPOSITION=OPTION_B_TARGET_UNIT_RETAINED
FAIL_NAME=CTV-GLOBAL-CLOSEOUT-FAIL
fail() { printf 'CTV_INCIDENT_DISPOSITION=FAIL reason=%s\n' "${1:-UNKNOWN}" >&2; exit 1; }
trap 'fail UNEXPECTED_ERROR_LINE_$LINENO' ERR

REPO= MAIN= CANON= WORK= DEVICE= AUTH= RECORD=NO HERMETIC=NO
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CORE_ENV=/etc/aegis-idea3/core.env
CLOCK_FIXTURE= PATH_PREFIX= PREIMAGE_OVERRIDE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;; --main) MAIN=${2:-}; shift 2 ;; --canon) CANON=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;; --device) DEVICE=${2:-}; shift 2 ;; --authorization) AUTH=${2:-}; shift 2 ;;
    --record) RECORD=YES; shift ;;
    --hermetic) HERMETIC=YES; shift ;;
    --preimage-sha256) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PREIMAGE_OVERRIDE=${2:-}; shift 2 ;;
    --unit-dest) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; UNIT_DEST=${2:-}; shift 2 ;;
    --core-env) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; CORE_ENV=${2:-}; shift 2 ;;
    --clock-fixture) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; CLOCK_FIXTURE=${2:-}; shift 2 ;;
    --path-prefix) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PATH_PREFIX=${2:-}; shift 2 ;;
    *) fail USAGE ;;
  esac
done
[[ "$MAIN" =~ ^[0-9a-f]{40}$ && "$DEVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail ARGUMENT_INVALID
for v in "$REPO" "$CANON" "$WORK" "$UNIT_DEST" "$CORE_ENV" ${AUTH:+"$AUTH"}; do [[ "$v" == /* && "$v" != *..* && "$v" != *//* && "${v%/}" == "$v" ]] || fail PATH_INVALID; done
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
VERIFIER=$HERE/ctv-option-b-verify.sh
GUARD=$HERE/ctv-option-b-guard.sh
REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident
[ "$HERE" = "$(cd "$REPO" && pwd -P)/$REL" ] || fail ACTION_NOT_RUN_FROM_REPO
# Authority: this action, the verifier and the guard must be the exact blobs at MAIN (the verifier re-proves the libraries and the aegis_soc closure).
ob_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
[ "$(ob_git -C "$REPO" rev-parse HEAD)" = "$MAIN" ] || fail REPO_HEAD_NOT_EXPECTED_MAIN
for f in "$VERIFIER" "$GUARD" "$HERE/ctv-incident-disposition.sh"; do
  [ -f "$f" ] && [ ! -L "$f" ] || fail AUTHORITY_FILE_MISSING
  [ "$(sha256sum -- "$f" | cut -d' ' -f1)" = "$(ob_git -C "$REPO" show "$MAIN:$REL/$(basename "$f")" | sha256sum | cut -d' ' -f1)" ] || fail AUTHORITY_FILE_DIFFERS_FROM_MAIN
done
SELF=$HERE/ctv-incident-disposition.sh
SELF_SHA=$(sha256sum -- "$SELF" | cut -d' ' -f1)
VERIFIER_SHA=$(sha256sum -- "$VERIFIER" | cut -d' ' -f1)
GUARD_SHA=$(sha256sum -- "$GUARD" | cut -d' ' -f1)
# shellcheck source=/dev/null
. "$GUARD"
ob_guard_init
for f in "$VERIFIER" "$GUARD" "$SELF"; do ob_trusted_file "$f" || fail EXEC_PATH_NOT_TRUSTED; done
# Only now (after the guard) are test seams honoured.
[ -z "$PREIMAGE_OVERRIDE" ] || PIN_PREIMAGE_SHA256=$PREIMAGE_OVERRIDE
[[ "$PIN_PREIMAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail PIN_INVALID
pass_through=()
if [ "$HERMETIC" = YES ]; then
  pass_through+=(--hermetic --unit-dest "$UNIT_DEST" --core-env "$CORE_ENV" --preimage-sha256 "$PIN_PREIMAGE_SHA256")
  [ -z "$CLOCK_FIXTURE" ] || pass_through+=(--clock-fixture "$CLOCK_FIXTURE")
  [ -z "$PATH_PREFIX" ] || { pass_through+=(--path-prefix "$PATH_PREFIX"); PATH="$PATH_PREFIX:$PATH"; export PATH; }
else
  [ "$RECORD" = NO ] || [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED_FOR_RECORD
fi

run_verifier() { # PHASE [extra args]
  local phase=$1; shift
  "$VERIFIER" --repo "$REPO" --main "$MAIN" --canon "$CANON" --work "$WORK" --device "$DEVICE" --phase "$phase" "${pass_through[@]}" "$@"
}
vkey() { awk -F= -v k="$2" '$1 == k { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' <<<"$1"; }

if [ "$RECORD" = NO ]; then
  out=$(run_verifier pre) || fail VERIFIER_FAILED
  printf '%s\nCTV_INCIDENT_DISPOSITION=CHECK_ONLY_NOTHING_WRITTEN\n' "$out"
  exit 0
fi

# ── Exact Human Owner authorization: regular, non-symlink, not group/world writable, and EXACTLY these lines, evidence digests bound.
[ -f "$AUTH" ] && [ ! -L "$AUTH" ] || fail AUTHORIZATION_MISSING
[ -z "$(find "$AUTH" -maxdepth 0 -perm /022 -print)" ] || fail AUTHORIZATION_WRITABLE
[ "$(stat -c %u -- "$AUTH")" = "$GUARD_UID" ] || fail AUTHORIZATION_NOT_TRUSTED_OWNER
akey() { awk -F= -v k="$1" '$1 == k { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' "$AUTH"; }
auth_id=$(akey authorization_id) || fail AUTHORIZATION_NOT_EXACT
a_pre=$(akey pre_sha256sums_sha256) || fail AUTHORIZATION_NOT_EXACT
a_post=$(akey post_sha256sums_sha256) || fail AUTHORIZATION_NOT_EXACT
a_cmp=$(akey compare_output_sha256) || fail AUTHORIZATION_NOT_EXACT
[[ "$auth_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$ ]] || fail AUTHORIZATION_ID_INVALID
[[ "$a_pre" =~ ^[0-9a-f]{64}$ && "$a_post" =~ ^[0-9a-f]{64}$ && "$a_cmp" =~ ^[0-9a-f]{64}$ ]] || fail AUTHORIZATION_EVIDENCE_DIGEST_INVALID
want_auth=$(printf '%s\n' \
  "stage=CTv-incident-disposition" "disposition=$DISPOSITION" "expected_main=$MAIN" "unit_sha256=$PIN_UNIT_SHA256" \
  "preimage_sha256=$PIN_PREIMAGE_SHA256" "device_id=$DEVICE" "verifier_sha256=$VERIFIER_SHA" "action_sha256=$SELF_SHA" "guard_sha256=$GUARD_SHA" \
  "pre_sha256sums_sha256=$a_pre" "post_sha256sums_sha256=$a_post" "compare_output_sha256=$a_cmp" "authorization_id=$auth_id" | LC_ALL=C sort)
[ "$(LC_ALL=C sort -- "$AUTH")" = "$want_auth" ] || fail AUTHORIZATION_NOT_EXACT
evidence_args=(--bind-evidence --expect-pre-sums "$a_pre" --expect-post-sums "$a_post" --expect-compare "$a_cmp")

# ── Exclusive lock for the whole verify → commit window; fail fast, never wait.
command -v flock >/dev/null || fail FLOCK_MISSING
exec 9<"$CANON"
flock -n 9 || fail LOCK_HELD

closeout="$CANON/$FAIL_NAME"
sidecar="$closeout.sha256"

# closeout_body MAINPID STATE_SHA RECORDED_AT FROZEN_RUNNER PRE POST CMP — the one place the closeout text is defined.
closeout_body() {
  printf 'CTV_RESULT=FAIL_IMMUTABLE\nCTV_LIVE=CLOSED_FAIL\nCTV_LIVE_EXECUTED=YES\nCTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_IS_CTU_RETRY=NO\n'
  printf 'CTV_FAILURE_REASON=S10_COMPARE_FAIL_ROLLBACK_INCOMPLETE_TARGET_UNIT_RETAINED\n'
  printf 'CTV_INCIDENT_DISPOSITION=%s\nCTV_INCIDENT_AUTHORIZATION_ID=%s\n' "$DISPOSITION" "$auth_id"
  printf 'CTV_ROLLBACK_COMPLETE=NO\nCTV_TARGET_UNIT_RETAINED=YES\nCTV_ADDITIONAL_CORE_RESTART=NO\nCTV_ADDITIONAL_DETECTOR_COMMANDS=0\n'
  printf 'CTV_S10_HISTORICAL_COMPARE=FAIL\nCTV_S10_PROMOTED_TO_PASS=NO\nCTV_RECOVERY_AUTHORIZED=NO\nCTV_JOURNAL_PHASE=apply-verified\n'
  printf 'CTV_EXPECTED_MAIN=%s\nCTV_DISPOSITION_MAIN=%s\n' "$MAIN" "$MAIN"
  printf 'CTV_UNIT_SHA256=%s\nCTV_PREIMAGE_SHA256=%s\nCTV_DEVICE_ID=%s\nCTV_DETECTOR_BASELINE_MODE=INACTIVE\n' "$PIN_UNIT_SHA256" "$PIN_PREIMAGE_SHA256" "$DEVICE"
  printf 'CTV_TRUSTEDCLOCK_AT_DISPOSITION=SYNCED\nCTV_CORE_MAINPID_AT_DISPOSITION=%s\n' "$1"
  printf 'CTV_FROZEN_RUNNER_SHA256=%s\n' "$4"
  printf 'CTV_EVIDENCE_PRE_SHA256SUMS_SHA256=%s\nCTV_EVIDENCE_POST_SHA256SUMS_SHA256=%s\nCTV_COMPARE_OUTPUT_SHA256=%s\n' "$5" "$6" "$7"
  printf 'CTV_VERIFIER_SHA256=%s\nCTV_DISPOSITION_ACTION_SHA256=%s\nCTV_GUARD_SHA256=%s\nCTV_STATE_SHA256=%s\n' "$VERIFIER_SHA" "$SELF_SHA" "$GUARD_SHA" "$2"
  printf 'CTV_DISPOSITION_RECORDED_AT_UTC=%s\n' "$3"
}
ckey() { awk -F= -v k="$1" '$1 == k { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' "$closeout"; }
# write_sidecar — atomic and never an overwrite: temp file then `ln` (fails if the sidecar exists).
write_sidecar() {
  local stmp="$sidecar.tmp.$$"
  printf '%s  %s\n' "$(sha256sum -- "$closeout" | cut -d' ' -f1)" "$FAIL_NAME" > "$stmp"
  chmod 0444 "$stmp"; sync -- "$stmp"
  ln -- "$stmp" "$sidecar" || { rm -f -- "$stmp"; fail SIDECAR_ALREADY_EXISTS; }
  rm -f -- "$stmp"
  sync -- "$sidecar" "$CANON"
}

# ── Idempotency / crash recovery. An existing FAIL closeout is accepted ONLY if it is byte-for-byte what this action would have written
# under this authorization. If a crash left it without its sidecar, only the sidecar is created; the closeout is never rewritten.
if [ -e "$closeout" ] || [ -L "$closeout" ]; then
  [ -f "$closeout" ] && [ ! -L "$closeout" ] || fail CLOSEOUT_NOT_REGULAR
  grep -qx "CTV_INCIDENT_DISPOSITION=$DISPOSITION" "$closeout" && grep -qx "CTV_INCIDENT_AUTHORIZATION_ID=$auth_id" "$closeout" || fail DIFFERENT_FAIL_CLOSEOUT_PRESENT
  post=$(run_verifier post "${evidence_args[@]}") || fail POST_VERIFIER_FAILED
  [ "$(vkey "$post" CTV_OPTION_B_VERIFY)" = PASS ] || fail POST_VERIFIER_FAILED
  regenerated=$(closeout_body "$(ckey CTV_CORE_MAINPID_AT_DISPOSITION)" "$(ckey CTV_STATE_SHA256)" "$(ckey CTV_DISPOSITION_RECORDED_AT_UTC)" \
    "$(vkey "$post" CTV_OPTION_B_FROZEN_RUNNER_SHA256)" "$a_pre" "$a_post" "$a_cmp")
  [ "$regenerated" = "$(cat -- "$closeout")" ] || fail DIFFERENT_FAIL_CLOSEOUT_PRESENT
  if [ -e "$sidecar" ] || [ -L "$sidecar" ]; then
    [ -f "$sidecar" ] && [ ! -L "$sidecar" ] && [ "$(cat -- "$sidecar")" = "$(sha256sum -- "$closeout" | cut -d' ' -f1)  $FAIL_NAME" ] || fail CLOSEOUT_SHA256_MISMATCH
    printf 'CTV_INCIDENT_DISPOSITION=ALREADY_RECORDED\nCTV_INCIDENT_NOTHING_WRITTEN=YES\n'
  else
    write_sidecar
    printf 'CTV_INCIDENT_DISPOSITION=ALREADY_RECORDED_SIDECAR_COMPLETED\nCTV_INCIDENT_CLOSEOUT_UNCHANGED=YES\n'
  fi
  exit 0
fi
# A sidecar without a closeout can only mean tampering: never proceed.
[ ! -e "$sidecar" ] && [ ! -L "$sidecar" ] || fail ORPHAN_SIDECAR_PRESENT

# ── Fresh read-only proof, compose, REVALIDATE immediately before the commit, commit once, prove nothing moved.
before=$(run_verifier pre "${evidence_args[@]}") || fail VERIFIER_FAILED
[ "$(vkey "$before" CTV_OPTION_B_VERIFY)" = PASS ] || fail VERIFIER_NOT_PASS
state_before=$(vkey "$before" CTV_OPTION_B_STATE_SHA256)
tmp="$closeout.tmp.$$"
closeout_body "$(vkey "$before" CTV_OPTION_B_CORE_MAINPID)" "$state_before" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(vkey "$before" CTV_OPTION_B_FROZEN_RUNNER_SHA256)" "$a_pre" "$a_post" "$a_cmp" > "$tmp"
chmod 0600 "$tmp"; sync -- "$tmp"
[ "${CTV_OPTION_B_FAILPOINT:-}" != before-revalidation ] || [ "$HERMETIC" != YES ] || { rm -f -- "$tmp"; fail FAILPOINT_BEFORE_REVALIDATION; }
final=$(run_verifier pre "${evidence_args[@]}") || { rm -f -- "$tmp"; fail REVALIDATION_FAILED; }
if [ "$(vkey "$final" CTV_OPTION_B_VERIFY)" != PASS ] || [ "$(vkey "$final" CTV_OPTION_B_STATE_SHA256)" != "$state_before" ]; then
  rm -f -- "$tmp"; fail STATE_DRIFT_BEFORE_COMMIT
fi
# `ln` fails if the destination exists: append-only, never an overwrite, even against a racing writer outside the lock.
ln -- "$tmp" "$closeout" || { rm -f -- "$tmp"; fail CLOSEOUT_ALREADY_EXISTS; }
rm -f -- "$tmp"
if [ "${CTV_OPTION_B_FAILPOINT:-}" = after-closeout ] && [ "$HERMETIC" = YES ]; then fail FAILPOINT_AFTER_CLOSEOUT; fi
write_sidecar
after=$(run_verifier post "${evidence_args[@]}") || fail POST_VERIFIER_FAILED_AFTER_WRITE
[ "$(vkey "$after" CTV_OPTION_B_STATE_SHA256)" = "$state_before" ] || fail STATE_CHANGED_DURING_DISPOSITION_AFTER_WRITE
printf 'CTV_INCIDENT_DISPOSITION=RECORDED\nCTV_INCIDENT_CLOSEOUT_SHA256=%s\nCTV_INCIDENT_ADDITIONAL_RESTART=NO\n' "$(sha256sum -- "$closeout" | cut -d' ' -f1)"
