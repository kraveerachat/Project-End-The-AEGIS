#!/usr/bin/env bash
# CTv consumed-attempt incident disposition, Option B: governed action. PREPARED, NOT AUTHORIZED, NOT EXECUTED.
#
# Records exactly one append-only CTV-GLOBAL-CLOSEOUT-FAIL that truthfully states: the CTv attempt failed, the historical
# S10 comparison FAILED and stays a FAIL, rollback was INCOMPLETE, the target Core unit was RETAINED, no additional restart
# occurred, and no Recovery authority is granted (a CTv FAIL closeout makes the Recovery successor gate refuse).
#
# It touches nothing else: no systemctl verb other than `show` (inside the verifier), no unit/marker/journal/evidence change,
# no restart, no CTv/CTu/Recovery execution. It cannot run without (a) an exact Human Owner authorization file, (b) root,
# and (c) a fresh passing read-only verifier run under an exclusive lock.
#
# usage: ctv-incident-disposition.sh --repo R --main SHA40 --canon DIR --work DIR --device ID --authorization FILE [--record]
#        Without --record it only runs the read-only verifier (dry check) and writes nothing.
#        [--hermetic] enables the test-only seams of the verifier.
set -Eeuo pipefail
umask 077
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
pass_through=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;; --main) MAIN=${2:-}; shift 2 ;; --canon) CANON=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;; --device) DEVICE=${2:-}; shift 2 ;; --authorization) AUTH=${2:-}; shift 2 ;;
    --record) RECORD=YES; shift ;;
    --hermetic) HERMETIC=YES; pass_through+=(--hermetic); shift ;;
    --preimage-sha256) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; PIN_PREIMAGE_SHA256=${2:-}; pass_through+=("$1" "${2:-}"); shift 2 ;;
    --unit-dest|--core-env|--clock-fixture|--path-prefix) [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED; pass_through+=("$1" "${2:-}"); shift 2 ;;
    *) fail USAGE ;;
  esac
done
[[ "$MAIN" =~ ^[0-9a-f]{40}$ && "$DEVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail ARGUMENT_INVALID
for v in "$REPO" "$CANON" "$WORK" "$AUTH"; do [[ "$v" == /* && "$v" != *..* && "$v" != *//* ]] || fail PATH_INVALID; done
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
VERIFIER=$HERE/ctv-option-b-verify.sh
[ -f "$VERIFIER" ] && [ ! -L "$VERIFIER" ] || fail VERIFIER_MISSING
# Authority: this action and the verifier must be the exact blobs at MAIN (the verifier re-proves its own and the libraries').
ob_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
[ "$(ob_git -C "$REPO" rev-parse HEAD)" = "$MAIN" ] || fail REPO_HEAD_NOT_EXPECTED_MAIN
REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident
SELF_SHA=$(sha256sum -- "${BASH_SOURCE[0]}" | cut -d' ' -f1)
[ "$SELF_SHA" = "$(ob_git -C "$REPO" show "$MAIN:$REL/ctv-incident-disposition.sh" | sha256sum | cut -d' ' -f1)" ] || fail ACTION_DIFFERS_FROM_MAIN
VERIFIER_SHA=$(sha256sum -- "$VERIFIER" | cut -d' ' -f1)
# In production this action runs as root (no sudo indirection); the verifier inherits that.
if [ "$HERMETIC" != YES ]; then [ "$(id -u)" = 0 ] || [ "$RECORD" = NO ] || fail ROOT_REQUIRED_FOR_RECORD; fi

run_verifier() { "$VERIFIER" --repo "$REPO" --main "$MAIN" --canon "$CANON" --work "$WORK" --device "$DEVICE" --phase "$1" "${pass_through[@]}"; }
vkey() { awk -F= -v k="$2" '$1 == k { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' <<<"$1"; }

if [ "$RECORD" = NO ]; then
  out=$(run_verifier pre) || fail VERIFIER_FAILED
  printf '%s\nCTV_INCIDENT_DISPOSITION=CHECK_ONLY_NOTHING_WRITTEN\n' "$out"
  exit 0
fi

# ── Exact Human Owner authorization: regular, non-symlink, not group/world writable, and EXACTLY these lines.
[ -f "$AUTH" ] && [ ! -L "$AUTH" ] || fail AUTHORIZATION_MISSING
[ -z "$(find "$AUTH" -maxdepth 0 -perm /022 -print)" ] || fail AUTHORIZATION_WRITABLE
[ "$HERMETIC" = YES ] || [ "$(stat -c %u -- "$AUTH")" = 0 ] || fail AUTHORIZATION_NOT_ROOT_OWNED
auth_id=$(awk -F= '$1 == "authorization_id" { print $2 }' "$AUTH")
[[ "$auth_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$ ]] || fail AUTHORIZATION_ID_INVALID
want_auth=$(printf '%s\n' \
  "stage=CTv-incident-disposition" "disposition=$DISPOSITION" "expected_main=$MAIN" "unit_sha256=$PIN_UNIT_SHA256" \
  "preimage_sha256=$PIN_PREIMAGE_SHA256" "device_id=$DEVICE" "verifier_sha256=$VERIFIER_SHA" "action_sha256=$SELF_SHA" \
  "authorization_id=$auth_id" | LC_ALL=C sort)
[ "$(LC_ALL=C sort -- "$AUTH")" = "$want_auth" ] || fail AUTHORIZATION_NOT_EXACT

# ── Exclusive lock for the whole verify → write → re-verify window (race prevention); fail fast, never wait.
command -v flock >/dev/null || fail FLOCK_MISSING
exec 9<"$CANON"
flock -n 9 || fail LOCK_HELD

closeout="$CANON/$FAIL_NAME"
# ── Idempotency: an existing FAIL closeout is accepted ONLY if it is this exact disposition under this authorization.
if [ -e "$closeout" ] || [ -L "$closeout" ]; then
  [ -f "$closeout" ] && [ ! -L "$closeout" ] || fail CLOSEOUT_NOT_REGULAR
  grep -qx "CTV_INCIDENT_DISPOSITION=$DISPOSITION" "$closeout" && grep -qx "CTV_INCIDENT_AUTHORIZATION_ID=$auth_id" "$closeout" || fail DIFFERENT_FAIL_CLOSEOUT_PRESENT
  [ "$(cat -- "$closeout.sha256")" = "$(sha256sum -- "$closeout" | cut -d' ' -f1)  $FAIL_NAME" ] || fail CLOSEOUT_SHA256_MISMATCH
  run_verifier post >/dev/null || fail POST_VERIFIER_FAILED
  printf 'CTV_INCIDENT_DISPOSITION=ALREADY_RECORDED\nCTV_INCIDENT_NOTHING_WRITTEN=YES\n'
  exit 0
fi

# ── Fresh read-only proof, then write once, then prove nothing moved.
before=$(run_verifier pre) || fail VERIFIER_FAILED
[ "$(vkey "$before" CTV_OPTION_B_VERIFY)" = PASS ] || fail VERIFIER_NOT_PASS
state_before=$(vkey "$before" CTV_OPTION_B_STATE_SHA256)
tmp="$closeout.tmp.$$"
{
  printf 'CTV_RESULT=FAIL_IMMUTABLE\nCTV_LIVE=CLOSED_FAIL\nCTV_LIVE_EXECUTED=YES\nCTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_IS_CTU_RETRY=NO\n'
  printf 'CTV_FAILURE_REASON=S10_COMPARE_FAIL_ROLLBACK_INCOMPLETE_TARGET_UNIT_RETAINED\n'
  printf 'CTV_INCIDENT_DISPOSITION=%s\nCTV_INCIDENT_AUTHORIZATION_ID=%s\n' "$DISPOSITION" "$auth_id"
  printf 'CTV_ROLLBACK_COMPLETE=NO\nCTV_TARGET_UNIT_RETAINED=YES\nCTV_ADDITIONAL_CORE_RESTART=NO\nCTV_ADDITIONAL_DETECTOR_COMMANDS=0\n'
  printf 'CTV_S10_HISTORICAL_COMPARE=FAIL\nCTV_S10_PROMOTED_TO_PASS=NO\nCTV_RECOVERY_AUTHORIZED=NO\nCTV_JOURNAL_PHASE=apply-verified\n'
  printf 'CTV_EXPECTED_MAIN=%s\nCTV_DISPOSITION_MAIN=%s\n' "$MAIN" "$MAIN"
  printf 'CTV_UNIT_SHA256=%s\nCTV_PREIMAGE_SHA256=%s\nCTV_DEVICE_ID=%s\nCTV_DETECTOR_BASELINE_MODE=INACTIVE\n' "$PIN_UNIT_SHA256" "$PIN_PREIMAGE_SHA256" "$DEVICE"
  printf 'CTV_TRUSTEDCLOCK_AT_DISPOSITION=SYNCED\nCTV_CORE_MAINPID_AT_DISPOSITION=%s\n' "$(vkey "$before" CTV_OPTION_B_CORE_MAINPID)"
  printf 'CTV_FROZEN_RUNNER_SHA256=%s\n' "$(vkey "$before" CTV_OPTION_B_FROZEN_RUNNER_SHA256)"
  printf 'CTV_EVIDENCE_PRE_SHA256SUMS_SHA256=%s\nCTV_EVIDENCE_POST_SHA256SUMS_SHA256=%s\nCTV_COMPARE_OUTPUT_SHA256=%s\n' \
    "$(vkey "$before" CTV_OPTION_B_PRE_SHA256SUMS_SHA256)" "$(vkey "$before" CTV_OPTION_B_POST_SHA256SUMS_SHA256)" "$(vkey "$before" CTV_OPTION_B_COMPARE_OUTPUT_SHA256)"
  printf 'CTV_VERIFIER_SHA256=%s\nCTV_DISPOSITION_ACTION_SHA256=%s\nCTV_STATE_SHA256=%s\n' "$VERIFIER_SHA" "$SELF_SHA" "$state_before"
  printf 'CTV_DISPOSITION_RECORDED_AT_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$tmp"
chmod 0600 "$tmp"; sync -- "$tmp"
# `ln` fails if the destination exists: append-only, never an overwrite, even against a racing writer outside the lock.
ln -- "$tmp" "$closeout" || { rm -f -- "$tmp"; fail CLOSEOUT_ALREADY_EXISTS; }
rm -f -- "$tmp"
printf '%s  %s\n' "$(sha256sum -- "$closeout" | cut -d' ' -f1)" "$FAIL_NAME" > "$closeout.sha256"
chmod 0444 "$closeout.sha256"; sync -- "$closeout" "$closeout.sha256" "$CANON"
after=$(run_verifier post) || fail POST_VERIFIER_FAILED_AFTER_WRITE
[ "$(vkey "$after" CTV_OPTION_B_STATE_SHA256)" = "$state_before" ] || fail STATE_CHANGED_DURING_DISPOSITION_AFTER_WRITE
printf 'CTV_INCIDENT_DISPOSITION=RECORDED\nCTV_INCIDENT_CLOSEOUT_SHA256=%s\nCTV_INCIDENT_ADDITIONAL_RESTART=NO\n' "$(sha256sum -- "$closeout" | cut -d' ' -f1)"
